'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
  smartListId?: string;
  smartListName?: string;
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId } = useAuth();
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'smart_list' && audience.smartListId) {
          const { data, error } = await supabase.rpc('count_smart_list_contacts', {
            p_smart_list_id: audience.smartListId,
          });
          if (!cancelled) setEstimatedReach(error ? 0 : Number(data ?? 0));
          return;
        }

        if (audience.type === 'csv' && audience.csvContacts) {
          if (!cancelled) setEstimatedReach(audience.csvContacts.length);
          return;
        }

        if (!accountId) {
          if (!cancelled) setEstimatedReach(0);
          return;
        }

        let baseIds: Set<string> | null = null;
        let allContactsCount: number | null = null;

        if (audience.type === 'all') {
          const { count, error } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true })
            .eq('account_id', accountId);
          if (error) throw error;
          allContactsCount = count ?? 0;
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          const { data, error } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);
          if (error) throw error;
          baseIds = new Set((data ?? []).map((row) => row.contact_id));
        } else if (
          audience.type === 'custom_field' &&
          audience.customField?.fieldId &&
          audience.customField.value
        ) {
          const { fieldId, operator, value } = audience.customField;
          let query = supabase
            .from('contact_custom_values')
            .select('contact_id')
            .eq('custom_field_id', fieldId);

          if (operator === 'is') query = query.eq('value', value);
          else if (operator === 'is_not') query = query.neq('value', value);
          else query = query.ilike('value', `%${value}%`);

          const { data, error } = await query;
          if (error) throw error;
          baseIds = new Set((data ?? []).map((row) => row.contact_id));
        } else {
          if (!cancelled) setEstimatedReach(0);
          return;
        }

        let excludedIds = new Set<string>();
        if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
          const { data, error } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.excludeTagIds);
          if (error) throw error;
          excludedIds = new Set((data ?? []).map((row) => row.contact_id));
        }

        const reach =
          baseIds === null
            ? Math.max(0, (allContactsCount ?? 0) - excludedIds.size)
            : [...baseIds].filter((id) => !excludedIds.has(id)).length;

        if (!cancelled) setEstimatedReach(reach);
      } catch (error) {
        console.error('Failed to calculate broadcast reach:', error);
        if (!cancelled) setEstimatedReach(0);
      } finally {
        if (!cancelled) setLoadingReach(false);
      }
    }

    calculateReach();
    return () => {
      cancelled = true;
    };
  }, [audience, accountId]);

  const audienceLabel =
    audience.type === 'smart_list'
      ? `Smart List${audience.smartListName ? ` · ${audience.smartListName}` : ''}`
      : audience.type === 'all'
        ? t('scheduleSend.audienceAll')
        : audience.type === 'tags'
          ? t('scheduleSend.audienceTags')
          : audience.type === 'csv'
            ? t('scheduleSend.audienceCsv')
            : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('scheduleSend.subtitle')}</p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="break-all text-foreground">{template.name}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="break-words text-foreground">{audienceLabel}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="break-words text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing || estimatedReach === 0}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">Confirm Broadcast</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  You are about to send this broadcast to{' '}
                  <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                  contacts using the{' '}
                  <span className="break-all font-medium text-popover-foreground">{template.name}</span> template.
                  This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  {t('scheduleSend.sendNow')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
