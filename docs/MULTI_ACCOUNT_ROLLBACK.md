# Multi-account rollback

Base commit: `9b8eeb448bce4ca93712a2f8dad00d06dc501211`

The implementation is isolated to the `feature/multi-account-switcher` branch. No production credentials, Supabase project, SSH session, deploy, push, or merge was used.

## Changed files

- `supabase/migrations/043_multi_account_switcher.sql` — additive memberships, active-account RPCs, explicit member-management RPCs, and the scoped tag-filter RPC.
- `supabase/seed.sql` — local-only fake three-account fixture.
- `src/lib/auth/account.ts` — `requireActiveAccount()` and HTTP-only cookie resolution.
- `src/app/api/account/context/route.ts` and `src/app/api/account/switch/route.ts` — context and secure switch endpoints.
- `src/app/api/account/members*`, `src/app/api/account/transfer-ownership/route.ts`, and invitation redemption — account-explicit membership operations.
- `src/hooks/use-auth.tsx`, `src/components/layout/account-switcher.tsx`, sidebar/header consumers, presence, Inbox, dashboard, contacts, pipelines, broadcasts, settings, and notifications — active-account context and isolation filters.

## Database migration

`043_multi_account_switcher.sql` creates `account_memberships`, backfills one row from every existing profile, and preserves the legacy profile columns. It does not drop tables or columns. It relaxes the historical one-owner-per-user unique index because a user may own more than one account.

## Code rollback

1. Stop the local dev server.
2. On this branch, restore the code to the base commit with the repository's normal review process (do not reset unrelated user work).
3. Do not push or merge without a separate user command.

The pre-043 code can continue to read `profiles.account_id/account_role`; those columns remain populated and the legacy RPCs remain present.

## Database rollback

No database rollback is required for a code-only rollback: the old code continues to use the legacy profile pointer and existing RPCs. If the local database itself must be rebuilt, run `supabase db reset` against the local Supabase instance only; `supabase/seed.sql` recreates fake accounts and records.

Removing `account_memberships` or reverting the owner index is intentionally not automated because that would discard memberships created after migration 043. Take a local database dump first if a destructive schema rollback is explicitly requested.
