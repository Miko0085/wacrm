'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import {
  Step2SelectAudienceWithSmartLists,
  type SmartAudienceConfig,
} from '@/components/broadcasts/step2-select-audience-with-smart-lists';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSendingWithSmartLists } from '@/hooks/use-broadcast-sending-with-smart-lists';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

const CONTACT_BROADCAST_SELECTION_KEY = 'wacrm:broadcast-contact-selection';

type VariableMap = Record<
  string,
  { type: 'static' | 'field' | 'custom_field'; value: string }
>;

type StoredAudience = {
  type?: SmartAudienceConfig['type'];
  tagIds?: string[];
  customField?: SmartAudienceConfig['customField'];
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
  smartListId?: string;
  smartListName?: string;
};

export default function NewBroadcastPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftId = searchParams.get('draft');
  const source = searchParams.get('source');
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const {
    createAndSendBroadcast,
    createScheduledBroadcast,
    isProcessing,
    progress,
  } = useBroadcastSendingWithSmartLists();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<SmartAudienceConfig>(() => {
    if (draftId || source !== 'contacts' || typeof window === 'undefined') {
      return { type: 'all' };
    }

    try {
      const raw = window.sessionStorage.getItem(CONTACT_BROADCAST_SELECTION_KEY);
      if (!raw) return { type: 'all' };
      const rows = JSON.parse(raw) as { phone?: string; name?: string }[];
      const contacts = Array.isArray(rows)
        ? rows
            .filter((row) => typeof row?.phone === 'string' && row.phone.trim().length > 0)
            .map((row) => ({ phone: row.phone!.trim(), name: row.name || undefined }))
        : [];

      return contacts.length > 0
        ? { type: 'csv', csvContacts: contacts }
        : { type: 'all' };
    } catch (error) {
      console.error('Failed to restore selected contacts for broadcast:', error);
      return { type: 'all' };
    }
  });
  const [variables, setVariables] = useState<VariableMap>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  const [draftLoadPending, setDraftLoadPending] = useState(true);
  const loadingDraft = Boolean(draftId && accountId && draftLoadPending);

  useEffect(() => {
    if (!draftId || !accountId) return;

    let cancelled = false;

    async function loadDraft() {
      const supabase = createClient();
      const { data: draft, error } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', draftId)
        .eq('account_id', accountId)
        .eq('status', 'draft')
        .single();

      if (cancelled) return;
      if (error || !draft) {
        toast.error('Draft not found or is no longer editable.');
        router.replace('/broadcasts');
        return;
      }

      const { data: templates, error: templateError } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', draft.template_name)
        .eq('language', draft.template_language ?? 'en_US')
        .limit(1);

      if (cancelled) return;
      if (templateError || !templates?.[0]) {
        toast.error('The template used by this draft is no longer available.');
        setDraftLoadPending(false);
        return;
      }

      const stored = (draft.audience_filter ?? {}) as StoredAudience;
      const restoredAudience: SmartAudienceConfig =
        stored.type === 'smart_list'
          ? {
              type: 'smart_list',
              smartListId: stored.smartListId,
              smartListName: stored.smartListName,
            }
          : {
              type: stored.type ?? 'all',
              tagIds: stored.tagIds,
              customField: stored.customField,
              csvContacts: stored.csvContacts,
              excludeTagIds: stored.excludeTagIds,
            };

      setName(draft.name ?? '');
      setTemplate(templates[0] as MessageTemplate);
      setVariables((draft.template_variables ?? {}) as VariableMap);
      setAudience(restoredAudience);
      setCurrentStep(3);
      setDraftLoadPending(false);
    }

    loadDraft();
    return () => {
      cancelled = true;
    };
  }, [draftId, accountId, router]);

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience:
          audience.type === 'smart_list'
            ? {
                type: 'smart_list',
                smartListId: audience.smartListId!,
                smartListName: audience.smartListName,
              }
            : {
                type: audience.type,
                tagIds: audience.tagIds,
                customField: audience.customField,
                csvContacts: audience.csvContacts,
                excludeTagIds: audience.excludeTagIds,
              },
        variables,
        headerMediaUrl,
      });

      if (draftId && accountId) {
        const supabase = createClient();
        await supabase
          .from('broadcasts')
          .delete()
          .eq('id', draftId)
          .eq('account_id', accountId)
          .eq('status', 'draft');
      }

      if (source === 'contacts') {
        window.sessionStorage.removeItem(CONTACT_BROADCAST_SELECTION_KEY);
      }
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  async function handleSchedule(scheduledAt: string) {
    if (!template) return;

    try {
      const broadcastId = await createScheduledBroadcast(
        {
          name,
          template,
          audience:
            audience.type === 'smart_list'
              ? {
                  type: 'smart_list',
                  smartListId: audience.smartListId!,
                  smartListName: audience.smartListName,
                }
              : {
                  type: audience.type,
                  tagIds: audience.tagIds,
                  customField: audience.customField,
                  csvContacts: audience.csvContacts,
                  excludeTagIds: audience.excludeTagIds,
                },
          variables,
          headerMediaUrl,
        },
        scheduledAt,
      );

      if (draftId && accountId) {
        const supabase = createClient();
        await supabase
          .from('broadcasts')
          .delete()
          .eq('id', draftId)
          .eq('account_id', accountId)
          .eq('status', 'draft');
      }

      if (source === 'contacts') {
        window.sessionStorage.removeItem(CONTACT_BROADCAST_SELECTION_KEY);
      }

      toast.success(
        `Broadcast scheduled for ${new Date(scheduledAt).toLocaleString()}`,
      );
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to schedule broadcast';
      console.error('Broadcast scheduling failed:', err);
      toast.error(message);
    }
  }

  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const audienceFilter =
      audience.type === 'smart_list'
        ? {
            type: 'smart_list',
            smartListId: audience.smartListId,
            smartListName: audience.smartListName,
          }
        : {
            type: audience.type,
            tagIds: audience.tagIds,
            customField: audience.customField,
            csvContacts: audience.csvContacts,
            excludeTagIds: audience.excludeTagIds,
          };

    const payload = {
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: audienceFilter,
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    };

    const operation = draftId
      ? supabase
          .from('broadcasts')
          .update(payload)
          .eq('id', draftId)
          .eq('account_id', accountId)
          .eq('status', 'draft')
      : supabase.from('broadcasts').insert({
          user_id: user.id,
          account_id: accountId,
          ...payload,
        });

    const { error } = await operation;
    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    if (source === 'contacts') {
      window.sessionStorage.removeItem(CONTACT_BROADCAST_SELECTION_KEY);
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  if (loadingDraft) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {draftId ? 'Continue draft' : t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {draftId ? 'Review the saved broadcast and send it when ready.' : t('subtitle')}
        </p>
      </div>

      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudienceWithSmartLists
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSchedule={handleSchedule}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}