-- Durable account-scoped business events used to decouple detection from reactions.

create table if not exists public.business_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  event_type text not null check (char_length(event_type) between 1 and 120),
  contact_id uuid null references public.contacts(id) on delete set null,
  conversation_id uuid null references public.conversations(id) on delete set null,
  source text not null default 'system',
  payload jsonb not null default '{}'::jsonb,
  dispatched_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_business_events_account_created
  on public.business_events(account_id, created_at desc);

create index if not exists idx_business_events_account_type_created
  on public.business_events(account_id, event_type, created_at desc);

create index if not exists idx_business_events_pending_dispatch
  on public.business_events(created_at)
  where dispatched_at is null;

alter table public.business_events enable row level security;

comment on table public.business_events is
  'Durable business-domain events. Writes are performed server-side; automations subscribe by event_type.';
