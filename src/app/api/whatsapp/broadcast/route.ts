import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { resolveWhatsAppProvider } from '@/lib/whatsapp/providers/resolve'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const provider = resolveWhatsAppProvider(config)

    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = resolvedTemplate.row

    const sanitizedPhones = recipients
      .map((recipient) => sanitizePhoneForMeta(recipient.phone))
      .filter(Boolean)

    const { data: suppressedContacts } = await supabase
      .from('contacts')
      .select('phone_normalized')
      .eq('account_id', accountId)
      .eq('wa_marketing_status', 'OPTED_OUT')
      .in('phone_normalized', sanitizedPhones)
    const suppressedPhones = new Set(
      (suppressedContacts ?? []).map(
        (contact: { phone_normalized: string }) => contact.phone_normalized,
      ),
    )

    // Broadcast recipients already exist as WACRM contacts when the wizard
    // calls this route (CSV rows are upserted before send). Load them once so
    // successful template sends can be mirrored into Inbox without an N+1
    // contact lookup. This is intentionally account-scoped.
    const { data: contactRows, error: contactLookupError } = await supabase
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .in('phone_normalized', sanitizedPhones)

    if (contactLookupError) {
      console.error(
        '[broadcast] failed to preload contacts for Inbox persistence:',
        contactLookupError.message,
      )
    }

    const contactsByPhone = new Map<string, string>()
    for (const contact of contactRows ?? []) {
      if (contact.phone_normalized) {
        contactsByPhone.set(contact.phone_normalized, contact.id)
      }
    }

    const contactIds = [...new Set((contactRows ?? []).map((contact) => contact.id))]
    const conversationByContact = new Map<string, string>()
    if (contactIds.length > 0) {
      const { data: existingConversations, error: conversationLookupError } =
        await supabase
          .from('conversations')
          .select('id, contact_id')
          .eq('account_id', accountId)
          .in('contact_id', contactIds)

      if (conversationLookupError) {
        console.error(
          '[broadcast] failed to preload conversations:',
          conversationLookupError.message,
        )
      } else {
        for (const conversation of existingConversations ?? []) {
          conversationByContact.set(conversation.contact_id, conversation.id)
        }
      }
    }

    async function persistSentTemplate(
      recipient: NewRecipient,
      sanitizedPhone: string,
      whatsappMessageId: string,
    ) {
      try {
        const contactId = contactsByPhone.get(sanitizedPhone)
        if (!contactId) {
          console.warn(
            `[broadcast] sent ${whatsappMessageId} but no WACRM contact matched ${sanitizedPhone}; Inbox row skipped`,
          )
          return
        }

        let conversationId = conversationByContact.get(contactId)
        if (!conversationId) {
          const { data: existing } = await supabase
            .from('conversations')
            .select('id')
            .eq('account_id', accountId)
            .eq('contact_id', contactId)
            .maybeSingle()

          if (existing?.id) {
            conversationId = existing.id
          } else {
            const { data: created, error: createError } = await supabase
              .from('conversations')
              .insert({
                account_id: accountId,
                user_id: userId,
                contact_id: contactId,
              })
              .select('id')
              .single()

            if (createError || !created) {
              console.error(
                `[broadcast] sent ${whatsappMessageId} but failed to create Inbox conversation:`,
                createError?.message ?? 'unknown error',
              )
              return
            }
            conversationId = created.id
          }
        }

        if (!conversationId) {
          console.error(
            `[broadcast] sent ${whatsappMessageId} but Inbox conversation id could not be resolved`,
          )
          return
        }
        conversationByContact.set(contactId, conversationId)

        const persistedText = templateContentText(
          templateRow,
          templateBodyParams(recipient.params, recipient.messageParams),
          null,
        )
        const now = new Date().toISOString()

        // message_id is Meta/Gupshup's wamid and is unique enough for status
        // callbacks to update the same Inbox row later. Avoid a duplicate row
        // if a caller retries persistence after an ambiguous HTTP response.
        const { data: existingMessage } = await supabase
          .from('messages')
          .select('id')
          .eq('message_id', whatsappMessageId)
          .maybeSingle()

        if (!existingMessage) {
          const { error: messageError } = await supabase
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_type: 'agent',
              content_type: 'template',
              content_text: persistedText,
              template_name,
              message_id: whatsappMessageId,
              status: 'sent',
            })

          if (messageError) {
            console.error(
              `[broadcast] sent ${whatsappMessageId} but failed to persist Inbox message:`,
              messageError.message,
            )
            return
          }
        }

        const { error: conversationUpdateError } = await supabase
          .from('conversations')
          .update({
            last_message_text: persistedText || `[Template: ${template_name}]`,
            last_message_at: now,
            updated_at: now,
          })
          .eq('id', conversationId)
          .eq('account_id', accountId)

        if (conversationUpdateError) {
          console.error(
            `[broadcast] failed to update Inbox conversation preview for ${whatsappMessageId}:`,
            conversationUpdateError.message,
          )
        }
      } catch (error) {
        // Never classify a WhatsApp send as failed after Meta/Gupshup already
        // accepted it. A persistence problem is logged for repair; returning a
        // send failure here would cause callers to retry and potentially send
        // the customer the same template twice.
        console.error(
          `[broadcast] sent ${whatsappMessageId} but Inbox persistence threw:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      if (suppressedPhones.has(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Contact has opted out of WhatsApp marketing messages',
        })
        failedCount++
        continue
      }

      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          const result = await provider.sendTemplate({
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
        }
      }

      if (sentMessageId) {
        await persistSentTemplate(recipient, sanitized, sentMessageId)
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError,
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
