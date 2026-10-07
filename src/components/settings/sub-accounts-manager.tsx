'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

interface SubAccount { id: string; name: string; created_at: string; }

export function SubAccountsManager() {
  const t = useTranslations('Settings');
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch('/api/account/sub-accounts', { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) setError(payload?.error ?? t('subAccounts.loadFailed'));
    else setAccounts(payload?.accounts ?? []);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true); setError(null);
    const response = await fetch('/api/account/sub-accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) setError(payload?.error ?? t('subAccounts.createFailed'));
    else { setName(''); await load(); }
    setSaving(false);
  };

  return <section className="rounded-xl border border-border bg-card p-5">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{t('subAccounts.title')}</h2><p className="text-sm text-muted-foreground">{t('subAccounts.description')}</p></div>
      <Button type="button" variant="ghost" size="icon" onClick={() => void load()} aria-label={t('subAccounts.refresh')}><RefreshCw className="size-4" /></Button>
    </div>
    <div className="mt-5 flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('subAccounts.placeholder')} maxLength={80} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} /><Button type="button" onClick={() => void create()} disabled={saving || !name.trim()}><Plus className="mr-2 size-4" />{t('subAccounts.create')}</Button></div>
    {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    <div className="mt-5 space-y-2">{loading ? <p className="text-sm text-muted-foreground">{t('subAccounts.loading')}</p> : accounts.map((account) => <div key={account.id} className="rounded-lg border border-border px-3 py-2 text-sm">{account.name}</div>)}</div>
  </section>;
}
