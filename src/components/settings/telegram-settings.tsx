'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { SettingsPanelHead } from './settings-panel-head'

interface Connection {
  id: string
  name: string
  default_chat_id: string | null
  is_active: boolean
}

export function TelegramSettings() {
  const [items, setItems] = useState<Connection[]>([])
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const res = await fetch('/api/integrations/telegram', { cache: 'no-store' })
    const json = await res.json()
    if (res.ok) setItems(json.connections ?? [])
    else toast.error(json.error ?? 'Could not load Telegram connections')
  }

  useEffect(() => { void load() }, [])

  const add = async () => {
    if (!name.trim() || !token.trim()) {
      toast.error('Name and BotFather token are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          bot_token: token.trim(),
          default_chat_id: chatId.trim() || null,
          is_active: active,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Save failed')
      setName(''); setToken(''); setChatId(''); setActive(true)
      toast.success('Telegram bot connected')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const test = async (item: Connection) => {
    const res = await fetch('/api/integrations/telegram/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: item.id }),
    })
    const json = await res.json()
    if (res.ok) toast.success('Test message sent')
    else toast.error(json.error ?? 'Test failed')
  }

  const remove = async (id: string) => {
    const res = await fetch(`/api/integrations/telegram?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      toast.success('Telegram connection removed')
      await load()
    } else {
      const json = await res.json()
      toast.error(json.error ?? 'Delete failed')
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title="Telegram"
        description="Connect Telegram bots for automation and handoff notifications."
      />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add bot</CardTitle>
            <CardDescription>The bot token is encrypted at rest and is never returned to the browser.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales notifications" />
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="BotFather token" autoComplete="off" />
            <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="Default chat ID (optional)" />
            <div className="flex items-center gap-2">
              <Switch checked={active} onCheckedChange={setActive} />
              <span className="text-sm">Active</span>
            </div>
            <Button onClick={add} disabled={saving}>{saving ? 'Saving…' : 'Connect bot'}</Button>
          </CardContent>
        </Card>

        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-muted-foreground">
                  {item.default_chat_id ? `Default chat: ${item.default_chat_id}` : 'No default chat configured'}
                  {!item.is_active ? ' · inactive' : ''}
                </div>
              </div>
              <Button variant="outline" onClick={() => test(item)}>Test</Button>
              <Button variant="ghost" onClick={() => remove(item.id)}>Remove</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
