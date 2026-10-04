'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Download,
  FilePenLine,
  ListPlus,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  ShieldOff,
} from 'lucide-react';
import type { CustomField } from '@/types';

interface BulkSelection {
  accountId: string;
  selectedIds: string[];
  allMatching: boolean;
  filterTagIds: string[];
  search: string;
  selectedCount: number;
}

interface Props extends BulkSelection {
  canEdit: boolean;
  onChanged?: () => void | Promise<void>;
}

type DialogMode = 'custom_field' | 'note' | 'suppress' | 'smart_list' | null;

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function BulkContactAdvancedActions({
  accountId,
  selectedIds,
  allMatching,
  filterTagIds,
  search,
  selectedCount,
  canEdit,
  onChanged,
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [working, setWorking] = useState(false);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customFieldId, setCustomFieldId] = useState('');
  const [customFieldValue, setCustomFieldValue] = useState('');
  const [clearCustomField, setClearCustomField] = useState(false);
  const [note, setNote] = useState('');
  const [smartListName, setSmartListName] = useState('');
  const [smartListDescription, setSmartListDescription] = useState('');

  const selectionParams = {
    p_account_id: accountId,
    p_contact_ids: allMatching ? null : selectedIds,
    p_all_matching: allMatching,
    p_filter_tag_ids: filterTagIds.length > 0 ? filterTagIds : null,
    p_search: search.trim() || null,
  };

  async function resolveIds(): Promise<string[]> {
    const { data, error } = await supabase.rpc('resolve_bulk_contact_ids', selectionParams);
    if (error) throw error;
    return (data ?? []) as string[];
  }

  async function loadCustomFields() {
    const { data, error } = await supabase
      .from('custom_fields')
      .select('*')
      .eq('account_id', accountId)
      .order('field_name');
    if (error) throw error;
    setCustomFields((data ?? []) as CustomField[]);
  }

  async function openCustomField() {
    try {
      await loadCustomFields();
      setCustomFieldId('');
      setCustomFieldValue('');
      setClearCustomField(false);
      setDialog('custom_field');
    } catch (error) {
      toast.error(`Failed to load custom fields: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async function exportCsv() {
    setWorking(true);
    try {
      const ids = await resolveIds();
      if (ids.length === 0) throw new Error('Selection is empty');

      type Row = {
        id: string;
        name: string | null;
        phone: string;
        email: string | null;
        company: string | null;
        wa_marketing_status?: string | null;
        created_at: string;
      };

      const contacts: Row[] = [];
      const chunkSize = 500;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('contacts')
          .select('id,name,phone,email,company,wa_marketing_status,created_at')
          .eq('account_id', accountId)
          .in('id', chunk);
        if (error) throw error;
        contacts.push(...((data ?? []) as Row[]));
      }

      const [{ data: tagRows, error: tagsError }, { data: fields, error: fieldsError }] = await Promise.all([
        supabase.from('tags').select('id,name').eq('account_id', accountId),
        supabase.from('custom_fields').select('id,field_name').eq('account_id', accountId).order('field_name'),
      ]);
      if (tagsError) throw tagsError;
      if (fieldsError) throw fieldsError;

      const tagName = new Map((tagRows ?? []).map((tag) => [tag.id, tag.name]));
      const tagsByContact = new Map<string, string[]>();
      const valuesByContact = new Map<string, Map<string, string>>();

      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const [{ data: contactTags, error: contactTagsError }, { data: customValues, error: valuesError }] =
          await Promise.all([
            supabase.from('contact_tags').select('contact_id,tag_id').in('contact_id', chunk),
            supabase.from('contact_custom_values').select('contact_id,custom_field_id,value').in('contact_id', chunk),
          ]);
        if (contactTagsError) throw contactTagsError;
        if (valuesError) throw valuesError;

        for (const item of contactTags ?? []) {
          const list = tagsByContact.get(item.contact_id) ?? [];
          const name = tagName.get(item.tag_id);
          if (name) list.push(name);
          tagsByContact.set(item.contact_id, list);
        }
        for (const item of customValues ?? []) {
          const map = valuesByContact.get(item.contact_id) ?? new Map<string, string>();
          map.set(item.custom_field_id, item.value ?? '');
          valuesByContact.set(item.contact_id, map);
        }
      }

      const customColumns = (fields ?? []) as { id: string; field_name: string }[];
      const header = [
        'id',
        'name',
        'phone',
        'email',
        'company',
        'tags',
        'marketing_status',
        'created_at',
        ...customColumns.map((field) => field.field_name),
      ];
      const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
      const lines = [header.map(csvEscape).join(',')];

      for (const id of ids) {
        const contact = contactById.get(id);
        if (!contact) continue;
        const values = valuesByContact.get(id);
        lines.push(
          [
            contact.id,
            contact.name ?? '',
            contact.phone,
            contact.email ?? '',
            contact.company ?? '',
            (tagsByContact.get(id) ?? []).join('; '),
            contact.wa_marketing_status ?? '',
            contact.created_at,
            ...customColumns.map((field) => values?.get(field.id) ?? ''),
          ]
            .map(csvEscape)
            .join(','),
        );
      }

      const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `wacrm-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${contacts.length.toLocaleString()} contacts.`);
    } catch (error) {
      console.error(error);
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setWorking(false);
    }
  }

  async function applyCustomField() {
    if (!customFieldId || (!clearCustomField && customFieldValue.length === 0)) return;
    setWorking(true);
    try {
      const { error } = await supabase.rpc('bulk_set_contact_custom_field', {
        ...selectionParams,
        p_custom_field_id: customFieldId,
        p_value: clearCustomField ? null : customFieldValue,
        p_clear: clearCustomField,
      });
      if (error) throw error;
      toast.success(`${clearCustomField ? 'Cleared' : 'Updated'} custom field for ${selectedCount.toLocaleString()} contacts.`);
      setDialog(null);
      await onChanged?.();
    } catch (error) {
      toast.error(`Custom field update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setWorking(false);
    }
  }

  async function suppressMarketing() {
    setWorking(true);
    try {
      const { data, error } = await supabase.rpc('bulk_suppress_marketing', selectionParams);
      if (error) throw error;
      toast.success(`Marketing suppressed for ${Number(data ?? 0).toLocaleString()} contacts.`);
      setDialog(null);
      await onChanged?.();
    } catch (error) {
      toast.error(`Suppression failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setWorking(false);
    }
  }

  async function addInternalNote() {
    if (!note.trim()) return;
    setWorking(true);
    try {
      const { data, error } = await supabase.rpc('bulk_add_contact_note', {
        ...selectionParams,
        p_note: note.trim(),
      });
      if (error) throw error;
      toast.success(`Added note to ${Number(data ?? selectedCount).toLocaleString()} contacts.`);
      setNote('');
      setDialog(null);
      await onChanged?.();
    } catch (error) {
      toast.error(`Failed to add note: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setWorking(false);
    }
  }

  async function saveSmartList() {
    if (!smartListName.trim()) return;
    setWorking(true);
    try {
      const { error } = await supabase.rpc('create_static_smart_list_from_selection', {
        ...selectionParams,
        p_name: smartListName.trim(),
        p_description: smartListDescription.trim() || null,
      });
      if (error) throw error;
      toast.success(`Saved ${selectedCount.toLocaleString()} contacts as a static Smart List.`);
      setSmartListName('');
      setSmartListDescription('');
      setDialog(null);
    } catch (error) {
      toast.error(`Failed to create Smart List: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" disabled={working || selectedCount === 0 || !canEdit} />
          }
        >
          {working ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
          More Actions
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={exportCsv}>
            <Download className="size-4" />
            Export CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openCustomField}>
            <FilePenLine className="size-4" />
            Set Custom Field
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog('note')}>
            <MessageSquareText className="size-4" />
            Add Internal Note
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog('smart_list')}>
            <ListPlus className="size-4" />
            Save as Smart List
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog('suppress')}>
            <ShieldOff className="size-4" />
            Suppress Marketing / DNC
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === 'custom_field'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set Custom Field</DialogTitle>
            <DialogDescription>
              Update one custom field for {selectedCount.toLocaleString()} selected contacts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <select
              value={customFieldId}
              onChange={(event) => setCustomFieldId(event.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="">Select field…</option>
              {customFields.map((field) => (
                <option key={field.id} value={field.id}>{field.field_name}</option>
              ))}
            </select>
            <Input
              value={customFieldValue}
              onChange={(event) => setCustomFieldValue(event.target.value)}
              placeholder="New value"
              disabled={clearCustomField}
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={clearCustomField}
                onChange={(event) => setClearCustomField(event.target.checked)}
              />
              Clear this field instead
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={working}>Cancel</Button>
            <Button onClick={applyCustomField} disabled={working || !customFieldId || (!clearCustomField && customFieldValue.length === 0)}>
              {working && <Loader2 className="size-4 animate-spin" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'note'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Internal Note</DialogTitle>
            <DialogDescription>
              The same internal note will be added to {selectedCount.toLocaleString()} contacts.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="Internal note…"
            className="w-full rounded-md border border-border bg-background p-3 text-sm text-foreground outline-none focus:border-primary"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={working}>Cancel</Button>
            <Button onClick={addInternalNote} disabled={working || !note.trim()}>
              {working && <Loader2 className="size-4 animate-spin" />}
              Add Note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'smart_list'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save Selection as Smart List</DialogTitle>
            <DialogDescription>
              Creates a static snapshot containing the {selectedCount.toLocaleString()} contacts selected right now.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              value={smartListName}
              onChange={(event) => setSmartListName(event.target.value)}
              placeholder="Smart List name"
              maxLength={120}
            />
            <Input
              value={smartListDescription}
              onChange={(event) => setSmartListDescription(event.target.value)}
              placeholder="Optional description"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={working}>Cancel</Button>
            <Button onClick={saveSmartList} disabled={working || !smartListName.trim()}>
              {working && <Loader2 className="size-4 animate-spin" />}
              Save Smart List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'suppress'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Suppress Marketing / DNC?</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                This will set WhatsApp marketing status to OPTED_OUT for {selectedCount.toLocaleString()} contacts.
              </span>
              <span className="block font-medium text-destructive">
                Marketing templates and broadcasts will be blocked for these contacts. This action does not create a manual opt-in path.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={working}>Cancel</Button>
            <Button variant="destructive" onClick={suppressMarketing} disabled={working}>
              {working && <Loader2 className="size-4 animate-spin" />}
              Suppress {selectedCount.toLocaleString()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
