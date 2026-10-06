create table if not exists public.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  name text not null,
  bot_token text not null,
  default_chat_id text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_telegram_connections_account
  on public.telegram_connections(account_id, created_at);

alter table public.telegram_connections enable row level security;
