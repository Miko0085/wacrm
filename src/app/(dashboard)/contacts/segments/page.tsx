'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { toast } from 'sonner';
import type { Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  ListFilter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';

type MatchMode = 'all' | 'any';

type SmartListType = 'dynamic' | 'static';

interface SmartList {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  match_mode: MatchMode;
  include_tag_ids: string[];
  exclude_tag_ids: string[];
  list_type?: SmartListType;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface SmartListDraft {
  name: string;
  description: string;
  matchMode: MatchMode;
  includeTagIds: string[];
  excludeTagIds: string[];
}

const EMPTY_DRAFT: SmartListDraft = {
  name: '',
  description: '',
  matchMode: 'all',
  includeTagIds: [],
  excludeTagIds: [],
};

export default function SmartListsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { accountId } = useAuth();
  const canEdit = useCan('send-messages');
  const [lists, setLists] = useState<SmartList[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshingCounts, setRefreshingCounts] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SmartList | null>(null);
  const [draft, setDraft] = useState<SmartListDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SmartList | null>(null);
  const [deleting, setDeleting] = useState(false);

  const tagsById = useMemo(
    () => Object.fromEntries(tags.map((tag) => [tag.id, tag])),
    [tags],
  );

  const loadCounts = useCallback(async (items: SmartList[]) => {
    if (items.length === 0) {
      setCounts({});
      return;
    }
    setRefreshingCounts(true);
    try {
      const entries = await Promise.all(
        items.map(async (list) => {
          const { data, error } = await supabase.rpc('count_smart_list_contacts', {
            p_smart_list_id: list.id,
          });
          return [list.id, error ? 0 : Number(data ?? 0)] as const;
        }),
      );
      setCounts(Object.fromEntries(entries));
    } finally {
      setRefreshingCounts(false);
    }
  }, [supabase]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [{ data: listRows, error: listError }, { data: tagRows, error: tagError }] =
        await Promise.all([
          supabase
            .from('smart_lists')
            .select('*')
            .eq('account_id', accountId)
            .order('updated_at', { ascending: false }),
          supabase
            .from('tags')
            .select('*')
            .eq('account_id', accountId)
            .order('name'),
        ]);

      if (listError) throw listError;
      if (tagError) throw tagError;
      const nextLists = (listRows ?? []) as SmartList[];
      setLists(nextLists);
      setTags((tagRows ?? []) as Tag[]);
      await loadCounts(nextLists);
    } catch (error) {
      console.error(error);
      toast.error('Failed to load Smart Lists');
    } finally {
      setLoading(false);
    }
  }, [accountId, loadCounts, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setEditorOpen(true);
  }

  function openEdit(list: SmartList) {
    if ((list.list_type ?? 'dynamic') === 'static') return;
    setEditing(list);
    setDraft({
      name: list.name,
      description: list.description ?? '',
      matchMode: list.match_mode,
      includeTagIds: list.include_tag_ids ?? [],
      excludeTagIds: list.exclude_tag_ids ?? [],
    });
    setEditorOpen(true);
  }

  function toggleInclude(tagId: string) {
    setDraft((current) => ({
      ...current,
      includeTagIds: current.includeTagIds.includes(tagId)
        ? current.includeTagIds.filter((id) => id !== tagId)
        : [...current.includeTagIds, tagId],
      excludeTagIds: current.excludeTagIds.filter((id) => id !== tagId),
    }));
  }

  function toggleExclude(tagId: string) {
    setDraft((current) => ({
      ...current,
      excludeTagIds: current.excludeTagIds.includes(tagId)
        ? current.excludeTagIds.filter((id) => id !== tagId)
        : [...current.excludeTagIds, tagId],
      includeTagIds: current.includeTagIds.filter((id) => id !== tagId),
    }));
  }

  async function save() {
    if (!accountId || !draft.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        account_id: accountId,
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        match_mode: draft.matchMode,
        include_tag_ids: draft.includeTagIds,
        exclude_tag_ids: draft.excludeTagIds,
        list_type: 'dynamic' as const,
      };

      if (editing) {
        const { error } = await supabase
          .from('smart_lists')
          .update(payload)
          .eq('id', editing.id)
          .eq('account_id', accountId)
          .eq('list_type', 'dynamic');
        if (error) throw error;
        toast.success('Smart List updated');
      } else {
        const { data: auth } = await supabase.auth.getUser();
        const { error } = await supabase.from('smart_lists').insert({
          ...payload,
          created_by: auth.user?.id ?? null,
        });
        if (error) throw error;
        toast.success('Smart List created');
      }

      setEditorOpen(false);
      await load();
    } catch (error) {
      console.error(error);
      toast.error('Failed to save Smart List');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteTarget || !accountId) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from('smart_lists')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('account_id', accountId);
      if (error) throw error;
      toast.success('Smart List deleted');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      console.error(error);
      toast.error('Failed to delete Smart List');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link href="/contacts" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" />
            </Link>
            <span className="text-sm text-muted-foreground">Contacts</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Smart Lists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dynamic audiences from live rules and static snapshots saved from selected contacts.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={refreshingCounts || loading}
            onClick={() => loadCounts(lists)}
          >
            {refreshingCounts ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh counts
          </Button>
          <Button onClick={openCreate} disabled={!canEdit}>
            <Plus className="size-4" />
            New Dynamic List
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-card">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : lists.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <ListFilter className="mb-3 size-9 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">No Smart Lists yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Create a dynamic tag rule here, or select contacts on the Contacts page and save them as a static Smart List.
          </p>
          <Button className="mt-4" onClick={openCreate} disabled={!canEdit}>
            <Plus className="size-4" />
            Create Dynamic List
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {lists.map((list) => {
            const isStatic = (list.list_type ?? 'dynamic') === 'static';
            return (
              <div key={list.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-semibold text-foreground">{list.name}</h2>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {isStatic ? 'Static' : 'Dynamic'}
                      </span>
                    </div>
                    {list.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{list.description}</p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      {!isStatic && (
                        <Button variant="ghost" size="icon" onClick={() => openEdit(list)} aria-label="Edit Smart List">
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(list)} aria-label="Delete Smart List">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center gap-2 text-sm text-foreground">
                  <Users className="size-4 text-muted-foreground" />
                  <span className="font-medium">{counts[list.id]?.toLocaleString() ?? '—'}</span>
                  <span className="text-muted-foreground">{isStatic ? 'contacts in snapshot' : 'contacts now'}</span>
                </div>

                <div className="mt-4 space-y-2 text-xs">
                  {isStatic ? (
                    <p className="text-muted-foreground">
                      Fixed membership captured from a Contacts selection. It can be reused as a broadcast audience.
                    </p>
                  ) : (
                    <>
                      <div className="text-muted-foreground">
                        Match <span className="font-medium uppercase text-foreground">{list.match_mode}</span> selected tags
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(list.include_tag_ids ?? []).map((id) => (
                          <span key={id} className="rounded-full border border-border bg-muted px-2 py-1 text-foreground">
                            + {tagsById[id]?.name ?? 'Deleted tag'}
                          </span>
                        ))}
                        {(list.exclude_tag_ids ?? []).map((id) => (
                          <span key={id} className="rounded-full border border-border bg-background px-2 py-1 text-muted-foreground">
                            − {tagsById[id]?.name ?? 'Deleted tag'}
                          </span>
                        ))}
                        {list.include_tag_ids.length === 0 && list.exclude_tag_ids.length === 0 && (
                          <span className="text-muted-foreground">All contacts</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Dynamic Smart List' : 'New Dynamic Smart List'}</DialogTitle>
            <DialogDescription>
              Membership is recalculated from current tags whenever the list is used.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Name</label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
                placeholder="Dubai Reactivation — High Priority"
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Description</label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
                placeholder="Optional note for the team"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Include rule</label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={draft.matchMode === 'all' ? 'default' : 'outline'}
                  onClick={() => setDraft((current) => ({ ...current, matchMode: 'all' }))}
                >
                  ALL selected tags
                </Button>
                <Button
                  type="button"
                  variant={draft.matchMode === 'any' ? 'default' : 'outline'}
                  onClick={() => setDraft((current) => ({ ...current, matchMode: 'any' }))}
                >
                  ANY selected tag
                </Button>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <TagChooser
                title="Include tags"
                description={draft.matchMode === 'all' ? 'Contact must have every selected tag.' : 'Contact can have any selected tag.'}
                tags={tags}
                selected={draft.includeTagIds}
                onToggle={toggleInclude}
              />
              <TagChooser
                title="Exclude tags"
                description="A contact with any selected tag is always removed."
                tags={tags}
                selected={draft.excludeTagIds}
                onToggle={toggleExclude}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !draft.name.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save Smart List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Smart List?</DialogTitle>
            <DialogDescription>
              Contacts and tags will not be deleted. Only this saved Smart List is removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TagChooser({
  title,
  description,
  tags,
  selected,
  onToggle,
}: {
  title: string;
  description: string;
  tags: Tag[];
  selected: string[];
  onToggle: (tagId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {tags.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">No tags available.</p>
        ) : (
          tags.map((tag) => (
            <label key={tag.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
              <Checkbox
                checked={selected.includes(tag.id)}
                onCheckedChange={() => onToggle(tag.id)}
              />
              <span className="truncate text-foreground">{tag.name}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
