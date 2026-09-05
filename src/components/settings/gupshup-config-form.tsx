'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Copy, CheckCircle2, XCircle, Loader2, Zap, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { WhatsAppConfig } from '@/types';

const MASKED_KEY = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

interface Props {
  canEditSettings: boolean;
  config: WhatsAppConfig | null;
  /** Called after a successful save so the parent reloads the row (and re-syncs `provider`). */
  onSaved: () => void;
}

/**
 * Gupshup half of Settings → WhatsApp. Mirrors the Meta form's UX
 * (masked secret, Test connection, Save) but is a self-contained
 * component so the existing Meta form in whatsapp-config.tsx stays
 * completely untouched — see docs/GUPSHUP_INTEGRATION.md. Account
 * scoping happens server-side (the /api/whatsapp/config routes resolve
 * it from the session), so this component doesn't need an accountId prop.
 */
export function GupshupConfigForm({ canEditSettings, config, onSaved }: Props) {
  const isGupshupRow = config?.provider === 'gupshup';

  const [apiKey, setApiKey] = useState('');
  const [appId, setAppId] = useState('');
  const [appName, setAppName] = useState('');
  const [sourceNumber, setSourceNumber] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('unknown');
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    if (isGupshupRow) {
      setAppId(config?.gupshup_app_id || '');
      setAppName(config?.gupshup_app_name || '');
      setSourceNumber(config?.gupshup_source_phone_number || '');
      setApiKey(MASKED_KEY);
      setKeyEdited(false);
      // Real server-side health check on load, same pattern as the Meta
      // form's fetchConfig — never trust "saved" as a proxy for "working".
      setStatus('unknown');
      setStatusMessage('');
      fetch('/api/whatsapp/config', { method: 'GET' })
        .then((res) => res.json())
        .then((data) => {
          if (data.connected) {
            setStatus('connected');
          } else {
            setStatus('disconnected');
            setStatusMessage(data.message || '');
          }
        })
        .catch(() => setStatus('disconnected'));
    } else {
      setAppId('');
      setAppName('');
      setSourceNumber('');
      setApiKey('');
      setKeyEdited(false);
      setStatus('unknown');
      setStatusMessage('');
    }
  }, [isGupshupRow, config]);

  const webhookUrl =
    typeof window !== 'undefined' && isGupshupRow && config?.gupshup_webhook_token
      ? `${window.location.origin}/api/whatsapp/gupshup/webhook/${config.gupshup_webhook_token}`
      : '';

  function currentFields() {
    return {
      gupshup_api_key: keyEdited && apiKey !== MASKED_KEY ? apiKey.trim() : undefined,
      gupshup_app_id: appId.trim(),
      gupshup_app_name: appName.trim(),
      gupshup_source_phone_number: sourceNumber.replace(/\D/g, ''),
    };
  }

  async function handleTest() {
    if (!appId.trim() || !sourceNumber.trim() || (!isGupshupRow && !apiKey.trim())) {
      toast.error('API Key, App ID, and Source Number are required to test.');
      return;
    }
    setTesting(true);
    try {
      const fields = currentFields();
      const res = await fetch('/api/whatsapp/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'gupshup',
          ...fields,
          // Testing an unedited saved key needs the real key — the test
          // endpoint never sees the encrypted DB value, so a masked
          // in-progress edit can only be tested after Save.
          gupshup_api_key: fields.gupshup_api_key ?? (isGupshupRow ? undefined : apiKey.trim()),
        }),
      });
      const data = await res.json();
      if (data.connected) {
        setStatus('connected');
        setStatusMessage('');
        toast.success(
          data.details?.name ? `Connected to ${data.details.name}` : 'Gupshup connection successful',
        );
      } else {
        setStatus('disconnected');
        setStatusMessage(data.message || 'Connection failed');
        toast.error(data.message || 'Gupshup connection failed');
      }
    } catch (err) {
      console.error('Gupshup test connection error:', err);
      setStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    const fields = currentFields();
    if (!fields.gupshup_app_id || !fields.gupshup_source_phone_number) {
      toast.error('App ID and Source Number are required.');
      return;
    }
    if (!isGupshupRow && !fields.gupshup_api_key) {
      toast.error('API Key is required for initial setup.');
      return;
    }
    if (isGupshupRow && keyEdited && apiKey !== MASKED_KEY && !fields.gupshup_api_key) {
      toast.error('Please re-enter the API key, or leave it untouched to keep the saved one.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gupshup', ...fields }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save Gupshup configuration');
        return;
      }
      toast.success('Gupshup connected. Copy the webhook URL below into your Gupshup app dashboard.');
      setKeyEdited(false);
      onSaved();
    } catch (err) {
      console.error('Gupshup save error:', err);
      toast.error('Failed to save Gupshup configuration');
    } finally {
      setSaving(false);
    }
  }

  function handleCopyWebhookUrl() {
    if (!webhookUrl) return;
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {status === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {status === 'connected' ? 'Credentials valid' : 'Not connected'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {status === 'connected'
              ? 'Gupshup is connected. Outbound and inbound WhatsApp messages will use Gupshup.'
              : statusMessage || 'Enter your Gupshup credentials below and save to connect.'}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Gupshup API Credentials</CardTitle>
            <CardDescription className="text-muted-foreground">
              Find these in your Gupshup dashboard under your WhatsApp app.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Gupshup API Key</Label>
              <div className="relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  placeholder="Your Gupshup account API key"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setKeyEdited(true);
                  }}
                  onFocus={() => {
                    if (apiKey === MASKED_KEY) {
                      setApiKey('');
                      setKeyEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {isGupshupRow && !keyEdited && (
                <p className="text-xs text-muted-foreground">Saved and encrypted — leave untouched to keep it.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Gupshup App ID</Label>
              <Input
                placeholder="e.g. 3fbd7e12-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Gupshup App Name <span className="ml-1 text-muted-foreground">(optional)</span>
              </Label>
              <Input
                placeholder="e.g. NikaEstateCRM"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Sent as `src.name` on every send — used by Gupshup for routing/analytics.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">WhatsApp Source Number</Label>
              <Input
                placeholder="e.g. 15550001234 (digits only, no +)"
                value={sourceNumber}
                onChange={(e) => setSourceNumber(e.target.value.replace(/[^\d]/g, ''))}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </CardContent>
        </Card>

        {webhookUrl && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Webhook URL</CardTitle>
              <CardDescription className="text-muted-foreground">
                Paste this into your Gupshup app&apos;s Dashboard → Webhooks → Callback URL.
                Gupshup does not sign callbacks the way Meta does &mdash; this URL&apos;s random
                token IS the security boundary, so keep it private and never share it publicly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving || !canEditSettings}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save Configuration'
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !canEditSettings}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Testing…
              </>
            ) : (
              <>
                <Zap className="size-4" />
                Test connection
              </>
            )}
          </Button>
        </div>
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">Setup instructions</CardTitle>
            <CardDescription className="text-muted-foreground">
              Connect a Gupshup WhatsApp app in a few steps.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <ol className="list-decimal list-inside space-y-2">
              <li>Create (or open) a WhatsApp app in your Gupshup dashboard.</li>
              <li>Copy the App ID, API Key, and your approved source WhatsApp number here and Save.</li>
              <li>Copy the Webhook URL above into Gupshup → your app → Webhooks → Callback URL, and enable Message events + User events.</li>
              <li>Sync your approved templates from Settings → WhatsApp Templates.</li>
            </ol>
            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://docs.gupshup.io/docs/quickstart-create-and-configure-access-api"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                Gupshup docs
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
