'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
  Tags,
  Send,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { BulkContactAdvancedActions } from '@/components/contacts/bulk-contact-advanced-actions';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

const PAGE_SIZE = 25;
const CONTACT_BROADCAST_SELECTION_KEY = 'wacrm:broadcast-contact-selection';

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

type BulkTagMode = 'add' | 'remove';

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const router = useRouter();
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const { accountId } = useAuth();

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagMode, setBulkTagMode] = useState<BulkTagMode>('add');
  const [bulkTagIds, setBulkTagIds] = useState<string[]>([]);
  const [bulkWorking, setBulkWorking] = useState(false);

  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  const fetchSeq = useRef(0);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectAllMatching(false);
  }, []);

  const fetchTags = useCallback(async () => {
    if (!accountId) return;
    const { data } = await supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId);
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((tag) => (map[tag.id] = tag));
      setTagsMap(map);
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase, accountId]);

  const fetchContacts = useCallback(async () => {
    if (!accountId) return;
    const seq = ++fetchSeq.current;
    setLoading(true);

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      const { data, error } = await supabase.rpc('filter_contacts_by_tags_for_account', {
        p_account_id: accountId,
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return;
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((row) => row.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return;
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    const contactIds = contactRows.map((contact) => contact.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return;

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    setContacts(
      contactRows.map((contact) => ({
        ...contact,
        tags: (tagsByContact[contact.id] ?? [])
          .map((tagId) => tagsMap[tagId])
          .filter(Boolean),
      })),
    );
    setLoading(false);
  }, [supabase, page, search, selectedTagIds, tagsMap, t, accountId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id)
      .eq('account_id', accountId!);

    if (error) toast.error(t('toastFailedDelete'));
    else {
      toast.success(t('toastDeleted'));
      clearSelection();
      fetchContacts();
    }
    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    selectAllMatching ||
    (contacts.length > 0 && contacts.every((contact) => selected.has(contact.id)));
  const someOnPageSelected =
    selectAllMatching || contacts.some((contact) => selected.has(contact.id));
  const bulkSelectedCount = selectAllMatching ? totalCount : selected.size;

  function toggleSelectAll() {
    if (selectAllMatching) {
      clearSelection();
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (contacts.length > 0 && contacts.every((contact) => next.has(contact.id))) {
        contacts.forEach((contact) => next.delete(contact.id));
      } else {
        contacts.forEach((contact) => next.add(contact.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    if (selectAllMatching) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function currentBulkRpcParams() {
    return {
      p_account_id: accountId!,
      p_contact_ids: selectAllMatching ? null : [...selected],
      p_all_matching: selectAllMatching,
      p_filter_tag_ids: selectedTagIds.length > 0 ? selectedTagIds : null,
      p_search: search.trim() || null,
    };
  }

  async function handleBulkDelete() {
    if (!accountId || bulkSelectedCount === 0) return;
    setDeleting(true);

    const { data, error } = await supabase.rpc('delete_contacts_bulk', {
      p_account_id: accountId,
      p_contact_ids: selectAllMatching ? null : [...selected],
      p_all_matching: selectAllMatching,
      p_tag_ids: selectedTagIds.length > 0 ? selectedTagIds : null,
      p_search: search.trim() || null,
    });

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      const deletedCount = Number(data ?? bulkSelectedCount);
      toast.success(t('toastBulkDeleted', { count: deletedCount }));
      clearSelection();
      setPage(0);
      await fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  function openBulkTagDialog(mode: BulkTagMode) {
    setBulkTagMode(mode);
    setBulkTagIds([]);
    setBulkTagOpen(true);
  }

  function toggleBulkTag(tagId: string) {
    setBulkTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  async function handleBulkTags() {
    if (!accountId || bulkSelectedCount === 0 || bulkTagIds.length === 0) return;
    setBulkWorking(true);

    const { error } = await supabase.rpc('bulk_update_contact_tags', {
      p_account_id: accountId,
      p_action: bulkTagMode,
      p_tag_ids: bulkTagIds,
      p_contact_ids: selectAllMatching ? null : [...selected],
      p_all_matching: selectAllMatching,
      p_filter_tag_ids: selectedTagIds.length > 0 ? selectedTagIds : null,
      p_search: search.trim() || null,
    });

    if (error) {
      toast.error(`Failed to ${bulkTagMode} tags: ${error.message}`);
    } else {
      toast.success(
        `${bulkTagMode === 'add' ? 'Added tags to' : 'Removed tags from'} ${bulkSelectedCount.toLocaleString()} selected contacts.`,
      );
      setBulkTagOpen(false);
      setBulkTagIds([]);
      await fetchContacts();
    }
    setBulkWorking(false);
  }

  async function handleCreateBroadcast() {
    if (!accountId || bulkSelectedCount === 0) return;
    setBulkWorking(true);

    try {
      const { data, error } = await supabase.rpc('resolve_bulk_contact_ids', currentBulkRpcParams());
      if (error) throw error;

      const ids = (data ?? []) as string[];
      if (ids.length === 0) {
        toast.error('No contacts found in the current selection.');
        return;
      }

      const rows: { phone: string; name?: string }[] = [];
      const chunkSize = 500;
      for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        const { data: contactRows, error: contactError } = await supabase
          .from('contacts')
          .select('id,phone,name')
          .eq('account_id', accountId)
          .in('id', chunk);
        if (contactError) throw contactError;
        for (const contact of contactRows ?? []) {
          if (contact.phone) {
            rows.push({ phone: contact.phone, name: contact.name || undefined });
          }
        }
      }

      if (rows.length === 0) {
        toast.error('The selected contacts do not have usable phone numbers.');
        return;
      }

      window.sessionStorage.setItem(CONTACT_BROADCAST_SELECTION_KEY, JSON.stringify(rows));
      router.push('/broadcasts/new?source=contacts');
    } catch (error) {
      console.error('Failed to prepare selected contacts for broadcast:', error);
      toast.error(
        `Failed to prepare broadcast audience: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      setBulkWorking(false);
    }
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const allTags = Object.values(tagsMap).sort((a, b) => a.name.localeCompare(b.name));
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function handleSearchChange(value: string) {
    setSearch(value);
    setPage(0);
    clearSelection();
  }

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
    setPage(0);
    clearSelection();
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
    clearSelection();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={openAddForm}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder={t('searchPlaceholder')}
              className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="shrink-0 border-border text-muted-foreground hover:bg-muted"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-medium text-popover-foreground">{t('filterByTags')}</span>
                {selectedTagIds.length > 0 && (
                  <button onClick={clearTagFilters} className="text-xs text-muted-foreground hover:text-foreground">
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">{t('noTagsYet')}</p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label key={tag.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50">
                      <Checkbox
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTagFilter(tag.id)}
                        aria-label={`Filter by ${tag.name}`}
                      />
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span className="truncate text-sm text-popover-foreground">{tag.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: tag.color + '20', color: tag.color }}
                >
                  {tag.name}
                  <button onClick={() => toggleTagFilter(id)} aria-label={`Remove ${tag.name} filter`} className="hover:opacity-70">
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button onClick={clearTagFilters} className="px-1 text-xs text-muted-foreground hover:text-foreground">
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {bulkSelectedCount > 0 && accountId && (
        <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">
              {selectAllMatching
                ? `All ${totalCount.toLocaleString()} matching contacts selected`
                : t('selectedCount', { count: selected.size })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={clearSelection} className="text-muted-foreground hover:text-foreground">
                {t('clearSelection')}
              </Button>
              <GatedButton
                size="sm"
                canAct={canEdit}
                gateReason="create broadcast"
                onClick={handleCreateBroadcast}
                disabled={bulkWorking}
              >
                {bulkWorking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Create Broadcast
              </GatedButton>
              <GatedButton
                variant="outline"
                size="sm"
                canAct={canEdit}
                gateReason="edit contact tags"
                onClick={() => openBulkTagDialog('add')}
              >
                <Tags className="size-4" />
                Add Tags
              </GatedButton>
              <GatedButton
                variant="outline"
                size="sm"
                canAct={canEdit}
                gateReason="edit contact tags"
                onClick={() => openBulkTagDialog('remove')}
              >
                <Tags className="size-4" />
                Remove Tags
              </GatedButton>
              <BulkContactAdvancedActions
                accountId={accountId}
                selectedIds={[...selected]}
                allMatching={selectAllMatching}
                filterTagIds={selectedTagIds}
                search={search}
                selectedCount={bulkSelectedCount}
                canEdit={canEdit}
                onChanged={fetchContacts}
              />
              <GatedButton
                variant="destructive"
                size="sm"
                canAct={canEdit}
                gateReason="delete contacts"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="size-4" />
                {t('deleteSelected')}
              </GatedButton>
            </div>
          </div>

          {!selectAllMatching && allOnPageSelected && totalCount > selected.size && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{contacts.length} contacts on this page are selected.</span>
              <button
                type="button"
                onClick={() => {
                  setSelectAllMatching(true);
                  setSelected(new Set());
                }}
                className="font-medium text-primary hover:underline"
              >
                Select all {totalCount.toLocaleString()} matching contacts
              </button>
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label="Select all contacts on this page"
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.phone')}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t('tableColumns.email')}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t('tableColumns.company')}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t('tableColumns.tags')}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t('tableColumns.createdAt')}</TableHead>
              <TableHead className="w-12 text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters ? t('noContactsMatch') : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="add or import contacts"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={selectAllMatching || selected.has(contact.id)}
                      disabled={selectAllMatching}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={`Select ${contact.name || contact.phone}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium text-foreground">
                    {contact.name || <span className="italic text-muted-foreground">{t('unnamed')}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{contact.phone}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {contact.email || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                    {contact.company || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ backgroundColor: tag.color + '20', color: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{contact.tags.length - 3}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(event) => event.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="border-border bg-popover">
                        <DropdownMenuItem
                          onClick={(event) => {
                            event.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((value) => value - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">{t('pageCount', { page: page + 1, total: totalPages })}</span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((value) => value + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      <ImportModal open={importOpen} onOpenChange={setImportOpen} onImported={fetchContacts} />

      {canEditSettings && (
        <CustomFieldsManager open={customFieldsOpen} onOpenChange={setCustomFieldsOpen} />
      )}

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} className="border-border text-muted-foreground hover:bg-muted">
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkTagOpen} onOpenChange={setBulkTagOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {bulkTagMode === 'add' ? 'Add tags' : 'Remove tags'}
            </DialogTitle>
            <DialogDescription>
              Apply this action to {bulkSelectedCount.toLocaleString()} selected contacts.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {allTags.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">No tags found.</p>
            ) : (
              allTags.map((tag) => (
                <label key={tag.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/50">
                  <Checkbox
                    checked={bulkTagIds.includes(tag.id)}
                    onCheckedChange={() => toggleBulkTag(tag.id)}
                  />
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="text-sm">{tag.name}</span>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkTagOpen(false)} disabled={bulkWorking}>
              Cancel
            </Button>
            <Button onClick={handleBulkTags} disabled={bulkWorking || bulkTagIds.length === 0}>
              {bulkWorking && <Loader2 className="size-4 animate-spin" />}
              {bulkTagMode === 'add' ? 'Add selected tags' : 'Remove selected tags'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteBulkTitle')}</DialogTitle>
            <DialogDescription className="space-y-2 text-muted-foreground">
              <span className="block">{t('deleteBulkDesc', { count: bulkSelectedCount })}</span>
              {selectAllMatching && (
                <span className="block font-medium text-destructive">
                  This will delete every contact matching the current search and tag filters across all pages.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)} className="border-border text-muted-foreground hover:bg-muted">
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete {bulkSelectedCount.toLocaleString()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
