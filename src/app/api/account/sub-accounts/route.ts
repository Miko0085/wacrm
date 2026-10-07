import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const { data: current, error: currentError } = await ctx.supabase
      .from("accounts").select("parent_account_id").eq("id", ctx.accountId).single();
    if (currentError) throw currentError;
    if (current.parent_account_id) return NextResponse.json({ error: "Only the main account can manage sub-accounts" }, { status: 403 });
    const { data, error } = await ctx.supabase.rpc("list_sub_accounts", { p_parent_account_id: ctx.accountId });
    if (error) throw error;
    return NextResponse.json({ accounts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const { data: current, error: currentError } = await ctx.supabase
      .from("accounts").select("parent_account_id").eq("id", ctx.accountId).single();
    if (currentError) throw currentError;
    if (current.parent_account_id) return NextResponse.json({ error: "Only the main account can manage sub-accounts" }, { status: 403 });
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Sub-account name is required" }, { status: 400 });
    }
    const { data, error } = await ctx.supabase.rpc("create_sub_account", {
      p_name: body.name.trim(),
    });
    if (error) {
      console.error("[POST /api/account/sub-accounts]", error);
      return NextResponse.json({ error: "Failed to create sub-account" }, { status: 400 });
    }
    return NextResponse.json({ account: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
