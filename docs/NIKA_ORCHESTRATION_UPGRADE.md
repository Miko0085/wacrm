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

Automations can start a non-archived Flow selected by name. The runtime refuses to create a second active Flow run for the same contact.

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

`scripts/seed-nika-orchestration.mjs` is dry-run by default.
It intentionally does not modify the existing `Cold WhatsApp — Positive Lead → amoCRM` automation.

Managed objects:

- Nika — Property Selection Qualification
- Nika — Selection Reply → Qualification Flow
- Nika — Call Request → Human Handoff
- Nika — Human Handoff → Telegram
- optional Nika — Human Handoff → External Webhook

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

## Deployment order

1. Pull the branch.
2. Run typecheck/tests.
3. Apply migrations 053 through 057.
4. Rebuild and recreate the app container.
5. Verify health.
6. Connect/test Telegram bot if needed.
7. Run seed dry-run and review.
8. Run seed with --apply. The seed refuses to guess the account ID and refuses to replace a managed Flow while it has active runs.
9. Test selection reply, merged text turn, expert-question handoff, call-request handoff, Telegram notification, and existing Greece -> amoCRM routing.

## Rollback

The pre-upgrade production configuration remains under `config/snapshots/2026-10-06/`.
Raw production exports remain under Git-ignored `backups/` on the production server.
Do not blindly restore the JSON snapshot over a live database.

## Production hardening notes

- Provider delivery callbacks are resolved to an account before any message or
  broadcast-recipient status write. Provider message IDs are not treated as
  globally unique.
- Only active Flows may be started by Automations.
- Flow activation rejects cycles composed entirely of auto-advancing nodes.
- AI auto-reply stands down only when a matching deterministic automation has
  a customer-facing response action; unrelated CRM-only automations do not mute
  the AI.
- Telegram handoff notifications use plain text by default and read handoff
  details from the durable business event payload.
- Managed seed updates disable the target automation/flow while replacing its
  graph and restore the previous configuration on replacement failure.
- Migration 057 marks pre-existing business events as dispatched so deployment
  does not replay historical handoffs.
