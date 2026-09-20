// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: memberships, error: membershipsError } = await ctx.supabase
      .from("account_memberships")
      .select("user_id, role, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (membershipsError) {
      console.error("[GET /api/account/members] fetch error:", membershipsError);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const userIds = (memberships ?? []).map((row) => row.user_id);
    const { data: profiles, error: profilesError } = userIds.length
      ? await ctx.supabase
          .from("profiles")
          .select("user_id, full_name, email, avatar_url, created_at")
          .in("user_id", userIds)
      : { data: [], error: null };
    if (profilesError) {
      console.error("[GET /api/account/members] profile fetch error:", profilesError);
      return NextResponse.json({ error: "Failed to load members" }, { status: 500 });
    }

    const profilesByUser = new Map(
      (profiles as ProfileRow[]).map((profile) => [profile.user_id, profile]),
    );

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (memberships ?? []).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.role)) return [];
      const profile = profilesByUser.get(row.user_id);
      if (!profile) return [];
      return [
        {
          user_id: row.user_id,
          full_name: profile.full_name ?? "",
          email: canSeeEmails ? profile.email : null,
          avatar_url: profile.avatar_url,
          role: row.role,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
