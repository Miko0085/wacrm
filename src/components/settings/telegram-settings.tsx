"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Card } from "@/components/ui/card"

interface TelegramConnection {
  id: string
  name: string
  default_chat_id: string | null
  is_active: boolean
}

export function TelegramSettings() {
  const [connections, setConnections] = useState<TelegramConnection[]>([])
  const [name, setName] = useState("")
  const [botToken, setBotToken] = useState("")
  const [chatId, setChatId] = useState("")
  const [saving, setSaving] = useState(false)

  async function load() {
    const res = await fetch("/api/integrations/telegram", { cache: "no-store" })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error ?? "Failed to load Telegram connections")
      return
    }
    setConnections(json.connections ?? [])
  }

  useEffect(() => {
    void load()
  }, [])

  async function createConnection() {
    if (!name.trim() || !botToken.trim()) {
      toast.error("Name and bot token are required")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/integrations/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          bot_token: botToken.trim(),
          default_chat_id: chatId.trim() || null,
          is_active: true,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error ?? "Failed to save Telegram connection")
        return
      }
      toast.success("Telegram bot connected")
      setName("")
      setBotToken("")
      setChatId("")
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function toggleConnection(connection: TelegramConnection, active: boolean) {
    const res = await fetch("/api/integrations/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: connection.id,
        name: connection.name,
        default_chat_id: connection.default_chat_id,
        is_active: active,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error ?? "Failed to update Telegram connection")
      return
    }
    await load()
  }

  async function testConnection(connection: TelegramConnection) {
    const res = await fetch("/api/integrations/telegram/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: connection.id }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error ?? "Telegram test failed")
      return
    }
    toast.success(
      json.message_sent
        ? `Telegram test sent via @${json.username ?? "bot"}`
        : `Telegram bot @${json.username ?? "bot"} is reachable`,
    )
  }

  async function removeConnection(connection: TelegramConnection) {
    const res = await fetch(
      `/api/integrations/telegram?id=${encodeURIComponent(connection.id)}`,
      { method: "DELETE" },
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error ?? "Failed to remove Telegram connection")
      return
    }
    toast.success("Telegram connection removed")
    await load()
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Telegram integrations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect one or more Telegram bots for Automation notifications. Bot tokens are encrypted at rest.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sales notifications"
          />
          <Input
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="BotFather token"
            type="password"
          />
        </div>
        <Input
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="Default chat ID (optional)"
        />
        <Button onClick={createConnection} disabled={saving}>
          {saving ? "Saving…" : "Connect bot"}
        </Button>
      </Card>

      <div className="space-y-2">
        {connections.map((connection) => (
          <Card key={connection.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {connection.name}
              </div>
              <div className="text-xs text-muted-foreground">
                {connection.default_chat_id
                  ? `Default chat: ${connection.default_chat_id}`
                  : "No default chat"}
              </div>
            </div>
            <Switch
              checked={connection.is_active}
              onCheckedChange={(value) => void toggleConnection(connection, !!value)}
            />
            <Button variant="outline" onClick={() => void testConnection(connection)}>
              Test
            </Button>
            <Button variant="ghost" onClick={() => void removeConnection(connection)}>
              Remove
            </Button>
          </Card>
        ))}
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Telegram bots connected yet.</p>
        ) : null}
      </div>
    </section>
  )
}
