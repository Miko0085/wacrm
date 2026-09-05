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

## Real Gupshup sandbox E2E

**Status: not yet run.** This requires real Gupshup sandbox
credentials (API key, App ID, App Name, source WhatsApp number) and at
least one test recipient WhatsApp number, which is external state this
report can't fabricate. The task's own acceptance policy requires this
report to say so plainly rather than claim a result that didn't happen.

When credentials are available, the procedure is:

1. **Settings → WhatsApp → Gupshup** — enter credentials, **Test
   connection** (expect `connected: true` against `GET /wa/app/{app_id}/business`),
   **Save**, copy the webhook URL into the Gupshup dashboard, enable
   Message + User events.
2. **Sync from Gupshup** — confirm approved templates appear with
   correct name/language/category/status.
3. **Inbound**: message the connected number from a real WhatsApp
   account → confirm it lands in the Shared Inbox, with correct
   sender name/phone, text, and (for a media message) that the
   attachment renders. **This is the step that validates or corrects
   the best-effort inbound-media-field mapping documented as a
   limitation in `GUPSHUP_INTEGRATION.md`** — check the actual Gupshup
   payload against what `gupshup-webhook.ts` expects and adjust field
   names if they differ.
4. **Outbound text**: reply from the Inbox → confirm delivery on the
   test phone.
5. **Outbound template**: send an approved template with variables from
   the composer/broadcast wizard → confirm it renders correctly on the
   test phone, and that `delivered`/`read` status updates land within
   a few seconds of the recipient's phone confirming them (validates
   the `message-event` webhook + status-ladder mapping end to end).
6. **Broadcast**: a 2–5 recipient test broadcast → confirm per-recipient
   `sent → delivered → read` progression in the dashboard, and that a
   reply from one recipient flips `replied_count`.
7. **Opt-out**: send `STOP` (or trigger a native Gupshup opt-out, if
   the sandbox supports simulating one) from a test number → confirm
   `contacts.wa_marketing_status` flips to `OPTED_OUT` and that number
   is excluded from a subsequent test broadcast (both the create-time
   filter and, if timed right, the resume-time re-check).
8. **Automations/Flows/AI**: confirm an existing keyword automation,
   flow, and (if configured) the AI reply assistant / auto-reply all
   fire correctly against the Gupshup-connected number, exactly as
   they do for Meta.

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
