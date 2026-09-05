# Gupshup Integration — Meta Coupling Audit

Read-only architecture audit performed before writing any Gupshup provider
code, per the project's own rule: "don't assume the structure — read the
real code first." Covers every place the codebase currently talks to Meta
directly, or otherwise assumes "WhatsApp == Meta Cloud API."

Highest existing migration at audit time: `039_inbound_media_mirror.sql` →
new Gupshup migrations start at **`040_`**.

## How to read this document

For each call site: **file / function**, **current Meta dependency**, **how
it becomes provider-agnostic**. The summary table at the bottom is the
actual work list — everything else here is supporting detail.

---

## 1. `src/lib/whatsapp/meta-api.ts` — the entire Meta wire protocol

Every exported function is a raw `fetch()` against
`https://graph.facebook.com/v21.0` (`META_API_BASE`) with Meta's envelope
(`messaging_product: 'whatsapp'`), Meta auth (`Authorization: Bearer
<token>`), and Meta response parsing (`data.messages[0].id`,
`data.error.message`).

| Function | Meta-specific behavior | Provider-agnostic target |
|---|---|---|
| `verifyPhoneNumber` | `GET /{phoneNumberId}?fields=...` | `provider.testConnection()` |
| `registerPhoneNumber` | `/register` + 6-digit 2FA PIN | `provider.register?()` — optional, Meta-only |
| `subscribeWabaToApp` / `getSubscribedApps` | Meta app-webhook subscription model | no Gupshup analog; not part of the common interface |
| `sendTextMessage` | `type:'text'`, `context.message_id` for replies | `provider.sendText(...)` |
| `sendMediaMessage` | media envelope per kind, audio has no caption | `provider.sendMedia(...)` |
| `sendTemplateMessage` | `template.language.code`, `template.components[]` via `buildSendComponents` | `provider.sendTemplate(...)` |
| `uploadResumableMedia` | Meta's app-scoped 2-step Resumable Upload → `header_handle` | `provider.uploadTemplateMedia?()` — optional, Gupshup has no equivalent handle concept |
| `submitMessageTemplate` / `editMessageTemplate` / `deleteMessageTemplate` | Meta's template CRUD, `hsm_id` semantics | `provider.submitTemplate/editTemplate/deleteTemplate(...)` |
| `sendReactionMessage` | `type:'reaction'` | `provider.sendReaction?()` — optional |
| `sendInteractiveButtons` / `sendInteractiveList` + `INTERACTIVE_LIMITS` | Meta's interactive envelopes + Meta's hard-coded UI limits (3 buttons, 20-char titles) | `provider.sendInteractive(...)`; limits become per-provider config |
| `getMediaUrl` / `downloadMedia` | 2-step resolve-id → short-lived CDN URL → Bearer download | `provider.resolveInboundMedia(mediaId)` — Gupshup typically embeds a direct URL in the webhook payload, so this may collapse to one fetch |

**Cross-cutting:** every function takes `phoneNumberId` — doesn't exist for
Gupshup (app/source-number keyed instead). `throwMetaError` parses Meta's
`{error:{message}}` shape; Gupshup needs its own parser. `MetaSendResult {
messageId }` is a good seam — keep this exact shape as the common
`SendResult` so callers don't change.

---

## 2. `src/app/api/whatsapp/webhook/route.ts` — inbound webhook handler

- **Signature verification**: `x-hub-signature-256` header + HMAC-SHA256
  over `META_APP_SECRET` (see §13). Gupshup has no equivalent header.
- **Payload shape**: Meta's nested `entry[].changes[].value.{messages[],
  statuses[],contacts[]}`; `metadata.phone_number_id` looks up the owning
  `whatsapp_config` row. Gupshup's payload is flat (`{type, payload}` per
  event), no `entry/changes` nesting — needs its own parser.
- **Verification handshake** (`GET`): Meta's `hub.mode`/`hub.challenge`/
  `hub.verify_token` — Facebook-specific, no Gupshup equivalent (webhook
  URL is registered once in the Gupshup portal, no challenge/echo).
- **Template lifecycle events**: Meta's `message_template_status_update`
  etc. `change.field` values, delegated to `template-webhook.ts`.
- **Status ladder**: consumes Meta's `status.status` strings
  (`sent|delivered|read|failed`) directly as DB values — needs Gupshup
  event-vocabulary normalization into the same ladder before writing.
- **Media handling**: Meta's id-based two-step resolve+download; Gupshup
  typically embeds a directly-fetchable URL.
- **Contact/conversation resolution and downstream fan-out**
  (`processMessage` — flows, automations, AI auto-reply, outbound webhook
  dispatch) is **already provider-agnostic**; it only needs a normalized
  `{from, timestamp, type, text/media/interactive}` shape as input.

**How it becomes provider-agnostic:** split into (a) a per-provider
"verify + parse" step (`provider.verifyWebhook()`, `provider.normalizeInbound()`
/ `provider.normalizeMessageEvent()`) that each provider module owns, and
(b) keep `processWebhook`/`processMessage`/`handleStatusUpdate` as the
shared core operating on the normalized shape. The route needs to resolve
*which* config/provider an inbound POST belongs to — Meta uses
`phone_number_id` from the payload; Gupshup webhooks carry their own
app/source-number identifier, looked up the same way.

---

## 3. `src/lib/whatsapp/resolve-conversation.ts` — already provider-agnostic

Only touches `sanitizePhoneForMeta`/`isValidE164` (Meta-flavored *names*,
provider-neutral logic) and `whatsapp_config` lookup by `account_id`. No
structural change needed — just a clarity rename
(`sanitizePhoneForMeta` → `sanitizePhoneE164`). This module is the template
for how little *should* change in the contact/conversation layer.

---

## 4. Broadcast subsystem

- **`broadcast-core.ts`**: `createBroadcast` is provider-neutral until it
  hits `resolveTemplateRow` (Meta-shaped row, §5). `deliverBroadcast` calls
  **`sendTemplateMessage` from `meta-api.ts` directly** — a direct Meta
  call site bypassing `send-message.ts`. Also uses
  `isRecipientNotAllowedError` (Meta error-code `131030` sniffing) to
  decide phone-variant retry.
- **`broadcast-resume.ts`**: rebuilds the same Meta-shaped
  `phoneNumberId`/`accessToken` plan fields — needs the identical fix in
  lockstep.
- **`api/whatsapp/broadcast/route.ts`** and **`broadcast/[id]/resume/route.ts`**:
  thin wrappers, no direct Meta calls — inherit the fix.
- **Dashboard campaign wizard**: per `broadcast-resume.ts`'s own header
  comment, the dashboard wizard drives its send loop **from the browser
  tab**, independent of `broadcast-core.ts` (which backs the public v1 API
  + resume/recovery flow only). This is a **second send path** that must
  be located and fixed — flagged as a follow-up verification item before
  broadcasts are considered done, not missed in the coupling map.

**Fix:** replace the direct `sendTemplateMessage` import/call with
`resolveWhatsAppProvider(config).sendTemplate(...)`; the `BroadcastPlan`'s
`phoneNumberId`/`accessToken` fields become a generic provider-credentials
bag (or the plan carries the resolved provider instance itself).

---

## 5. Template sync/lifecycle

**Local schema** (`message_templates`, migration 001 + 014's Meta bolt-on):
`id, account_id, user_id, name, category, language, header_type,
header_content, header_handle, header_media_url, body_text, footer_text,
buttons(JSONB), sample_values(JSONB), status(Meta's raw enum:
DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED|IN_APPEAL|PENDING_DELETION),
meta_template_id, rejection_reason, quality_score(GREEN/YELLOW/RED),
submission_error, last_submitted_at`. The `status` enum is literally Meta's
vocabulary — unlikely to line up with Gupshup's.

- **`templates/sync/route.ts`**: a **second, independent** Meta REST client
  (own `META_API_VERSION`/`META_API_BASE` constants, doesn't reuse
  `meta-api.ts`) hitting `GET /{wabaId}/message_templates` directly, parsing
  Meta's component array via `parseButtons`/`extractSampleValues`. →
  `resolveWhatsAppProvider(config).listTemplates()` returning a normalized
  shape; Meta-parsing logic moves into the Meta provider module.
- **`templates/submit/route.ts`**: calls `submitMessageTemplate` +
  `ensureImageHeaderHandle` (Resumable Upload, Meta-only) +
  `buildMetaTemplatePayload`. Explicitly rejects `Authentication` category
  with Meta-specific UX copy. → `resolveWhatsAppProvider(config).submitTemplate()`;
  `ensureImageHeaderHandle` becomes a Meta-only pre-step inside the Meta
  module.
- **`templates/[id]/route.ts`**: `PATCH`/`DELETE` call
  `editMessageTemplate`/`deleteMessageTemplate` directly, encoding Meta's
  "replace-wholesale" edit + `hsm_id` delete semantics and Meta's
  editable-status/edit-count/cooldown rules. → provider-branched
  edit/delete; Gupshup needs its own lifecycle rules (or the UI becomes
  provider-aware about what's editable).
- **`template-lifecycle.test.ts`** actually tests `meta-api.ts` directly —
  no separate `template-lifecycle.ts` module exists (misleading filename;
  don't hunt for a Gupshup equivalent of a module that isn't there).
- **`template-send-builder.ts`** (`buildSendComponents`): builds Meta's
  `components[]` from a template row + params — needs a Gupshup sibling
  (Gupshup's template substitution is typically a flat ordered `params`
  array, no `components` concept).
- **`template-components.ts`** (`buildMetaTemplatePayload`): explicitly
  Meta-branded name/type — needs a `buildGupshupTemplatePayload` sibling.
- **`template-status-normalize.ts`** (`normalizeStatus`): the target enum
  **is** Meta's enum — Gupshup needs its own normalization branch, and
  `MessageTemplateStatus` may need widening.
- **`template-row-guard.ts`**: pure shape-guard on the local row, already
  provider-agnostic.
- **`template-webhook.ts`**: handles Meta's three `field` values
  (`message_template_status_update`, `_quality_update`,
  `_components_update`) with Meta-specific value shapes — Gupshup template
  events (if any) need a parallel handler, dispatched once the webhook
  route knows which provider owns the inbound POST.

**Schema recommendation:** either a generic `provider` +
`provider_template_id` column pair, or a parallel nullable
`gupshup_template_id` column next to `meta_template_id`, plus a `provider`
column on `message_templates` so sync/submit/edit/delete routes know which
client to invoke per row.

---

## 6. `src/lib/automations/**` — "Send Message" automation action

**Not routed through `send-message.ts`.** The engine's `runStep()` cases
(`send_message`, `send_buttons`/`send_list`, `send_template`) call
`engineSendText`/`engineSendInteractive`/`engineSendTemplate` from
**`src/lib/automations/meta-send.ts`** — a hand-rolled sender (own contact/
config lookup, own phone-variant retry, own `messages` insert) that
duplicates `send-message.ts`'s logic. The file's own header comment
documents this as a deliberate near-duplicate "to avoid risk to the
working manual-send path." It imports `sendTextMessage`/
`sendTemplateMessage` from `meta-api.ts` directly, and delegates interactive
sends to `flows/meta-send.ts`.

**Fix (lower-risk, chosen approach):** swap the direct `meta-api.ts`
imports in `automations/meta-send.ts` for
`resolveWhatsAppProvider(config).sendText/sendTemplate(...)`. Collapsing
this file into `send-message.ts` entirely is flagged as pre-existing tech
debt, out of scope for this project.

---

## 7. `src/lib/flows/**` — "Send WhatsApp" flow node execution

**`src/lib/flows/meta-send.ts`** is a second hand-rolled sender —
`engineSendText`, `engineSendMedia`, `engineSendInteractiveButtons`,
`engineSendInteractiveList` — same duplicated pattern as §6, importing
`meta-api.ts` directly. `flows/engine.ts`'s node dispatch (`send_message`,
`send_media`, interactive nodes) routes entirely through this file, never
through `send-message.ts`.

**High-leverage fix:** `flows/meta-send.ts` is imported by *three*
consumers — the Flows engine itself, part of `automations/meta-send.ts`
(interactive sends), and `ai/auto-reply.ts` (§8). Fixing this one file's
imports to go through `resolveWhatsAppProvider(...)` fixes flows, part of
automations, and AI auto-reply simultaneously.

`src/app/api/flows/**` (CRUD + cron-trigger plumbing) has no direct Meta
calls — sending happens entirely inside `flows/engine.ts` →
`flows/meta-send.ts`.

---

## 8. AI Reply Assistant / auto-reply / handoff

- **`src/lib/ai/auto-reply.ts`**: `dispatchInboundToAiReply` calls
  `engineSendText` imported **from `@/lib/flows/meta-send.ts`** — confirmed
  direct dependency on the Flows sender. Everything else (config load,
  rate limiting, knowledge retrieval, handoff-summary building,
  `claim_ai_reply_slot` RPC for per-conversation cap) is provider-agnostic
  already.
- **`src/lib/ai/handoff.ts`**: only builds a text summary — sends nothing,
  no Meta coupling.

**Fix:** none needed directly — inherits the §7 fix for free once
`flows/meta-send.ts` is provider-abstract. Per-conversation cap and human
handoff semantics are untouched by the provider swap.

---

## 9. `src/app/api/v1/**` — public REST API

- **`POST /api/v1/messages`**: cleanly reuses `resolveConversationByPhone`
  + `sendMessageToConversation` from `send-message.ts` — **already goes
  through the shared core**, becomes provider-agnostic automatically once
  `send-message.ts` is fixed.
- **`POST /api/v1/broadcasts` + `[id]`**: HTTP wrapper around
  `broadcast-core.ts` — inherits that fix.
- **Naming note:** the response field `whatsapp_message_id` (also
  `SendMessageResult.whatsappMessageId`, `broadcast_recipients.whatsapp_message_id`,
  every `engineSend*` return value) is provider-agnostic *in meaning* (just
  "the provider's message id") but Meta-flavored in name. **Recommendation:
  keep the field name as-is** — renaming breaks every existing API consumer
  and MCP tool caller; document it as "the provider's message id" instead.
- Contacts/conversations/`me`/outbound-webhooks endpoints: no Meta coupling,
  out of scope.

**Conclusion:** the public API contract does not need to change shape at
all — the provider distinction is entirely a `whatsapp_config`-level
concern, invisible to API consumers.

---

## 10. `mcp-server/` — MCP tools

Talks to the app **exclusively over HTTP to `/api/v1/*`**, never touching
the DB directly (`WacrmClient.request()` builds `${baseUrl}/api/v1${path}`).
`send_message` tool → `POST /messages`; broadcast tool → `POST /broadcasts`.
**No code changes needed at all** — it's fully decoupled from Meta already.
Only follow-up: the `send_message` tool's Zod-schema description text says
"send an approved template" in Meta-flavored language and should be
reworded to be provider-neutral once Gupshup templates are reachable
through the same endpoint (cosmetic only).

---

## 11. `src/app/(dashboard)/settings/**` — WhatsApp settings UI

- `settings/page.tsx` renders `<WhatsAppConfig />` as the `whatsapp` tab's
  panel — the slot where a provider selector goes.
- `components/settings/whatsapp-config.tsx` (921 lines): entirely
  Meta-shaped form state (`phoneNumberId`, `wabaId`, `accessToken`,
  `verifyToken`, `pin`), a webhook URL computed as
  `${origin}/api/whatsapp/webhook` (single shared path — Gupshup gets its
  own `/api/whatsapp/gupshup/webhook`), calls `GET/POST/DELETE
  /api/whatsapp/config`, and Meta-only UX (`registered_at` 2FA banner,
  "Verify Registration" probe).

**Fix:** add a `provider: 'meta' | 'gupshup'` selector that swaps the
rendered field set while sharing the surrounding save/test/reset chrome.
`/api/whatsapp/config`'s POST handler needs the same provider branch —
currently hard-codes `verifyPhoneNumber`/`registerPhoneNumber`/
`subscribeWabaToApp` and Meta-required fields.

---

## 12. `src/lib/dashboard/**` — statistics

Grepped exhaustively (`meta|Meta|whatsapp_config|phone_number_id`) — **zero
matches**. No provider coupling in the dashboard-stats layer.

---

## 13. Webhook signature verification — `src/lib/whatsapp/webhook-signature.ts`

`verifyMetaWebhookSignature` computes `'sha256=' + HMAC-SHA256(secret=
META_APP_SECRET, message=rawBody)` and compares against `x-hub-signature-256`
via `crypto.timingSafeEqual`. **Fails closed** if `META_APP_SECRET` is
unset (rejects everything) — this safety property must be preserved for
Meta.

**Gupshup has no equivalent HMAC header** per its public docs — webhook
verification there is either a shared-secret in the URL path, or nothing
beyond obscurity. This must not be silently papered over: the shared
webhook route needs `provider.verifyWebhook(rawBody, headers, config)` per
provider — Meta keeps today's fail-closed HMAC check; Gupshup gets a
documented, explicit limitation (secret path token + rate limiting +
strict payload validation, not a fabricated signature scheme).

---

## 14. Schema inventory (`supabase/migrations/*.sql`)

**`whatsapp_config`** (001, evolved 013/015/017/039): `id, user_id,
phone_number_id, waba_id, access_token, verify_token, status, connected_at,
account_id (017, UNIQUE, NOT NULL), registered_at, subscribed_apps_at,
last_registration_error, mirror_inbound_media`. Constraints:
`UNIQUE(phone_number_id)` globally, `UNIQUE(account_id)` — **the
account_id uniqueness directly blocks one account from having both a Meta
row and a Gupshup row simultaneously** unless relaxed.

**`messages`** (001, evolved 009/010/035/037/039): provider's wire message
id lives in `message_id` (unique per `(conversation_id, message_id)` since
037) — reusable as-is for Gupshup, no schema change needed.

**`message_templates`** — see §5.

**`broadcasts`** (001, 017/038) and **`broadcast_recipients`** (001,
003/037/038): `broadcast_recipients.whatsapp_message_id` (unique where not
null) mirrors the provider message id for webhook correlation — already
provider-neutral. Aggregate counts on `broadcasts` are maintained by a DB
trigger keyed off status transitions — provider-agnostic, no change.

**Migration decision:** new migration `040_gupshup_provider.sql` adds
`provider` to `whatsapp_config` + Gupshup credential columns (encrypted via
the existing `encryption.ts`), relaxes the account-uniqueness constraint to
`UNIQUE(account_id, provider)`, makes Meta-only columns nullable. Adds a
`provider` + `provider_template_id` pair (or parallel `gupshup_template_id`)
to `message_templates`. Leaves `messages`/`broadcasts`/
`broadcast_recipients` untouched.

---

## 15. Opt-in / opt-out / consent

**Zero matches** for `opt_in|opt_out|unsubscrib|marketing_status|
opted_out|do_not_contact` across `src/` and `supabase/migrations/` (two
`src/` hits were unrelated substring collisions). **There is no consent
tracking anywhere in the current schema or app** — for either provider.
This is net-new work, not a migration of an existing Meta-side concept:
`wa_marketing_status` / `wa_opt_in_at` / `wa_opt_out_at` /
`wa_consent_source` on `contacts`, enforced server-side before any
broadcast/marketing send, for both providers going forward.

---

## 16. Docs — `docs/public-api.md`, `docs/mcp.md`

No provider-specific field names in the documented public API contracts
except `whatsapp_message_id` (§9 — keep as-is). `docs/public-api.md` also
documents WACRM's own **outbound** webhook-to-subscribers feature
(`dispatchWebhookEvent`) — unrelated to the inbound Meta/Gupshup provider
webhook; the two "webhook" concepts must not be conflated in the Gupshup
docs.

---

## Summary — call sites that must switch to a provider resolver

| # | File | Change |
|---|---|---|
| 1 | `src/lib/whatsapp/send-message.ts` | `meta-api.ts` send imports → `resolveWhatsAppProvider(config).send*` |
| 2 | `src/lib/whatsapp/broadcast-core.ts` (+ `broadcast-resume.ts`) | same resolver |
| 3 | `src/lib/automations/meta-send.ts` | same resolver |
| 4 | `src/lib/flows/meta-send.ts` | same resolver (fixes flows + AI auto-reply + part of automations transitively) |
| 5 | `src/app/api/whatsapp/config/route.ts` | provider-branched connect/test flow |
| 6 | `src/app/api/whatsapp/templates/sync/route.ts` | `resolveWhatsAppProvider(config).listTemplates()` |
| 7 | `src/app/api/whatsapp/templates/submit/route.ts` | `.submitTemplate()` |
| 8 | `src/app/api/whatsapp/templates/[id]/route.ts` | `.editTemplate()` / `.deleteTemplate()` |
| 9 | `src/app/api/whatsapp/webhook/route.ts` | per-provider `verifyWebhook()` / `normalizeInbound()` / `normalizeMessageEvent()`, shared core downstream |
| 10 | `src/components/settings/whatsapp-config.tsx` | provider selector + branched field set |

**Already provider-agnostic, no change needed:**
`resolve-conversation.ts`, `src/lib/dashboard/**`, `mcp-server/**` (cosmetic
text only), `docs/public-api.md`'s public contracts, the broadcast
aggregate-count DB triggers, contact/conversation resolution logic.

**Verification item before broadcasts are considered done:** locate the
dashboard campaign wizard's own client-side send loop (per
`broadcast-resume.ts`'s header comment, it drives sends from the browser
tab independent of `broadcast-core.ts`) and confirm it also routes through
the provider resolver — do not assume it's covered by fixing
`broadcast-core.ts` alone.

**Pre-existing tech debt, out of scope but worth flagging:**
`automations/meta-send.ts` and `flows/meta-send.ts` are hand-rolled
duplicates of `send-message.ts`'s send logic (contact lookup, phone-variant
retry, message insert) — both files' own comments acknowledge this as a
known future cleanup. This audit fixes their Meta coupling in place rather
than collapsing the duplication, to keep the change's blast radius small.
