# Gupshup Integration

Gupshup is a first-class WhatsApp provider in WACRM, alongside the
existing Meta Cloud API integration. Neither replaces the other —
Settings → WhatsApp lets each account pick one; both keep working in
parallel across different accounts on the same install, and an
account can switch between them without losing any history.

See also: [`GUPSHUP_INTEGRATION_AUDIT.md`](./GUPSHUP_INTEGRATION_AUDIT.md)
(the pre-implementation coupling audit) and
[`GUPSHUP_TEST_REPORT.md`](./GUPSHUP_TEST_REPORT.md) (what's been
verified and how).

## Architecture

```
WACRM business logic (send-message.ts, broadcast-core.ts,
automations/meta-send.ts, flows/meta-send.ts, the config/template
routes, the shared inbound pipeline)
              │
              ▼
   resolveWhatsAppProvider(config)
              │
      ┌───────┴───────┐
      ▼               ▼
createMetaProvider   createGupshupProvider
(meta-api.ts,        (gupshup-client.ts,
 unchanged)           new)
```

- **`src/lib/whatsapp/providers/types.ts`** — the `WhatsAppProvider`
  interface every provider implements: `testConnection`, `sendText`,
  `sendMedia`, `sendTemplate`, `sendInteractive`, `listTemplates`, and
  the optional Meta-only `register`/`submitTemplate`/`editTemplate`/
  `deleteTemplate`. `SendResult` keeps the `{ messageId }` shape
  `meta-api.ts` always used, since that's also the public API's
  `whatsapp_message_id` field under the hood — no renaming, no broken
  callers.
- **`src/lib/whatsapp/providers/resolve.ts`** — `resolveWhatsAppProvider(config)`,
  the single place that reads `whatsapp_config.provider` and returns a
  ready-to-use provider. Every call site (send-message.ts,
  broadcast-core.ts, the automations/flows senders, the broadcast and
  config/template routes) calls this instead of importing `meta-api.ts`
  or a Gupshup client directly.
- **`src/lib/whatsapp/providers/meta-provider.ts`** — thin wrapper over
  the existing `meta-api.ts`. Zero behavior change; the Meta wire
  protocol is untouched.
- **`src/lib/whatsapp/providers/gupshup-client.ts`** /
  **`gupshup-provider.ts`** — the Gupshup implementation (below).
- **`src/lib/whatsapp/inbound-pipeline.ts`** — the shared inbound core
  (contact/conversation resolution, idempotent insert, status ladder,
  flows/automations/AI dispatch, outbound webhooks) extracted out of
  the Meta webhook route so a second provider's webhook can drive the
  exact same CRM pipeline instead of a second copy of it. Meta's route
  (`src/app/api/whatsapp/webhook/route.ts`) and Gupshup's route
  (`src/app/api/whatsapp/gupshup/webhook/[token]/route.ts`) each own
  only their provider-specific "verify + parse" step, then hand a
  normalized event to this shared module.

## Database

Migration `supabase/migrations/040_gupshup_provider.sql`:

- `whatsapp_config.provider` (`'meta' | 'gupshup'`, default `'meta'` —
  every existing row keeps working with zero migration effort).
- Gupshup credential columns on the **same row**:
  `gupshup_api_key` (encrypted, same AES-256-GCM as `access_token`),
  `gupshup_app_id`, `gupshup_app_name`, `gupshup_source_phone_number`,
  `gupshup_connected_at`, `gupshup_webhook_token`.
- `phone_number_id` / `access_token` are now nullable (a Gupshup-only
  account has neither) — a `CHECK` constraint enforces that whichever
  provider is *active* has its own credentials present.
- **One row per account, either provider** — switching providers
  flips `whatsapp_config.provider`; both credential sets stay on the
  row, so switching back to Meta needs no re-entry. This is why
  Settings shows a confirmation ("future messages will use X") rather
  than a destructive re-setup flow.
- `message_templates.gupshup_template_id` — parallel to
  `meta_template_id`, so template rows can come from either provider.
- `contacts.wa_marketing_status` / `wa_opt_in_at` / `wa_opt_out_at` /
  `wa_consent_source` — provider-independent consent state. WACRM had
  **no** opt-in/out tracking before this migration, for either
  provider — this is net-new, not a migrated Meta concept.

## Gupshup API endpoints used

All confirmed against Gupshup's official docs (docs.gupshup.io) while
building this integration:

| Purpose | Endpoint |
|---|---|
| Session (free-form) message | `POST https://api.gupshup.io/wa/api/v1/msg` (form-urlencoded, `apikey` header) |
| Template message | `POST https://api.gupshup.io/wa/api/v1/template/msg` |
| List templates | `GET https://api.gupshup.io/wa/app/{app_id}/template` |
| Business details (connection test) | `GET https://api.gupshup.io/wa/app/{app_id}/business` |

Docs pages consulted: `reference/session-text-message`,
`reference/post_wa-api-v1-msg-{1,3,4,5,6,7,8,9}` (list/image/video/
document/audio/sticker/reaction/location), `reference/quick-replies`,
`reference/sending-text-template`, `reference/sending-image-template`,
`reference/get-all-templates-for-an-app`, `reference/get-business-details`,
`docs/webhooks-2`, `docs/message-events`, `docs/what-is-an-inbound-message`,
`docs/user-event`, `docs/set-webhookcallback-url`,
`docs/message-template-approvals-statuses`.

**Note on inbound field mapping**: Gupshup's public docs don't publish a
field-by-field breakdown of the inner `payload.payload` object for each
*inbound* message type the way they do for sends. This integration's
mapping (`src/lib/whatsapp/providers/gupshup-webhook.ts`) was corrected
against a **real Gupshup sandbox app** during the E2E pass — see
`GUPSHUP_TEST_REPORT.md` for the exact live-captured payloads. Two real
discrepancies from the initial docs-based guess were found and fixed
this way:
- `GET /wa/app/{app_id}/business` nests everything under a `business`
  key (`{status, business: {name, ...}}`), not flat as the docs example
  suggested.
- A tapped button/list option's stable id comes back in **`postbackText`**,
  not `id` (`id` is always an empty string in practice) — this is what
  the Flows engine and the `interactive_reply` automation trigger route
  on, so it had to be exactly right.
Text/image/video/document/audio sends and their inbound delivery-status
ladder (sent→delivered→read, and the out-of-order-safe `failed` guard)
are all confirmed against live sends in that same pass. Template send
and broadcast delivery are implemented and confirmed with a locally-
authored test template + template + broadcast wiring; sending
an actual Gupshup-*approved* template end-to-end still needs the
account to have one approved (see "Limitations" below).

## Setup

1. **Settings → WhatsApp** → select **Gupshup**.
2. Fill in:
   - **Gupshup API Key** — from your Gupshup account.
   - **Gupshup App ID** — the WhatsApp app's id in your Gupshup
     dashboard.
   - **Gupshup App Name** — sent as `src.name` on every send; used by
     Gupshup for routing/analytics.
   - **WhatsApp Source Number** — your approved sending number, digits
     only.
3. Click **Test connection** — this calls `GET /wa/app/{app_id}/business`
   server-side with the values currently in the form (never persisted
   until you click Save). A failure here means the credentials don't
   work; fix them before saving.
4. Click **Save Configuration**. WACRM re-verifies, encrypts the API
   key, and generates a random webhook token if this is the first
   Gupshup save for this account.
5. Copy the **Webhook URL** shown (`/api/whatsapp/gupshup/webhook/<token>`)
   into your Gupshup app's **Dashboard → Webhooks → Callback URL**, and
   enable **Message events** and **User events** there (Gupshup's own
   dashboard checkbox — WACRM cannot set this via API; there is no such
   endpoint in Gupshup's public docs).
6. Go to **Settings → WhatsApp Templates → Sync from Gupshup** to pull
   in your approved templates.

## Templates

- **Sync** (`POST /api/whatsapp/templates/sync`) works for both
  providers — it resolves the account's provider and calls
  `listTemplates()`, which returns a normalized shape either way.
  Gupshup's list endpoint is flatter than Meta's: it returns the
  rendered body (`data`, with `{{n}}` placeholders) but not a
  structured header/footer/buttons breakdown, so those fields stay
  empty on Gupshup-synced rows. Category and status are normalized
  into the same enum Meta rows use (`gupshup-status-map.ts`).
- **Send** works uniformly through `provider.sendTemplate(...)` —
  the broadcast wizard, `/api/v1/messages`, `/api/v1/broadcasts`, and
  automations/flows never need to know which provider a template came
  from. A media-header template (image/video/document) attaches the
  media via a separate `message` object on the Gupshup wire call
  (`gupshup-provider.ts`'s `buildTemplateMediaMessage`), mirroring how
  Meta requires a header component on every send.
- **Create / edit / delete via WACRM's UI is not implemented for
  Gupshup** in this integration (documented limitation — see
  "Limitations" below). Manage templates in the Gupshup dashboard, then
  **Sync from Gupshup** to pull the current state in. Meta's full
  create/edit/delete flow is untouched.

## Broadcasts

Every broadcast send path resolves the provider and calls
`provider.sendTemplate(...)` — there is one Broadcast Manager, not a
Gupshup-specific one:

- `src/lib/whatsapp/broadcast-core.ts` (`createBroadcast`/
  `deliverBroadcast`) — backs `/api/v1/broadcasts` and the resume flow.
- `src/lib/whatsapp/broadcast-resume.ts` — the "Resume"/"Retry failed"
  recovery path for an abandoned campaign.
- `src/app/api/whatsapp/broadcast/route.ts` — the dashboard campaign
  wizard's own per-batch server-side sender (`src/hooks/use-broadcast-sending.ts`
  drives the batching from the browser tab, same as before; only the
  server-side send call changed).

Per-recipient tracking (`pending`/`sent`/`delivered`/`read`/`replied`/
`failed`, aggregate counts via the existing DB trigger) is unchanged —
it's driven by `broadcast_recipients.whatsapp_message_id`, which is
just "the provider's message id" for either provider.

**Hard suppression**: every one of the paths above checks
`contacts.wa_marketing_status != 'OPTED_OUT'` before a recipient is
enqueued (`createBroadcast`) or sent (the dashboard route), server-side
— not a UI filter. A resume pass re-checks it too, since a contact can
opt out between the original send and a retry. This applies uniformly
regardless of whether the broadcast was started from the dashboard,
`/api/v1/broadcasts`, or MCP (which calls the same public endpoint).

## Opt-in / opt-out

Three independent signals feed the same `contacts.wa_marketing_status`
column:

1. **Gupshup's native `user-event` webhook** (`opted-in`/`opted-out`) —
   handled in the Gupshup webhook route, matched by the digits-only
   `phone_normalized` column.
2. **A system-default STOP keyword** (`inbound-pipeline.ts`'s
   `applyStopKeywordIfMatched`) — always on, for both providers, not
   dependent on any automation being configured. An exact (trimmed,
   case-insensitive) match of the *whole* inbound message against
   `STOP`, `UNSUBSCRIBE`, `REMOVE`, `СТОП`, `ОТПИСКА`, `НЕ ПИШИТЕ`
   flips the contact to `OPTED_OUT` immediately, before flows/
   automations dispatch. Matched on the whole message (not a
   substring) so a sentence that merely contains one of these words
   doesn't false-positive.
3. **A user-configured keyword automation** (optional, additive) —
   `update_contact_field` also accepts `wa_marketing_status` as a
   target field, so an account can extend the keyword list beyond the
   system default via a normal `keyword_match` automation if they want
   different/additional phrases.

All three converge on the same enforcement point — there's one
suppression mechanism, not several. Suppression itself is enforced in
every path that can send a **Marketing**-category template (broadcasts
via `broadcast-core.ts`/the dashboard route/`broadcast-resume.ts`, the
manual composer and public API via `send-message.ts`, and the
automations engine's `send_template` action via
`automations/meta-send.ts`) — see `src/lib/whatsapp/suppression.ts`.
Utility/Authentication templates and free-form conversational replies
are unaffected: opting out of marketing doesn't cut off an active
support conversation, matching WhatsApp's own category semantics.

The system-default STOP keyword and the suppression enforcement both
apply identically to Meta accounts — neither is Gupshup-specific.

## Webhook security

Gupshup's callback has **no HMAC signature** the way Meta's
`x-hub-signature-256` does — confirmed against Gupshup's own docs
(`docs/set-webhookcallback-url`, `docs/webhooks-2`): the webhook URL is
pasted into their dashboard with no signing mechanism offered at all.
This is a real, documented limitation, not something this integration
papers over. The mitigations in place:

1. An unguessable, per-account, random 24-byte token in the URL path
   itself (`/api/whatsapp/gupshup/webhook/<token>`) — generated once on
   first save, never re-shown or logged after that.
2. A rate limit keyed to that token (`RATE_LIMITS.gupshupWebhook`).
3. Strict envelope validation (`isValidGupshupEnvelope`) before any DB
   write — malformed payloads are rejected with a 400 before touching
   the database.
4. A lookup miss (unknown/wrong token) returns the same 404 as any
   other not-found path — the endpoint never confirms whether a given
   token exists.

If an operator suspects their token leaked, disconnect and reconnect
Gupshup in Settings to generate a new one, then update the callback URL
in the Gupshup dashboard.

## Testing

- **Unit tests** (mocked HTTP, no network): `gupshup-client.test.ts`
  (send/template/list/business-details, error-code mapping),
  `gupshup-provider.test.ts` (message-type building, template-media
  attachment, missing-`gupshup_template_id` guard), `gupshup-status-map.test.ts`
  (delivery-status + template-status vocabularies), `gupshup-webhook.test.ts`
  (envelope validation, inbound message/status/user-event normalization),
  `resolve.test.ts` (provider selection, backward compatibility,
  no-cross-provider-leakage), `inbound-pipeline.test.ts`
  (status-ladder transitions, out-of-order guard).
- **Regression**: the full existing suite (830+ tests) passes unchanged
  after every Meta call site was rewired to `resolveWhatsAppProvider` —
  see `GUPSHUP_TEST_REPORT.md` for the exact run.
- **Real Gupshup sandbox E2E**: see `GUPSHUP_TEST_REPORT.md` for what
  was/wasn't run against a live Gupshup app and why.

## Provider switching

Settings → WhatsApp → the provider selector. Switching shows a
confirmation ("existing history stays, future messages use the new
provider") and only ever flips the `provider` column — neither
provider's saved credentials are deleted, so switching back needs no
re-entry. Nothing about conversations, messages, templates, or
broadcasts is touched by a switch.

## Rollback

- **Code**: this is a normal feature branch; reverting is a normal git
  revert. No code path is deleted or altered destructively for Meta.
- **Migration**: `040_gupshup_provider.sql` only adds nullable columns
  and relaxes two NOT NULL constraints (both are backward compatible —
  every existing row already satisfies the new CHECK constraint via
  `provider` defaulting to `'meta'` with its existing Meta columns
  populated). No down-migration is needed to restore Meta-only
  behavior; simply never set `provider = 'gupshup'` on a row.
- **Provider setting**: switch any account back to `provider = 'meta'`
  in Settings at any time — no data loss, per "Provider switching"
  above.
- **Before a production migration**: take a database backup regardless
  (standard practice for any migration, not specific to this one).

## Limitations / follow-ups before a production Gupshup WABA

1. **Template create/edit/delete via WACRM UI is Meta-only.** Manage
   Gupshup templates in Gupshup's own dashboard; sync pulls them in.
2. **Gupshup template sync doesn't recover header/footer/button
   structure** (Gupshup's list endpoint doesn't return it) — a synced
   Gupshup template's header/footer/buttons stay empty locally even if
   the template has them on Gupshup's side. Body text and variables
   sync correctly. Not yet re-verified against a real *approved*
   Gupshup template (the sandbox account used for E2E testing had none
   at the time — see `GUPSHUP_TEST_REPORT.md`); the template-send wire
   format itself (`template.id` + `params`, optional media `message`
   object) is implemented per Gupshup's docs and unit-tested, but a
   real end-to-end template send is still pending an approved template.
3. **No per-provider rate-limit tuning** — Gupshup's own send-rate
   limits weren't independently documented in the pages consulted;
   broadcast concurrency uses the same pacing as Meta. Watch for 429s
   in production and tune `RATE_LIMITS`/broadcast batch pacing if
   needed.
4. **Template webhook events** (Gupshup template-status-changed
   notifications, if Gupshup sends them) are not specifically handled —
   only `message`, `message-event`, and `user-event` are. An
   unrecognized event type is logged (`unsupported_provider_event`),
   never silently dropped, so this is safe but incomplete; re-sync
   manually to see status changes until this is added.
5. **Reactions are not normalized for Gupshup inbound** — no inbound
   reaction event type is documented for Gupshup in the pages
   consulted; this is a no-op today rather than a guess.
6. **Outbound media source reliability**: Gupshup's own media fetcher
   is pickier than a generic HTTP client about the source URL — during
   E2E testing, two different (genuinely reachable, correctly
   `Content-Type`d) audio URLs failed while a third, smaller, direct
   (no-redirect) one worked; a non-Opus-codec OGG file also failed
   outright (WhatsApp's own audio spec requires OGG/Opus specifically,
   not just any OGG). Text, image, video, and document sends were
   reliable with any correctly-typed public URL tried. If an outbound
   media send fails, try a smaller file behind a direct (non-redirecting)
   URL before assuming a code issue.

Everything above item 6 was found and fixed (not just documented) during
a real Gupshup sandbox E2E pass — see `GUPSHUP_TEST_REPORT.md` for the
full list of what was sent/received and the two real bugs it caught
(the `business` response-nesting and the `postbackText` field for
tapped interactive options).
