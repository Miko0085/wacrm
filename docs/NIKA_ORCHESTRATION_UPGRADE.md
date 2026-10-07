# Nika WACRM Orchestration Upgrade

This upgrade is additive and preserves existing production Flows and Automations.

## Architecture

- AI Agents: provider/model/knowledge/global AI configuration.
- Automations: event/action orchestration.
- Flows: stateful customer journeys.
- Human handoff: durable business event, not internal-only assignment.
- Free-text customer bursts: durable 35-second debounce before decisioning.

## New capabilities

### Business Events

`053_business_events.sql` adds account-scoped durable events and
`057_orchestration_hardening.sql` upgrades them into an at-least-once outbox.
Automations can trigger on business events and emit them. Flow and AI handoff
paths emit `human_handoff_requested`.

The scheduler claims pending events with a lease, retries failures with backoff,
recovers abandoned `running` rows and dead-letters repeatedly failing events.
Successful automation delivery is deduplicated per `(automation_id, event_id)`.
External consumers should also use `{{event.id}}` as an idempotency key.

### Telegram

`054_telegram_connections.sql` adds account-scoped Telegram bot connections.
Settings -> Telegram stores a display name, encrypted BotFather token, default chat ID and active state.
Automations can use `Send Telegram Notification`, selecting an active bot by name and optionally overriding chat ID.

### Start Flow

Automations can start an **active** Flow. The runtime refuses (and writes nothing) when the Flow is draft/archived or from another account, when the contact or conversation does not belong to the account (or the conversation to that contact), when the graph no longer passes activation validation (e.g. an auto-advancing cycle), and never creates a second active Flow run for the same contact.

### AI Decision inside Flows

`055_flow_ai_decision.sql` adds the `ai_decision` node.
A common sequence is: Collect Input -> AI Decision -> Condition(vars.ai_requires_human).
The node exposes `ai_primary_intent`, `ai_confidence`, `ai_requires_human`, `ai_safe_to_answer`, `ai_summary`, `ai_reason`, and flattened `ai_extracted_*` vars.

### Durable inbound debounce

`056_inbound_debounce.sql` adds a per-conversation queue and
`057_orchestration_hardening.sql` adds worker leases, retries, recovery and
dead-lettering.
Plain-text WhatsApp messages are stored immediately, but Flow/Automation/AI
decisioning waits for 35 seconds of silence. New text resets the timer.
Interactive replies remain immediate.
The existing `/api/automations/cron` endpoint drains bounded batches of due
debounce jobs. A crashed worker no longer leaves a conversation permanently
stuck in `running`.

### Handoff ownership

Flow handoff moves the conversation to pending, disables AI auto-reply, stores a rendered summary, emits `human_handoff_requested`, and ends the active Flow.
While the conversation remains human-owned/AI-paused, a new inbound does not silently start a fresh Flow. Automations may still notify external systems.

## Nika seed

`scripts/seed-nika-orchestration.mjs` is dry-run by default and never guesses an
account (`NIKA_WACRM_ACCOUNT_ID` is mandatory).
It intentionally does not modify the existing `Cold WhatsApp — Positive Lead → amoCRM` automation.

Managed objects (each carries a marker in its `description`):

| Object | Marker |
| --- | --- |
| Nika — Property Selection Qualification (Flow) | `[NIKA_MANAGED:flow_property_selection_v1]` |
| Nika — Selection Reply → Qualification Flow | `[NIKA_MANAGED:auto_selection_reply_v1]` |
| Nika — Call Request → Human Handoff | `[NIKA_MANAGED:auto_call_request_v1]` |
| Nika — Human Handoff → Telegram | `[NIKA_MANAGED:auto_handoff_telegram_v1]` |
| optional Nika — Human Handoff → External Webhook | `[NIKA_MANAGED:auto_handoff_webhook_v1]` |

Rules:

- Only objects that carry their marker are ever updated. An object that merely
  has the same **name** is reported as a `CONFLICT` and nothing at all is written
  (exit code 2). Review it, then rename/delete it, or re-run with
  `--apply --adopt-existing` to let the seed stamp the marker onto exactly that
  object. A deployment that ran an earlier, name-based version of this seed needs
  `--adopt-existing` once.
- Each Flow / Automation replacement is a single database transaction
  (`upsert_managed_flow`, `upsert_managed_automation`, migration 058): live
  traffic sees the old graph or the new one, never a partial one. A failure
  rolls the replacement back automatically.
- A managed Flow with active runs is never replaced.
- Re-running `--apply` is idempotent (updates in place, no duplicates).
- Webhook URLs and header values are redacted from the printed plan.
- The Telegram automation stays inactive until an active Telegram connection exists.

Required environment variables:

- NIKA_WACRM_ACCOUNT_ID

Optional environment variables:
- NIKA_WACRM_OWNER_USER_ID
- NIKA_SELECTION_REPLY_IDS
- NIKA_CALL_REPLY_IDS
- NIKA_SELECTION_MEDIA_URL
- NIKA_SELECTION_MEDIA_TYPE
- NIKA_SELECTION_MEDIA_CAPTION
- NIKA_SELECTION_MEDIA_FILENAME
- NIKA_SELECTION_INTRO_MESSAGE
- NIKA_PURPOSE_QUESTION
- NIKA_BUDGET_QUESTION
- NIKA_TIMELINE_QUESTION
- NIKA_TELEGRAM_CONNECTION_ID
- NIKA_TELEGRAM_CONNECTION_NAME
- NIKA_HANDOFF_WEBHOOK_URL
- NIKA_HANDOFF_WEBHOOK_HEADERS_JSON

Dry run:

    node scripts/seed-nika-orchestration.mjs

Apply:

    node scripts/seed-nika-orchestration.mjs --apply

## Template interpolation

Automation text fields (messages, Telegram text, webhook bodies, event payload
templates) support `{{message.text}}`, `{{contact.id}}`, `{{conversation.id}}`,
`{{vars.X}}`, `{{event.id}}`, `{{event.type}}`, `{{event.payload}}`, `{{event.<key>}}`.

Inside a **JSON** template always use the JSON-encoded form and do **not** add
quotes around it:

    {"reason": {{json.event.reason}}, "text": {{json.message.text}}, "n": {{json.vars.score}}}

`{{json.…}}` escapes quotes, backslashes, newlines and unicode, and keeps
numbers/booleans/objects typed. The raw `{{event.reason}}` form still works
(unchanged) but produces invalid JSON as soon as the value contains a `"`.
Missing values become `""`.

Telegram messages are plain text by default. If a template author selects
HTML/Markdown, every interpolated value is escaped for that mode (the template
itself is not).

## Loop protection

`emit_business_event` propagates a chain depth (`business_events.chain_depth`):
an event emitted while handling an event of depth N has depth N+1, capped at
`MAX_BUSINESS_EVENT_CHAIN_DEPTH = 8`. Beyond the cap the emit is suppressed (a
warning is logged; the automation does **not** fail, so the outbox does not
retry/dead-letter the parent event). Tag chains keep their own depth limit.

## AI vs deterministic responders

The inbound pipeline decides whether AI auto-reply may answer from the **actual**
result of automation dispatch (`customer_facing_attempted`), not from a second
lookup:

- an automation that attempts `send_message`, `send_buttons`, `send_list`,
  `send_template`, `send_media` or `start_flow` (or has one scheduled behind a
  wait step) suppresses AI for that turn — even if that send then fails, so the
  customer never gets a second, parallel AI reply;
- tag / CRM / webhook / Telegram / emit-event automations never suppress AI;
- an automation that fails *before* reaching a customer-facing step does not
  suppress AI.

## Deployment order

Migrations are additive and replay-safe (`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`).
Never edit 053–057 once deployed; all new schema goes in 058+.

1. Pull the branch; run `npm run lint && npm run typecheck && npm test && npm run build`.
2. **Back up the database** (or confirm a recent PITR point).
3. Apply migrations 053 → 058 in order (`supabase db push`, or `psql -f` each).
   - 057 marks pre-existing `business_events` as `dispatched` so history is not replayed.
   - 058 adds wait-scheduler leases, `chain_depth`, retention helper and the managed-seed RPCs.
   - Optionally run `supabase/ci/verify-schema.sql` and `supabase/ci/orchestration-behavior.sql` (the latter rolls back its own fixtures).
4. Rebuild and recreate the app container (**after** the migrations — 058 columns are used by the cron worker).
5. Verify health, then call the cron endpoint once manually:
   `curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://<host>/api/automations/cron`
   and check `failed_categories: 0` and the `queues` counts.
6. Connect/test the Telegram bot if needed (`Settings → Telegram → Test`).
7. Run the seed dry-run and review the plan; resolve any `CONFLICT`.
8. Run the seed with `--apply` (add `--adopt-existing` only if a previous name-based seed exists).
9. Test: selection reply, merged text turn, expert-question handoff, call-request handoff, Telegram notification, and existing Greece → amoCRM routing.

## Operations

The single cron endpoint runs five independent categories in parallel — wait
steps, inbound debounce, business events, scheduled broadcasts, retention — each
with **bounded concurrency** (5 / 3 / 4) and a 180 s *start* budget (jobs already
running finish; their leases cover a hard platform kill). A category that throws
is reported (`failed_categories`) and never blocks the others.

Response (counts only — never message text or payloads):

- legacy keys: `processed`, `debounced_inbound`, `debounce_*`, `business_event*`, `scheduled_broadcasts`
- `waits`, `debounce_skipped`, `business_event_skipped` (work deferred by the time budget)
- `queues`: `{business_events, inbound_debounce, automation_waits}.{pending, dead}` — alert on `dead > 0`
- `retention`: rows deleted this tick; `duration_ms`

Lease / retry semantics (all three queues):

| Queue | Lease | Max attempts | Dead state |
| --- | --- | --- | --- |
| inbound debounce | 5 min | 5 (backoff 30 s → 15 min) | `status='dead'`; a new customer message revives it |
| business events | 5 min | 8 (backoff 15 s → 30 min) | `dispatch_status='dead'` |
| automation waits | 5 min | 3 (crash recoveries) | `status='dead'`; a step failure is terminal `failed` (never blindly replayed) |

Delivery is **at-least-once**: a crash after side effects but before the
`dispatched` mark replays the event, but automations that already succeeded (or
are parked on a wait) for that `(automation, event)` are skipped. Use
`{{event.id}}` as the idempotency key in external consumers.

Debounce supersede rule: if a new message arrives while a worker holds version
N, the row becomes version N+1 containing only the new text; the old worker's
completion/failure is version-guarded and cannot delete or overwrite N+1. (If
the old worker then fails, its already-superseded text is not retried.)

Retention (`cleanup_orchestration_data`, batched, run every tick): dispatched
events after 30 days, **dead events after 90 days**, dead debounce jobs after 14
days, finished wait rows after 30 days. `automation_logs` retention is unchanged.

Inspect dead-letters:

    select id, event_type, dispatch_attempts, last_error from business_events where dispatch_status = 'dead';
    select id, conversation_id, attempt_count, last_error from inbound_debounce_jobs where status = 'dead';
    select id, automation_id, attempt_count, last_error from automation_pending_executions where status = 'dead';

Re-drive a dead event after fixing the cause:

    update business_events set dispatch_status='pending', dispatch_attempts=0, dispatch_after=now(), last_error=null where id = '<id>';

Telegram test endpoint status codes: `400` input/config/bad chat, `401` bot token
rejected, `403` bot not allowed in the chat, `429` rate limit (with
`Retry-After`), `502` Telegram unavailable/unreachable, `504` timeout. Error
bodies are fixed strings; the bot token and raw Telegram responses are never
returned or logged.

## Rollback

The pre-upgrade production configuration remains under `config/snapshots/2026-10-06/`.
Raw production exports remain under Git-ignored `backups/` on the production server.
Do not blindly restore the JSON snapshot over a live database.

Application rollback (safe at any time): redeploy the previous image.
Migrations 053–058 are additive, and older code ignores the new columns/tables —
**except** that the previous (pre-058) cron code would treat `running` wait rows
without leases as before, which is the old behaviour. No data migration is needed.

Orchestration kill-switches without a redeploy:

- Disable the managed automations (`update automations set is_active=false where description like '%[NIKA_MANAGED:%'`).
- Stop the inbound debounce path by failing the queue RPC (the pipeline then
  falls back to immediate dispatch) — or simply leave the cron running; pending
  jobs only delay replies, they never lose them.
- To undo a seed apply: set the managed Flow to `archived` and the managed
  automations inactive; nothing else is changed by the seed.

Schema rollback is not recommended (data loss for queued jobs). If unavoidable,
only after disabling the cron: `ALTER TABLE … DROP COLUMN` the 058 columns and
restore the 057 status CHECK; 053–057 objects must stay.

## Production hardening notes

- Provider delivery callbacks are resolved to an account before any message or
  broadcast-recipient status write. Provider message IDs are not treated as
  globally unique (covered by a two-tenant test with an identical provider id).
- Only active Flows may be started by Automations, and only for contacts and
  conversations of the same account.
- Flow activation rejects cycles composed entirely of auto-advancing nodes;
  conversational loops through `collect_input` / `send_buttons` / `send_list` are allowed.
- Telegram handoff notifications use plain text by default and read handoff
  details from the durable business event payload.
- Migration 057 marks pre-existing business events as dispatched so deployment
  does not replay historical handoffs (regression-tested).

## Known limitations

- Business-event delivery to *external* systems is at-least-once; consumers must dedupe on `event.id`.
- A step failure inside a resumed wait is terminal (`failed`), not retried, because partial side effects may already exist.
- `inbound_debounce_jobs` keeps only the newest batch when a message supersedes a running job.
- On first deploy, wait rows left `running` by the old scheduler (no lease timestamp) are recovered once and re-run; this is a one-time at-least-once replay of at most the in-flight rows.
- Local verification covers all migrations except the pgvector knowledge migrations (030/032), which need the `vector` extension.
