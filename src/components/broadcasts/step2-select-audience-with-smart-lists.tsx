'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, ListFilter, Loader2, Plus, Users } from 'lucide-react';

export interface SmartAudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv' | 'smart_list';
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

interface SmartListRow {
  id: string;
  name: string;
  description: string | null;
  match_mode: 'all' | 'any';
  include_tag_ids: string[];
  exclude_tag_ids: string[];
  list_type?: 'dynamic' | 'static';
}

export function Step2SelectAudienceWithSmartLists({
  audience,
  onUpdate,
  onNext,
  onBack,
}: {
  audience: SmartAudienceConfig;
  onUpdate: (audience: SmartAudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { accountId } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [lists, setLists] = useState<SmartListRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    async function loadLists() {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('smart_lists')
          .select('id,name,description,match_mode,include_tag_ids,exclude_tag_ids,list_type')
          .eq('account_id', accountId!)
          .order('updated_at', { ascending: false });
        if (cancelled) return;
        const rows = (data ?? []) as SmartListRow[];
        setLists(rows);

        const entries = await Promise.all(
          rows.map(async (row) => {
            const { data: count } = await supabase.rpc('count_smart_list_contacts', {
              p_smart_list_id: row.id,
            });
            return [row.id, Number(count ?? 0)] as const;
          }),
        );
        if (!cancelled) setCounts(Object.fromEntries(entries));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadLists();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  if (audience.type !== 'smart_list') {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => onUpdate({ type: 'smart_list' })}
          className="flex w-full items-start gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4 text-left transition-colors hover:bg-primary/10"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListFilter className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Smart List</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Use a saved dynamic audience or a static contact snapshot.
            </p>
          </div>
        </button>

        <Step2SelectAudience
          audience={audience as never}
          onUpdate={(next) => onUpdate(next as SmartAudienceConfig)}
          onNext={onNext}
          onBack={onBack}
        />
      </div>
    );
  }

  const selected = lists.find((list) => list.id === audience.smartListId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Select Smart List</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Dynamic lists resolve from current rules at send time; static lists use their saved contact snapshot.
        </p>
      </div>

      {loading ? (
        <div className="flex min-h-36 items-center justify-center rounded-xl border border-border bg-card/50">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : lists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-6 text-center">
          <ListFilter className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No Smart Lists yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Create one in Contacts → Smart Lists first.</p>
          <Button variant="outline" className="mt-4" render={<Link href="/contacts/segments" />}>
            <Plus className="h-4 w-4" />
            Create Smart List
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {lists.map((list) => {
            const isSelected = audience.smartListId === list.id;
            const isStatic = (list.list_type ?? 'dynamic') === 'static';
            return (
              <button
                type="button"
                key={list.id}
                onClick={() =>
                  onUpdate({
                    type: 'smart_list',
                    smartListId: list.id,
                    smartListName: list.name,
                  })
                }
                className={`rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-primary/40'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{list.name}</p>
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        {isStatic ? 'Static' : 'Dynamic'}
                      </span>
                    </div>
                    {list.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{list.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {(counts[list.id] ?? 0).toLocaleString()}
                  </div>
                </div>
                <p className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {isStatic
                    ? 'Saved contact snapshot'
                    : `${list.match_mode === 'all' ? 'ALL' : 'ANY'} tags · ${list.include_tag_ids.length} include · ${list.exclude_tag_ids.length} exclude`}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
          <span className="font-medium">{selected.name}</span>
          <span className="ml-2 text-muted-foreground">
            · {(counts[selected.id] ?? 0).toLocaleString()} contacts · {(selected.list_type ?? 'dynamic') === 'static' ? 'static snapshot' : 'dynamic'}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={() => onUpdate({ type: 'all' })}>
          <ArrowLeft className="h-4 w-4" />
          Other audience methods
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button onClick={onNext} disabled={!audience.smartListId || (counts[audience.smartListId] ?? 0) === 0}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
