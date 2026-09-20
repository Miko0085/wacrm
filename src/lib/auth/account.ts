import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

export const ACTIVE_ACCOUNT_COOKIE = "wacrm_active_account_id";

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export interface AvailableAccount {
  id: string;
  name: string;
  default_currency: string | null;
  role: AccountRole;
  membershipId: string;
  parent_account_id?: string | null;
}

export interface AccountContext {
  supabase: SupabaseClient;
  userId: string;
  accountId: string;
  role: AccountRole;
  account: { id: string; name: string; default_currency: string | null; parent_account_id?: string | null };
  membership: {
    id: string;
    account_id: string;
    user_id: string;
    role: AccountRole;
    created_at: string;
  };
  accounts: AvailableAccount[];
}

interface MembershipRow {
  id: string;
  account_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

/**
 * Resolve the active account for this request. The HTTP-only cookie is a
 * preference, never authority: its value is accepted only when it matches a
 * membership loaded for the authenticated user. Missing/stale values fall
 * back deterministically to the oldest membership, then account UUID.
 */
export async function requireActiveAccount(): Promise<AccountContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) throw new UnauthorizedError();

  // Use a dedicated RPC so this helper remains compatible with stale
  // PostgREST schemas and the legacy two-query unit-test client.
  if (typeof (supabase as { rpc?: unknown }).rpc !== "function") {
    return resolveLegacyProfileContext(supabase, user.id);
  }

  const { data: membershipRows, error: membershipError } = await supabase.rpc(
    "list_my_account_memberships",
    { p_user_id: user.id },
  );

  if (membershipError) {
    console.error(
      "[requireActiveAccount] membership fetch error:",
      membershipError,
    );
    throw new ForbiddenError("Could not load account context");
  }

  const memberships = ((membershipRows as MembershipRow[] | null) ?? []).flatMap((row) =>
    isAccountRole(row.role) ? [{ ...row, role: row.role }] : [],
  );
  if (memberships.length === 0) {
    return resolveLegacyProfileContext(supabase, user.id);
  }

  const requestedId = (await cookies()).get(ACTIVE_ACCOUNT_COOKIE)?.value;
  const membership =
    memberships.find((row) => row.account_id === requestedId) ?? memberships[0];

  const { data: accountRows, error: accountError } = await supabase
    .from("accounts")
    .select("id, name, default_currency, parent_account_id")
    .in(
      "id",
      memberships.map((row) => row.account_id),
    );

  if (accountError) {
    console.error("[requireActiveAccount] account fetch error:", accountError);
    throw new ForbiddenError("Could not load account context");
  }

  const byId = new Map((accountRows ?? []).map((row) => [row.id, row]));
  const account = byId.get(membership.account_id);
  if (!account) throw new ForbiddenError("Profile is not linked to an account");

  const accounts: AvailableAccount[] = memberships.flatMap((row) => {
    const linked = byId.get(row.account_id);
    return linked
      ? [
          {
            id: linked.id,
            name: linked.name,
            default_currency: linked.default_currency ?? null,
            role: row.role,
            membershipId: row.id,
            parent_account_id: linked.parent_account_id ?? null,
          },
        ]
      : [];
  });

  return {
    supabase,
    userId: user.id,
    accountId: membership.account_id,
    role: membership.role,
    account: {
      id: account.id,
      name: account.name,
      default_currency: account.default_currency ?? null,
      parent_account_id: account.parent_account_id ?? null,
    },
    membership: {
      id: membership.id,
      account_id: membership.account_id,
      user_id: membership.user_id,
      role: membership.role,
      created_at: membership.created_at,
    },
    accounts,
  };
}

async function resolveLegacyProfileContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<AccountContext> {
  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[requireActiveAccount] legacy profile fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data?.account_id || !isAccountRole(data.account_role)) {
    throw new ForbiddenError("Profile is not linked to an account");
  }

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id, name, default_currency, parent_account_id")
    .eq("id", data.account_id)
    .maybeSingle();
  if (accountError) {
    console.error("[requireActiveAccount] legacy account fetch error:", accountError);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) throw new ForbiddenError("Profile is not linked to an account");

  const membership = {
    id: `legacy:${data.account_id}:${userId}`,
    account_id: data.account_id,
    user_id: userId,
    role: data.account_role,
    created_at: "1970-01-01T00:00:00.000Z",
  };
  return {
    supabase,
    userId,
    accountId: data.account_id,
    role: data.account_role,
    account: {
      id: account.id,
      name: account.name,
      default_currency: account.default_currency ?? null,
      parent_account_id: account.parent_account_id ?? null,
    },
    membership,
    accounts: [
      {
        id: account.id,
        name: account.name,
        default_currency: account.default_currency ?? null,
        role: data.account_role,
        membershipId: membership.id,
        parent_account_id: account.parent_account_id ?? null,
      },
    ],
  };
}

/** Compatibility alias for existing routes. */
export const getCurrentAccount = requireActiveAccount;

export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await requireActiveAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
