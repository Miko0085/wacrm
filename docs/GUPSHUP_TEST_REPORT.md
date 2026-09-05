# Gupshup Integration — Test Report

## Baseline (before any Gupshup changes)

| Check | Result |
|---|---|
| `npm install` | Clean |
| `npm run typecheck` | Clean |
| `npm test` (vitest) | 830 passed / 3 failed / 833 total — 79 files passed, 1 failed (`src/lib/currency.test.ts`) |

The 3 `currency.test.ts` failures are **pre-existing and unrelated** to
this work: `Intl.NumberFormat` on this machine's ICU data renders
`1234` as `"1 234"` (space thousands-separator) instead of the test's
expected `"1,234"` — a locale/ICU environment difference, not a code
defect introduced here. Confirmed by running the identical suite
against the untouched `main` branch before any Gupshup code was
written.

## After the Gupshup provider-abstraction implementation

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm test` (vitest) | 892 passed / 3 failed / 895 total — 85 files passed, 1 failed (same pre-existing `currency.test.ts` failures) |
| `npm run build` | **PASS** — clean against a real local Supabase backend (see "Local deployment baseline" below). `Compiled successfully`, TypeScript pass clean, all 80 routes generated including the two new ones (`/api/whatsapp/gupshup/webhook/[token]`, `/api/whatsapp/config/test`). |

**62 new tests added, 0 regressions.** Every existing test file that
touched a call site rewired to `resolveWhatsAppProvider` — `send-message.test.ts`,
`broadcast-core.test.ts`, `broadcast-resume.test.ts` — passes with only
the mechanical fixture updates the refactor itself required (see
"Test changes" below), not behavior changes.

New test files (provider boundary, per the testing strategy in the
main task):
- `src/lib/whatsapp/providers/gupshup-client.test.ts` — send text/template,
  list templates, business details, HTTP error → `ProviderError` code
  mapping (auth/rate-limit/invalid-template/invalid-recipient).
- `src/lib/whatsapp/providers/gupshup-provider.test.ts` — message-type
  payload building (text/image/video/document/audio, quick-reply/list
  interactive), template media-header attachment, the
  missing-`gupshup_template_id` guard, absence of submit/edit/delete.
- `src/lib/whatsapp/providers/gupshup-status-map.test.ts` — delivery-status
  and template-status vocabulary mapping.
- `src/lib/whatsapp/providers/gupshup-webhook.test.ts` — envelope
  validation, inbound message/status/user-event normalization,
  unmapped-type → `null` (never a throw).
- `src/lib/whatsapp/providers/resolve.test.ts` — Meta-default backward
  compatibility, Gupshup resolution, `not_supported` on missing
  credentials, no cross-provider credential leakage on a row that has
  both saved.
- `src/lib/whatsapp/inbound-pipeline.test.ts` — status-ladder transition
  table (forward-only, failed-is-terminal, out-of-order-safe), the
  `handleStatusUpdate` DB-mirroring guard.

### Test changes required by the refactor itself

- `broadcast-core.test.ts` — the `whatsapp_config` fixture gained
  `provider: 'meta'`, and the mock `contacts` table branch (new: the
  opt-out suppression check `createBroadcast` now runs).
- `broadcast-resume.test.ts` — `plan.accessToken` assertion became
  `plan.config` (the plan now carries the raw config row and resolves
  its provider at delivery time, not a Meta-flavored `accessToken`
  string at plan time).
- `send-message.test.ts` — unchanged; its `vi.mock('@/lib/whatsapp/meta-api', ...)`
  still intercepts correctly because `meta-provider.ts` imports the
  same functions from the same module path.

## Production build

`npm run build`: **[fill in — see the build log referenced in this
session; re-run `npm run build` and paste the summary here before
shipping]**.

## Local deployment baseline

- `npm install`, `npm run typecheck`, `npm test`, `npm run build` all
  run directly against this checkout.
- Local Supabase (`supabase start`) was used as the DB backend per the
  user's choice. Migrations 001–040 (including `040_gupshup_provider.sql`)
  applied cleanly with no SQL errors on a fresh `supabase db reset` /
  `supabase start` — confirmed twice. The Supabase CLI's own
  `analytics`/`studio` container health probes are flaky on this
  particular (heavily loaded, many unrelated Docker projects running)
  machine and occasionally fail the CLI's overall health gate even
  though `db`/`auth`/`postgrest`/`storage`/`kong` all report healthy;
  `supabase start --ignore-health-check` works around that CLI-level
  flakiness — it is unrelated to the WACRM migrations themselves.
- Booted `npm run dev` against that local stack and smoke-tested the
  new routes over HTTP: `/login` → 200, `/settings` → 307 (redirect to
  login, expected unauthenticated), `GET /api/whatsapp/config` → 401
  Unauthorized (not a 500), `POST /api/whatsapp/gupshup/webhook/<bogus-token>`
  → 404 Not Found (not a crash), `POST /api/whatsapp/config/test` → 401
  Unauthorized. No server errors on any of these.

## Global marketing suppression + system-default STOP keyword

Added after the initial provider-abstraction pass, per follow-up
review:

- **`src/lib/whatsapp/suppression.ts`** (`assertMarketingAllowed`) —
  the same opted-out check broadcasts already enforced is now also
  enforced in `send-message.ts` (the manual composer send AND the
  public `/api/v1/messages` endpoint) and `automations/meta-send.ts`
  (the `send_template` automation action), for a Marketing-category
  template specifically. Utility/Authentication templates and
  free-form replies are never blocked. Flows has no template-send node
  (confirmed — only `send_message`/`send_media`/interactive), so no
  change needed there.
- **`applyStopKeywordIfMatched`** in `inbound-pipeline.ts` — a
  system-default STOP keyword (`STOP`, `UNSUBSCRIBE`, `REMOVE`, `СТОП`,
  `ОТПИСКА`, `НЕ ПИШИТЕ`, exact whole-message match, case-insensitive)
  that runs unconditionally in the shared pipeline for both providers,
  independent of any user-configured automation. A user can still add
  more keywords via `update_contact_field` → `wa_marketing_status` in
  their own automation, additively.
- 18 new tests: `suppression.test.ts` (category/status matrix), 3 new
  cases in `send-message.test.ts` (blocks Marketing→opted-out, allows
  Utility→opted-out, allows Marketing→opted-in), and 11 new cases in
  `inbound-pipeline.test.ts` for the STOP-keyword matcher (every
  configured keyword, substring-must-not-match, unrelated/null/empty
  text).
- Full suite after this round: **910 passed / 3 failed / 913 total**
  (same pre-existing `currency.test.ts` failures) — 0 regressions.
  `npm run typecheck` clean.
- After the live E2E pass and its fixes (below): **912 passed / 3 failed
  / 915 total** — 2 new test cases for the real `postbackText`/`business`-nesting
  findings, 0 regressions. `npm run typecheck` clean.

## Real Gupshup sandbox E2E

**Status: run, against a real Gupshup app and a real WhatsApp test
phone**, tunneled to the local dev server via a Cloudflare quick tunnel
(`cloudflared tunnel --url http://localhost:3001`) so Gupshup's real
servers could deliver webhooks to the actual code running locally.

| Step | Result |
|---|---|
| Settings → WhatsApp → Gupshup: enter credentials, Test connection, Save | **PASS** — `testConnection()` returned real business details (`GET /wa/app/{app_id}/business`), config saved with `provider='gupshup'`, encrypted key, generated webhook token |
| Webhook URL registered in Gupshup dashboard (format v2, Message + User events) | **PASS** |
| Inbound text message | **PASS** — landed in the Inbox with correct contact/conversation/phone/text |
| Outbound text | **PASS** (after an account-side fix, see "Real issues found" below) — confirmed full `sent → delivered → read` status-ladder progression via real webhook events |
| Outbound image | **PASS** |
| Outbound document (PDF) | **PASS** |
| Outbound audio | **PASS** (after switching to a small, direct, correctly-codec'd MP3 — see limitation #6 in `GUPSHUP_INTEGRATION.md`) |
| Outbound video | **PASS** |
| Interactive quick-reply buttons — send + tap → inbound reply | **PASS** (after a real code fix — see "Real issues found") |
| Interactive list — send + tap → inbound reply | **PASS** (same fix) |
| STOP keyword → `wa_marketing_status = OPTED_OUT` | **PASS** — system-default STOP fired on a real inbound "стоп" message, no automation configured |
| Conversational reply still reaches an opted-out contact | **PASS** — confirms suppression is Marketing-only, not a hard block |
| Broadcast creation with a mixed opted-out/eligible recipient list | **PASS** (after a real, pre-existing, unrelated DB fix — see below) — the opted-out recipient was excluded (`rejected: 1`), the eligible one planned (`planned.length: 1`) |
| Outbound **template** send / broadcast delivery to a real recipient | **NOT RUN** — the test Gupshup app had zero approved templates at test time (confirmed via a real `listTemplates()` call). The template wire format itself is implemented per Gupshup's docs and unit-tested; only the live send is pending an approved template. |
| Automations/Flows/AI live-fire against the Gupshup number | **NOT RUN** — no automation/flow/AI config existed on this fresh test account; the code path is identical to Meta's (same `resolveWhatsAppProvider` call sites) and already covered by the unit suite |

### Real issues found and fixed during this pass

1. **`message_templates.provider` column was missing.** `templates/sync/route.ts`
   referenced it but migration 040 never added it — every Gupshup
   template sync would have failed with a Postgres error. Fixed in
   `supabase/migrations/041_message_templates_provider.sql`.
2. **`GET /wa/app/{app_id}/business` response shape.** Real response
   nests fields under `business` (`{status, business: {name, ...}}`),
   not flat as the docs example suggested. Fixed in `gupshup-client.ts`'s
   `getBusinessDetails` (prefers the nested shape, falls back to flat
   for safety) — see `docs/GUPSHUP_INTEGRATION.md`.
3. **Tapped button/list reply id.** The real inbound `button_reply`/
   `list_reply` payload is `{title, id: "", reply, postbackText}` —
   the stable id is in `postbackText`, not `id` (`id` is always empty
   in practice). This is exactly the field `sendInteractive()` writes
   on the way out, so it round-trips correctly once read from the
   right place. Fixed in `gupshup-webhook.ts`'s `normalizeGupshupInboundMessage`
   (prefers `postbackText`, falls back to `id` for forward-compat).
   Without this fix, the Flows engine and the `interactive_reply`
   automation trigger could never route on a Gupshup button/list tap.
4. **`create_broadcast_with_recipients` (migration 037) — pre-existing,
   NOT Gupshup-specific.** Raises "column reference contact_id is
   ambiguous" against a real Postgres engine: the function's
   `RETURNS TABLE(..., contact_id uuid)` implicitly declares `contact_id`
   as a PL/pgSQL variable in scope for the whole function body, which
   collides with the bare `contact_id` in a nested `INSERT ... RETURNING`.
   This was never caught because `broadcast-core.test.ts` mocks the
   `.rpc()` boundary and never executes the real SQL — meaning **every
   broadcast created through `POST /api/v1/broadcasts` (or the resume
   path) for ANY account, Meta or Gupshup, would have failed against a
   real database.** Fixed in
   `supabase/migrations/042_fix_create_broadcast_ambiguous_column.sql`
   (table-qualifies + aliases the `RETURNING` column; no signature or
   caller change). Confirmed fixed via both a direct SQL call and the
   real `createBroadcast()` code path.
5. **Two intermittent outbound-media test-fixture failures** (a
   Vorbis-codec OGG, and an 8 MB MP3 from a slower host) — resolved by
   using a smaller, directly-hosted, correctly-codec'd file; documented
   as limitation #6 in `GUPSHUP_INTEGRATION.md` rather than treated as
   a code bug, since the same code succeeded with an equivalent file
   moments later.

All fixes are covered by updated/new unit tests
(`gupshup-client.test.ts`, `gupshup-webhook.test.ts`) except the two DB
migrations (041, 042), which are schema/SQL fixes validated by direct
`psql` execution against the real local database, not by the vitest
suite (which mocks the DB boundary by design).

## Meta regression checklist

Run this against an existing Meta-connected test account after any
future change that touches a shared file (`send-message.ts`,
`broadcast-core.ts`, the automations/flows senders, the webhook route,
the config/template routes):

- [ ] Inbound text/media/interactive message lands in the Inbox.
- [ ] Outbound text/media/template send from the composer.
- [ ] Template sync from Meta.
- [ ] Broadcast send + delivered/read status updates.
- [ ] AI reply assistant draft + auto-reply.
- [ ] An existing automation (keyword/new-message trigger, send_message
      action) still fires.
- [ ] A Flow with a `send_message`/`send_media`/interactive node still
      runs.

As of this report, the full existing automated test suite (830→892
passing tests) stands in for this checklist at the unit level; the
manual walkthrough above still needs a real Meta test account pass
before a production deploy.

## Known limitations

See "Limitations / follow-ups" in `GUPSHUP_INTEGRATION.md` — inbound
media-field mapping and interactive-list mapping are the two items
most worth prioritizing in the sandbox E2E pass above, since they're
the only parts of this integration not independently confirmed against
Gupshup's own published docs.
