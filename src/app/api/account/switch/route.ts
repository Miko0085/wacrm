import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ACTIVE_ACCOUNT_COOKIE } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { account_id?: unknown }
    | null;
  if (typeof body?.account_id !== "string" || !UUID_RE.test(body.account_id)) {
    return NextResponse.json(
      { error: "'account_id' must be a valid UUID" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("account_memberships")
    .select("account_id")
    .eq("user_id", user.id)
    .eq("account_id", body.account_id)
    .maybeSingle();

  if (membershipError) {
    console.error("[POST /api/account/switch] membership lookup:", membershipError);
    return NextResponse.json(
      { error: "Could not verify account membership" },
      { status: 500 },
    );
  }
  if (!membership) {
    return NextResponse.json(
      { error: "You are not a member of this account" },
      { status: 403 },
    );
  }

  (await cookies()).set(ACTIVE_ACCOUNT_COOKIE, body.account_id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ ok: true, accountId: body.account_id });
}
