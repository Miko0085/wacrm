# Gupshup as a WhatsApp BSP Provider — Complete Reference

This is the single authoritative reference for Gupshup as a WhatsApp
Business API provider inside WACRM's provider layer. It consolidates
the architecture, the confirmed API contract (including everything
found by testing against a live Gupshup app — not just what the docs
say), setup, operations, and troubleshooting into one document.

Companion documents:
- [`GUPSHUP_INTEGRATION_AUDIT.md`](./GUPSHUP_INTEGRATION_AUDIT.md) — the
  pre-implementation map of every place the codebase touched Meta
  directly, and how each became provider-agnostic. Historical/design
  record; read this to understand *why* the code is shaped the way it is.
- [`GUPSHUP_TEST_REPORT.md`](./GUPSHUP_TEST_REPORT.md) — the QA log:
  what was tested, against a real Gupshup app, and what bugs that
  testing found and fixed. Read this for the raw evidence behind the
  claims in this guide.
- [`GUPSHUP_INTEGRATION.md`](./GUPSHUP_INTEGRATION.md) — shorter setup-
  oriented doc; this guide supersedes it as the complete reference but
  that one stays as a quick-start.

---

## 1. What "BSP" means here

Gupshup is a **Business Solution Provider (BSP)** — a company Meta has
approved to resell and operate WhatsApp Business Platform access on
behalf of end businesses. Concretely, that means:

- The end business (e.g. a real-estate brokerage) does **not** talk to
  Meta's Graph API directly. It talks to **Gupshup's own REST API**,
  and Gupshup relays to WhatsApp on the business's behalf.
- Authentication is a Gupshup-issued **API key** (a header, `apikey:
  <key>`), not a Meta OAuth access token. There is no token refresh
  flow, no app-review process, no Graph API version to track.
- Gupshup layers its own concepts on top of the underlying WhatsApp
  primitives: an **App** (one WhatsApp number + its configuration),
  identified by an **App ID** and an **App Name** (`src.name`, sent on
  every outbound call, used by Gupshup for routing/analytics/billing).
- Because Gupshup is a proxy, **Gupshup's documented request/response
  shapes are the ground truth for this integration** — not Meta's
  Graph API shapes, even though the end result (a WhatsApp message) is
  the same. Every endpoint below is Gupshup's own API.
- Compared to Meta's direct Cloud API (also supported in WACRM as the
  other provider), Gupshup trades some control (no direct Graph API
  access, no Meta App Review needed) for simplicity: one API key, one
  REST surface, and Gupshup's own dashboard for template moderation
  submission and business profile management.

WACRM treats both as interchangeable implementations of one
`WhatsAppProvider` interface (`src/lib/whatsapp/providers/types.ts`) —
nothing above that interface (Shared Inbox, broadcasts, automations,
Flows, AI, the public API, MCP) knows or cares which BSP is behind it.

---

## 2. Architecture

```
WACRM business logic
  (send-message.ts, broadcast-core.ts, automations/meta-send.ts,
   flows/meta-send.ts, the config/template routes, the shared
   inbound pipeline)
              │
              ▼
   resolveWhatsAppProvider(whatsapp_config row)
              │
      ┌───────┴────────┐
      ▼                ▼
createMetaProvider   createGupshupProvider
(meta-api.ts)        (gupshup-provider.ts + gupshup-client.ts)
      │                │
      ▼                ▼
Meta Graph API     Gupshup REST API
                    (api.gupshup.io/wa/*)
```

Files, by responsibility:

| File | Responsibility |
|---|---|
| `src/lib/whatsapp/providers/types.ts` | The `WhatsAppProvider` interface every provider implements |
| `src/lib/whatsapp/providers/resolve.ts` | `resolveWhatsAppProvider(config)` — reads `whatsapp_config.provider`, decrypts the right credentials, returns a ready provider |
| `src/lib/whatsapp/providers/gupshup-client.ts` | Raw HTTP calls to Gupshup's API — no business logic, just request/response shape |
| `src/lib/whatsapp/providers/gupshup-provider.ts` | Implements `WhatsAppProvider` on top of the client — maps WACRM's generic send args to Gupshup's specific message-type payloads |
| `src/lib/whatsapp/providers/gupshup-status-map.ts` | Gupshup's delivery-status and template-status vocabularies → WACRM's shared vocabularies |
| `src/lib/whatsapp/providers/gupshup-webhook.ts` | Parses Gupshup's inbound webhook envelope into WACRM's normalized shapes |
| `src/app/api/whatsapp/gupshup/webhook/[token]/route.ts` | The actual webhook endpoint Gupshup calls |
| `src/lib/whatsapp/inbound-pipeline.ts` | Shared core (contact/conversation resolution, dedup, status ladder, flows/automations/AI dispatch) — used by both providers' webhook routes |
| `src/lib/whatsapp/suppression.ts` | Marketing-consent enforcement, provider-independent |
| `src/components/settings/gupshup-config-form.tsx` | Settings UI for Gupshup credentials |

---

## 3. Prerequisites

Before connecting a Gupshup app to WACRM, you need, from the Gupshup
side:

1. **A Gupshup account** with an approved WhatsApp Business App. Create
   one at [gupshup.io](https://www.gupshup.io) → dashboard → create app
   → WhatsApp.
2. **Business verification** completed with Meta (Gupshup's onboarding
   flow handles this — a business profile, a phone number dedicated to
   WhatsApp, Meta Business Manager verification). This is a one-time
   process outside WACRM's scope; WACRM only consumes the result.
3. From the finished app, four values:
   - **API Key** — account-level secret (Gupshup dashboard → API keys,
     or shown on app creation).
   - **App ID** — a UUID identifying this specific WhatsApp app.
   - **App Name** — the human-readable name you gave the app (sent as
     `src.name` on every send).
   - **Source Number** — the WhatsApp-enabled phone number this app
     sends from, digits only, no `+` (e.g. `971566218244`).

None of these are things WACRM can generate or guess — they only exist
once the Gupshup-side app is live.

---

## 4. Connecting in WACRM

**Settings → WhatsApp → provider selector → Gupshup.**

1. Enter API Key, App ID, App Name, Source Number.
2. **Test connection** — this calls `GET /wa/app/{app_id}/business`
   server-side with the values currently in the form, *before* saving
   anything. A failure here means the credentials are wrong; fix them
   before saving. (See §6.4 for the exact response shape this call
   returns — it's not what Gupshup's own docs example shows.)
3. **Save** — WACRM re-verifies, encrypts the API key (AES-256-GCM,
   same mechanism as Meta's `access_token` column — see
   `src/lib/whatsapp/encryption.ts`), and — on first save only —
   generates a random 24-byte webhook token.
4. Copy the shown **Webhook URL**
   (`https://<your-domain>/api/whatsapp/gupshup/webhook/<token>`) into
   **Gupshup Dashboard → your app → Webhooks → Callback URL**. Select
   callback **format v2** (confirmed — see §7.1) and enable **Message
   events** and **User events** (see §7 for exactly which sub-events
   matter).
5. **Settings → WhatsApp Templates → Sync from Gupshup** to pull in
   any templates already approved on the Gupshup side.

Local/dev note: Gupshup's servers need a **publicly reachable** URL for
the webhook. For local development, a tunnel (e.g.
`cloudflared tunnel --url http://localhost:3000`, no account needed for
a quick tunnel) exposes your dev server; use the tunnel's `https://`
URL as the base for the webhook URL above. Quick tunnels are temporary
— the URL changes if the tunnel restarts, and you'll need to update it
in the Gupshup dashboard again.

### Data model

One row per account in `whatsapp_config` (migration 040), holding
**both** providers' credentials side by side:

```
provider                      TEXT      'meta' | 'gupshup'
gupshup_api_key                TEXT      encrypted (AES-256-GCM)
gupshup_app_id                  TEXT
gupshup_app_name                TEXT
gupshup_source_phone_number      TEXT      digits only
gupshup_connected_at             TIMESTAMPTZ
gupshup_webhook_token            TEXT      random, unique — the webhook URL's secret path segment
```

Switching `provider` between `'meta'` and `'gupshup'` never deletes the
other provider's saved columns — that's what makes switching back and
forth non-destructive (see §12).

---

## 5. API endpoints used

Base URL: `https://api.gupshup.io/wa`. All authenticated with an
`apikey: <key>` header. POST bodies are
`application/x-www-form-urlencoded` (not JSON) — this is a real
Gupshup API convention, not a WACRM choice.

| Purpose | Method + Path | Used by |
|---|---|---|
| Session (free-form) message | `POST /api/v1/msg` | `sendText`, `sendMedia`, `sendInteractive` |
| Template message | `POST /api/v1/template/msg` | `sendTemplate` |
| List templates | `GET /app/{app_id}/template` | `listTemplates` (template sync) |
| Business details | `GET /app/{app_id}/business` | `testConnection` (no dedicated health-check endpoint exists; this doubles as one) |

### 5.1 Session message — `POST /api/v1/msg`

Body fields (form-encoded):

| Field | Value |
|---|---|
| `channel` | `whatsapp` |
| `source` | your app's source number (digits only) |
| `destination` | recipient's number (digits only) |
| `src.name` | your App Name |
| `message` | a JSON **string** (not nested form fields) — shape depends on type, see below |

`message` shapes by type (all confirmed live except where noted):

```jsonc
// text
{ "type": "text", "text": "Hello!", "previewUrl": true }

// image
{ "type": "image", "originalUrl": "<url>", "previewUrl": "<url>", "caption": "optional" }

// video
{ "type": "video", "url": "<url>", "previewUrl": "<url>", "caption": "optional" }

// file / document
{ "type": "file", "url": "<url>", "filename": "optional", "caption": "optional" }

// audio — NO caption, NO filename (WhatsApp rejects both on audio)
{ "type": "audio", "url": "<url>" }

// quick-reply buttons (max 3, per WhatsApp's own button-message limit)
{
  "type": "quick_reply",
  "content": { "type": "text", "text": "body text" },
  "options": [{ "title": "Yes", "postbackText": "yes" }, { "title": "No", "postbackText": "no" }]
}

// list (up to 10 rows total across sections)
{
  "type": "list",
  "title": "header text",
  "body": "body text",
  "globalButtons": [{ "type": "text", "title": "Open options" }],
  "items": [{ "title": "Section title", "options": [{ "type": "text", "title": "Row 1", "description": "optional", "postbackText": "row-id" }] }]
}
```

Success response: `{"status": "submitted", "messageId": "<uuid>"}` —
note the id is a **UUID**, not the hex-ish string shown in some of
Gupshup's own doc examples; this is what a real send returns.

Media reliability (confirmed by testing, not a documented Gupshup
guarantee): Gupshup's media fetcher is pickier than a generic HTTP
client. Prefer small, directly-hosted files (no redirect chain) with an
exact `Content-Type` match for the media kind. Audio specifically must
be a WhatsApp-supported codec — an OGG file encoded with Vorbis (not
Opus) was rejected outright in testing; WhatsApp's own spec requires
OGG/Opus for audio.

### 5.2 Template message — `POST /api/v1/template/msg`

| Field | Value |
|---|---|
| `channel` | `whatsapp` |
| `source` | app's source number |
| `destination` | recipient's number |
| `src.name` | App Name |
| `template` | JSON string: `{"id": "<gupshup template id>", "params": ["value1", "value2", ...]}` — positional, matches the template's `{{1}}`, `{{2}}`, … in order |
| `message` | optional JSON string, only for a media-header template: `{"type": "image", "image": {"link": "<url>"}}` (or `video`/`file` analogously) — the media itself is NOT part of the `template` object |

Success response: `{"messageId": "<uuid>", "status": "success"}`.

### 5.3 List templates — `GET /app/{app_id}/template`

Query params (optional): `pageNo`, `pageSize`, `templateStatus`,
`templateCategory`, `templateType`, `quality`, `languageCode`. WACRM's
`listTemplates()` doesn't currently page through results — see
limitation in §11.

Response:

```jsonc
{
  "status": "success",
  "templates": [
    {
      "id": "<gupshup template id — save as message_templates.gupshup_template_id>",
      "elementName": "<template name>",
      "status": "SUBMITTED" | "APPROVED" | "REJECTED" | "PAUSED" | "FAILED" | "DEACTIVATED",
      "category": "MARKETING" | "UTILITY" | "AUTHENTICATION",
      "languageCode": "en",
      "templateType": "TEXT",
      "data": "<rendered body with {{n}} placeholders — this is ALL the structure Gupshup returns; no separate header/footer/buttons breakdown>",
      "quality": "UNKNOWN" | "GREEN" | "YELLOW" | "RED"
    }
  ]
}
```

Confirmed live: a freshly-submitted template shows `status: "PENDING"`
in this response's normalized form (Gupshup's raw value was consistent
with the "SUBMITTED → PENDING" mapping — see §8.1) until Meta finishes
reviewing it, which took longer than a few minutes in testing (Meta's
own template review SLA is typically minutes to ~24h; treat it as
"eventually consistent," not instant).

### 5.4 Business details — `GET /app/{app_id}/business`

**Real response shape (confirmed live — differs from the flat example
in Gupshup's own docs page):**

```json
{
  "status": "success",
  "business": {
    "name": "Acme Inc",
    "contactNumber": "...",
    "email": "...",
    "emailVerified": true,
    "country": "...",
    "city": "...",
    "state": "...",
    "website": "",
    "vertical": "OTHER",
    "tncAccepted": false,
    "createdOn": 1785584120458,
    "modifiedOn": 1788601107790
  }
}
```

`gupshup-client.ts`'s `getBusinessDetails()` unwraps `business` (with a
flat-shape fallback for safety) — this is what powers the "Test
connection" button and the account health check.

---

## 6. Webhooks (inbound)

### 6.1 Setup

Gupshup has **no API to register a webhook URL** — it's set manually in
**Dashboard → your app → Webhooks → Callback URL**, with a format
selector. **Select format v2** — this integration is built and tested
against the v2 envelope. (Gupshup's docs mention no independently
documented "v3" webhook format; the only "v3" reference found anywhere
in their docs was an unrelated send-API product name. If your dashboard
only offers v3 or defaults to it, treat any parsing failures —
`unsupported_provider_event` logs — as the signal to investigate
further.)

Enable the **Message events** and **User events** checkboxes. Gupshup
turns on `Enqueued` and `Failed` message sub-events by default; enable
`Sent`, `Delivered`, and `Read` explicitly if your dashboard shows them
as separate toggles, otherwise WACRM only sees the status ladder's
endpoints and misses the middle states. System/Billing events can be
left on or off — WACRM logs them as `unsupported_provider_event` and
ignores them safely either way.

### 6.2 Security — no signature verification exists

Unlike Meta (`x-hub-signature-256`, HMAC-SHA256 over the app secret),
**Gupshup does not sign webhook callbacks**. This is a genuine
limitation of the platform, not something this integration failed to
implement. The mitigations WACRM applies instead:

1. A random, unguessable, per-account **24-byte token in the URL path
   itself** — this is the actual security boundary. Never share this
   URL; if you suspect it leaked, disconnect and reconnect Gupshup in
   Settings to generate a new one (then update the Gupshup dashboard).
2. A rate limit keyed to the token (`RATE_LIMITS.gupshupWebhook` —
   600/min, generous enough for a busy shared inbox, tight enough to
   bound a flood against a leaked token).
3. Strict envelope validation before any database write — a malformed
   body is rejected with 400 before it's looked at further.
4. An unknown/wrong token returns the same 404 as any other not-found
   route — the endpoint never confirms a token's validity to an
   unauthenticated caller.

### 6.3 Envelope

Every callback:

```json
{ "app": "<app name>", "timestamp": 1788600000000, "version": 2, "type": "message | message-event | user-event | ...", "payload": { /* varies by type */ } }
```

### 6.4 Inbound message — `type: "message"`

```json
{
  "id": "wamid...",
  "source": "<sender's phone, digits only>",
  "type": "text | image | file | audio | video | location | contact | button_reply | list_reply",
  "payload": { /* varies by type, see below */ },
  "sender": { "phone": "...", "name": "...", "country_code": "...", "dial_code": "..." },
  "context": { "id": "<parent wamid>", "gsId": "..." }  // present only on a swipe-reply
}
```

Per-type `payload` (confirmed live where marked):

| Type | Fields | Confirmed |
|---|---|---|
| `text` | `text` | live |
| `image` / `video` | `url`, `contentType`, `caption` | live (image); video by symmetry |
| `file` | `url`, `contentType`, `filename`, `caption` | live |
| `audio` | `url`, `contentType` | by symmetry with the others |
| `location` | `latitude`, `longitude`, `name`, `address` | by symmetry with Gupshup's outbound location conventions — not independently confirmed live |
| `button_reply` / `list_reply` | `title`, `id` (**always empty string in practice**), `reply`, **`postbackText`** (← this is the stable id) | **live, and this is the exact bug this guide exists to save you from re-discovering** — see §11 |

The `button_reply`/`list_reply` case is the single most important
correction in this entire guide: **the tapped option's stable id is in
`postbackText`, never `id`.** `sendInteractive()` writes
`postbackText` on the way out for exactly this reason — it's what
round-trips.

### 6.5 Delivery status — `type: "message-event"`

```json
{ "id": "...", "gsId": "...", "type": "enqueued | sent | delivered | read | failed | deleted", "destination": "...", "payload": { "ts": 1788600000 } }
```

- For `enqueued`/`failed`, `id` is Gupshup's own message id.
- For `sent`/`delivered`/`read` (DLR events), `id` is the **WhatsApp**
  message id and `gsId` is Gupshup's id — WACRM correlates on
  `gsId ?? id`, which matches `sendSessionMessage`/`sendTemplateMessage`'s
  returned `messageId` (stored as `messages.message_id` /
  `broadcast_recipients.whatsapp_message_id`).
- Mapped onto WACRM's shared ladder: `enqueued→pending`, `sent→sent`,
  `delivered→delivered`, `read→read`, `failed→failed`. `deleted` has no
  slot in WACRM's status model — logged and skipped, not silently
  dropped, not a crash.
- **Out-of-order safe**: the shared status-ladder guard
  (`isValidStatusTransition`, `inbound-pipeline.ts`) refuses to regress
  a recipient — a late `delivered` callback arriving after `read` is
  ignored, and `failed` is only accepted from `pending`/`sent`, never
  after a success state. Confirmed live: a real message reached `read`
  through three separate async webhook deliveries without any
  reordering issue.

Known failure code (confirmed live, via a real send that failed):
**1008 — "Neither Proxied Nor Opted-in"** ("user is not opted in and
inactive"). This is an account/number-state issue (the destination
number needs to be recognized as opted-in/active by Gupshup — resolve
in the Gupshup dashboard, e.g. sandbox/test-recipient allowlisting),
**not** a code defect — the request, the response parsing, and the
status webhook all worked correctly; the message itself was genuinely
rejected upstream. See Gupshup's `error-and-status-messages` doc for
the full code list (1001–4005 range covers wallet balance, template
mismatches, media errors, rate limits, and more).

### 6.6 User event (opt-in/opt-out) — `type: "user-event"`

```json
{ "phone": "<digits>", "type": "opted-in" | "opted-out" }
```

Mapped onto `contacts.wa_marketing_status` (`OPTED_IN`/`OPTED_OUT`),
matched by the digits-only `phone_normalized` column. See §9.

---

## 7. Templates

- **Sync** (`Settings → WhatsApp Templates → Sync from Gupshup`) calls
  `listTemplates()` and upserts into `message_templates`, keyed by
  `(account_id, name, language)`. Category/status are normalized into
  WACRM's shared vocabulary (§8.1). `gupshup_template_id` is the join
  key for sending.
- **Structural gap**: Gupshup's list endpoint returns only the rendered
  body — header/footer/button structure is not recoverable from it. A
  Gupshup-synced template's `header_type`/`footer_text`/`buttons`
  columns stay `null` even if the template genuinely has them on
  Gupshup's side. Body text and `{{n}}` variables sync correctly.
- **Create/edit/delete**: not implemented via WACRM's UI for Gupshup —
  manage templates in Gupshup's own dashboard (where they also go
  through Meta's approval process), then Sync to pull the current
  state. Meta's own create/edit/delete flow is untouched.
- **Sending**: `sendTemplate()` requires the local row's
  `gupshup_template_id` (throws a clear `invalid_template` error if
  missing — i.e. the template was never synced). Positional `params`
  map to the template's `{{n}}` slots. A media-header template attaches
  its media via the separate `message` object described in §5.2.
- **Confirmed live, end to end**: submitted a real text template on a
  live Gupshup app, waited for Meta's review (took a few hours, not
  instant), synced it, then sent it two ways — a direct
  `sendMessageToConversation()` call and a full
  `createBroadcast()` + `deliverBroadcast()` broadcast — both reached
  a real WhatsApp phone. The broadcast's aggregate counters
  (`sent_count`/`delivered_count`/`read_count`) and per-recipient
  `broadcast_recipients.status` advanced correctly through the real
  status webhooks, and a real reply from the recipient flipped
  `replied_count` to 1. A media-header template's wire format is
  implemented and unit-tested but wasn't independently live-tested
  (the approved test template was text-only) — see
  `GUPSHUP_TEST_REPORT.md` for the full run.

---

## 8. Status & category normalization

### 8.1 Template status

Gupshup's review vocabulary (`Submitted`, `Approved`, `Rejected`,
`Paused`, `Failed`, `Deactivated`) maps onto the **same enum** Meta
templates use (`DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED|IN_APPEAL|PENDING_DELETION`),
so the rest of the app (edit/resubmit/delete gating, the templates UI)
needs no second vocabulary:

| Gupshup | WACRM |
|---|---|
| Submitted / Pending | PENDING |
| Approved | APPROVED |
| Rejected | REJECTED |
| Paused | PAUSED |
| Failed (Gupshup-side failure, distinct from a content rejection) | REJECTED |
| Deactivated | DISABLED |
| anything unrecognized | PENDING (never dropped) |

### 8.2 Category

Gupshup's `MARKETING`/`UTILITY`/`AUTHENTICATION` map 1:1 onto WACRM's
`Marketing`/`Utility`/`Authentication`.

---

## 9. Consent & suppression

WACRM had **zero** opt-in/out tracking before this integration — for
either provider. The model (migration 040, `contacts.wa_marketing_status`
∈ `OPTED_IN | OPTED_OUT | UNKNOWN`) is fed by three independent, provider-
spanning signals, all converging on the same column:

1. **Gupshup's native `user-event`** webhook (§6.6).
2. **A system-default STOP keyword** (`inbound-pipeline.ts`'s
   `applyStopKeywordIfMatched`) — always on, both providers, no
   automation configuration required. Exact (trimmed, case-insensitive)
   whole-message match against `STOP`, `UNSUBSCRIBE`, `REMOVE`, `СТОП`,
   `ОТПИСКА`, `НЕ ПИШИТЕ`. Confirmed live: texting "стоп" from a real
   phone flipped the contact to `OPTED_OUT` with
   `wa_consent_source = 'stop_keyword'` immediately, before any
   automation dispatch.
3. **A user-configured keyword automation** (optional, additive) — the
   generic `update_contact_field` automation action now accepts
   `wa_marketing_status` as a target field, for accounts that want to
   extend the keyword list.

**Enforcement**: every path that can send a **Marketing**-category
template checks `wa_marketing_status != OPTED_OUT` server-side —
broadcast creation (`createBroadcast`), the dashboard broadcast route,
the resume/retry path, the manual composer send, the public
`/api/v1/messages` endpoint, and the automations engine's
`send_template` action (`src/lib/whatsapp/suppression.ts`). This is
**not** a UI-only filter and cannot be bypassed by calling the public
API or MCP directly (MCP only ever calls the public API, which enforces
it the same way).

Confirmed live: after opting a real test contact out via the STOP
keyword, (a) a subsequent conversational text reply still reached them
— opt-out blocks *marketing*, not the conversation — and (b) a real
`createBroadcast()` call with that contact in the recipient list
excluded them (`rejected: 1`) while a second, non-opted-out recipient
was planned normally (`planned.length: 1`).

Utility/Authentication templates are never blocked by this mechanism —
matching WhatsApp's own category semantics (an opted-out customer can
still receive an OTP or an order-status notification).

---

## 10. Broadcasts

One Broadcast Manager, not a Gupshup-specific one. Every send path
resolves the provider and calls `provider.sendTemplate(...)`:

- `src/lib/whatsapp/broadcast-core.ts` — `createBroadcast`/
  `deliverBroadcast`, backing `POST /api/v1/broadcasts` and the resume
  flow.
- `src/lib/whatsapp/broadcast-resume.ts` — "Resume"/"Retry failed" for
  an abandoned campaign; re-checks suppression at resume time too
  (a contact can opt out between the original send and a retry).
- `src/app/api/whatsapp/broadcast/route.ts` — the dashboard campaign
  wizard's per-batch server-side sender.

Per-recipient tracking (`pending→sent→delivered→read→replied`/`failed`,
aggregate counts via a DB trigger) is unchanged — driven by
`broadcast_recipients.whatsapp_message_id`, which is just "the
provider's message id" regardless of which provider sent it.

**Pre-existing, non-Gupshup-specific bug found and fixed during
testing**: `create_broadcast_with_recipients` (the atomic
broadcast-creation RPC, migration 037) raised "column reference
contact_id is ambiguous" against a real Postgres engine — invisible in
the unit suite because it mocks the `.rpc()` boundary. This affected
**every** account, Meta or Gupshup, creating a broadcast through the
public API. Fixed in migration 042 (table-qualifying the `RETURNING`
clause); no signature or caller change. If you're running an older
snapshot of this codebase, make sure migration 042 is applied before
relying on `POST /api/v1/broadcasts`.

**Confirmed live**: a real `createBroadcast()` + `deliverBroadcast()`
run against a live Gupshup app and a real WhatsApp phone, with a
two-recipient list where one was `OPTED_OUT` — the opted-out recipient
was excluded (`rejected: 1`), the eligible one was planned and
delivered. A second real broadcast with an approved template reached
`sent_count/delivered_count/read_count = 1/1/1` and `replied_count = 1`
after a genuine reply, all driven by real Gupshup webhooks landing on
the shared status-ladder code.

---

## 11. Live E2E verification checklist

Everything below was run against a real Gupshup app and a real
WhatsApp phone (tunneled to a local dev server via `cloudflared`), not
just unit-mocked. Use this checklist to re-verify after any change that
touches the provider layer, the inbound pipeline, or the broadcast
path — see `GUPSHUP_TEST_REPORT.md` for the full run log.

- [x] Settings → Gupshup: Test connection, Save, webhook URL generated
- [x] Webhook delivery reaches the app (format v2, Message + User events)
- [x] Inbound text message → lands in Shared Inbox with correct contact/conversation
- [x] Outbound text — full `sent → delivered → read` status ladder
- [x] Outbound image
- [x] Outbound document (PDF)
- [x] Outbound audio (small, direct, correctly-codec'd file)
- [x] Outbound video
- [x] Interactive quick-reply buttons — send + real tap → inbound reply with correct id
- [x] Interactive list — send + real tap → inbound reply with correct id
- [x] STOP keyword (system default, no automation configured) → `OPTED_OUT`
- [x] Conversational reply still reaches an opted-out contact (suppression is Marketing-only)
- [x] Broadcast creation with a mixed opted-out/eligible recipient list → correct exclusion
- [x] Template sync (real, Meta-approved template)
- [x] Template send (direct, `sendMessageToConversation`)
- [x] Broadcast with a real approved template → `sent/delivered/read` aggregate counts correct
- [x] Broadcast reply tracking → `replied_count` advances on a real reply
- [ ] Automations/Flows/AI live-fire against the Gupshup number — code path shared with Meta, not independently live-fired (no automation/flow/AI configured on the test account)
- [ ] Media-header template send — wire format implemented + unit-tested, not live-tested (test template was text-only)
- [ ] Meta-side regression walkthrough (same checklist, Meta-connected account) — needs separate Meta test credentials

## 12. Known limitations

1. Template create/edit/delete via WACRM's UI is Meta-only (§7).
2. Gupshup template sync doesn't recover header/footer/button structure
   (§7).
3. `listTemplates()` doesn't page through Gupshup's template list (no
   `pageNo`/`pageSize` looping) — fine for a normal-sized catalog, add
   paging if an account's template count grows large enough to be
   truncated.
4. No Gupshup-specific rate-limit tuning — broadcast concurrency uses
   the same pacing as Meta; watch for 429s in production.
5. Gupshup template-status-changed webhook notifications (if Gupshup
   sends them) aren't specifically handled — re-sync manually to see
   status changes until this is added. Unrecognized event types are
   logged (`unsupported_provider_event`), never silently dropped.
6. No inbound reaction normalization for Gupshup — no reaction event
   type is documented for Gupshup inbound messages.
7. `location`, `contact`, and non-text quoted-reply inbound payload
   shapes are inferred by symmetry with confirmed types, not
   independently live-tested (see the "Confirmed" column in §6.4).
8. Media source reliability — see §5.1's note on media fetching. Prefer
   small, direct, correctly-codec'd files.

---

## 13. Provider switching & rollback

Settings → WhatsApp → the provider selector, with a confirmation
("existing history stays, future messages use the new provider"). A
switch only ever flips `whatsapp_config.provider` — neither provider's
credentials are deleted, so switching back needs no re-entry. No
conversation, message, template, or broadcast data is touched by a
switch.

Rolling back the code itself is a normal git revert; the migrations
(040–042) only add nullable columns and relax two NOT NULL constraints
— every pre-existing row already satisfies the new constraints via
`provider` defaulting to `'meta'`. No down-migration is needed to
restore Meta-only behavior.

---

## 14. Quick troubleshooting index

| Symptom | Likely cause | Where to look |
|---|---|---|
| "Test connection" fails | Wrong API key/App ID, or app not yet fully provisioned on Gupshup's side | §6.4 response shape; confirm via a direct `curl` to `/app/{app_id}/business` |
| Webhook never fires | URL not public (need a tunnel in dev), wrong token, format v2 not selected, Message/User events not enabled | §6.1–6.2 |
| Inbound message lands but Flow/automation never routes on a button/list tap | Reading `id` instead of `postbackText` — should already be fixed in this codebase, but if you're on an old snapshot, this is the fix | §6.4 |
| Outbound send returns "submitted" but never arrives | Check the async `message-event` webhook for a `failed` status + reason code; 1008 = destination not opted-in/active (Gupshup-side, not code) | §6.5 |
| Outbound media never arrives despite a valid, reachable URL | Try a smaller, direct (non-redirecting), correctly-codec'd file; audio specifically needs OGG/Opus | §5.1 |
| Template sync inserts nothing / errors | Confirm `message_templates.provider` column exists (migration 041) | §7 |
| Broadcast creation 500s | Confirm migration 042 is applied | §10 |
| A contact keeps receiving marketing broadcasts after saying STOP | Confirm the message was an *exact* match on a configured keyword (§9) — a sentence merely containing the word doesn't trigger it by design |
