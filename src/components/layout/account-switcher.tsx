"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Loader2, UsersRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const roleKey = {
  owner: "roleOwner",
  admin: "roleAdmin",
  agent: "roleAgent",
  viewer: "roleViewer",
} as const;

export function AccountSwitcher() {
  const t = useTranslations("Sidebar");
  const { account, accountId, accounts } = useAuth();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  if (!account || accounts.length <= 1) return null;

  const switchAccount = async (nextAccountId: string) => {
    if (nextAccountId === accountId || switchingTo) return;
    setSwitchingTo(nextAccountId);
    try {
      const response = await fetch("/api/account/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: nextAccountId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? t("switchFailed"));
      }

      // A hard reload intentionally clears account-scoped client state,
      // including the selected Inbox conversation and realtime channels.
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("switchFailed"));
      setSwitchingTo(null);
    }
  };

  return (
    <div className="shrink-0 border-b border-border p-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("switchAccount")}
          disabled={switchingTo !== null}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UsersRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {account.name}
          </span>
          {switchingTo ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-58 bg-popover text-popover-foreground ring-border"
        >
          {accounts.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => void switchAccount(item.id)}
              disabled={switchingTo !== null}
              className="items-start gap-2 px-2 py-2"
            >
              <Check
                className={`mt-0.5 size-4 ${item.id === accountId ? "opacity-100" : "opacity-0"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(roleKey[item.role])}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
