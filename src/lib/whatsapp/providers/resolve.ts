/**
 * Single entry point every call site uses to get a working WhatsApp
 * sender/reader for an account — this is what makes Meta vs Gupshup
 * invisible to send-message.ts, broadcast-core.ts, the automations and
 * flows engines, the public API, and MCP. None of them import
 * `meta-api.ts` or the Gupshup client directly, or branch on
 * `config.provider` themselves — they call this function and use the
 * `WhatsAppProvider` it returns.
 */

import { decrypt } from '@/lib/whatsapp/encryption'
import type { WhatsAppConfig } from '@/types'
import { createMetaProvider } from './meta-provider'
import { createGupshupProvider } from './gupshup-provider'
import { ProviderError, type WhatsAppProvider } from './types'

/**
 * `config` is a row from `whatsapp_config` with encrypted credential
 * columns still encrypted — this function decrypts exactly the columns
 * the row's provider needs and hands back a ready-to-use provider.
 * Throws `ProviderError` (code `not_supported`) if the row is missing
 * the credentials its own `provider` column claims to have — a
 * defensive check; the DB CHECK constraint added in migration 040
 * should make this state unreachable.
 */
export function resolveWhatsAppProvider(config: WhatsAppConfig): WhatsAppProvider {
  const provider = config.provider ?? 'meta'

  if (provider === 'gupshup') {
    if (!config.gupshup_api_key || !config.gupshup_source_phone_number) {
      throw new ProviderError(
        'gupshup',
        'not_supported',
        'WhatsApp is set to Gupshup for this account, but Gupshup credentials are missing. Reconnect in Settings → WhatsApp.',
      )
    }
    return createGupshupProvider({
      apiKey: decrypt(config.gupshup_api_key),
      appId: config.gupshup_app_id ?? '',
      appName: config.gupshup_app_name ?? '',
      sourceNumber: config.gupshup_source_phone_number,
    })
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new ProviderError(
      'meta',
      'not_supported',
      'WhatsApp is set to Meta Cloud API for this account, but Meta credentials are missing. Reconnect in Settings → WhatsApp.',
    )
  }
  return createMetaProvider({
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
  })
}

export { ProviderError } from './types'
export type {
  WhatsAppProvider,
  WhatsAppProviderId,
  SendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveArgs,
  InteractivePayload,
  ConnectionStatus,
  NormalizedTemplate,
  ProviderErrorCode,
} from './types'
