import { NextResponse } from "next/server";

import {
  requireActiveAccount,
  toErrorResponse,
} from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireActiveAccount();
    return NextResponse.json({
      accountId: ctx.accountId,
      role: ctx.role,
      account: ctx.account,
      membership: ctx.membership,
      accounts: ctx.accounts,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
