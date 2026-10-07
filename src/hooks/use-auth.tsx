"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";

import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/client";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  /** Active values, resolved from the server-side account context. */
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  default_currency: string;
  parent_account_id?: string | null;
}

export interface AccountChoice extends AccountSummary {
  role: AccountRole;
  membershipId: string;
}

export type AccountStatus = "loading" | "ready" | "unlinked" | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  accountStatus: AccountStatus;
  accountStatusDetail: string | null;
  accountId: string | null;
  accountRole: AccountRole | null;
  account: AccountSummary | null;
  accounts: AccountChoice[];
  defaultCurrency: string;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  isViewer: boolean;
  canManageMembers: boolean;
  canEditSettings: boolean;
  canSendMessages: boolean;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
}

interface AccountContextResponse {
  accountId: string;
  role: string;
  account: { id: string; name: string; default_currency: string | null; parent_account_id?: string | null };
  accounts: Array<{
    id: string;
    name: string;
    default_currency: string | null;
    role: string;
    membershipId: string;
  }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const lastFetchedUserId = useRef<string | null>(null);

  const clearAccountState = useCallback(() => {
    setProfile(null);
    setAccount(null);
    setAccounts([]);
    setStatusDetail(null);
  }, []);

  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserId.current = userId;

    try {
      const [{ data, error }, contextResponse] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, email, avatar_url, role, beta_features")
          .eq("user_id", userId)
          .maybeSingle(),
        fetch("/api/account/context", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      ]);

      if (error) throw new Error(error.message);
      if (!data) throw new Error("no profiles row for the signed-in user");
      if (!contextResponse.ok) {
        const payload = (await contextResponse.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "Could not load account context");
      }

      const context = (await contextResponse.json()) as AccountContextResponse;
      if (!isAccountRole(context.role)) {
        throw new Error(`Unknown account role: ${context.role}`);
      }

      const choices = context.accounts.flatMap((item) =>
        isAccountRole(item.role)
          ? [
              {
                id: item.id,
                name: item.name,
                default_currency: item.default_currency ?? DEFAULT_CURRENCY,
                role: item.role,
                membershipId: item.membershipId,
              },
            ]
          : [],
      );
      const row = data as ProfileRow;
      setProfile({
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        avatar_url: row.avatar_url,
        role: row.role,
        beta_features: row.beta_features ?? [],
        account_id: context.accountId,
        account_role: context.role,
      });
      setAccount({
        id: context.account.id,
        name: context.account.name,
        default_currency:
          context.account.default_currency ?? DEFAULT_CURRENCY,
        parent_account_id: context.account.parent_account_id ?? null,
      });
      setAccounts(choices);
    } catch (error) {
      console.error("[AuthProvider] account context error:", error);
      lastFetchedUserId.current = null;
      clearAccountState();
      setStatusDetail(
        error instanceof Error ? error.message : "profile fetch failed",
      );
    } finally {
      setProfileLoading(false);
    }
  }, [clearAccountState]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) console.error("[AuthProvider] getSession error:", error.message);
      const currentUser = data.session?.user ?? null;
      setUser(currentUser);
      setLoading(false);
      if (currentUser) void fetchProfile(currentUser.id);
      else setProfileLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setLoading(false);
      if (currentUser) {
        if (lastFetchedUserId.current !== currentUser.id) {
          void fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserId.current = null;
        clearAccountState();
        setProfileLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [clearAccountState, fetchProfile]);

  const signOut = useCallback(async () => {
    await createClient().auth.signOut();
    clearAccountState();
    setUser(null);
    window.location.href = "/login";
  }, [clearAccountState]);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [fetchProfile, user]);

  const role = profile?.account_role ?? null;
  const accountId = profile?.account_id ?? null;
  const derived = useMemo(
    () => ({
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    }),
    [role],
  );

  const accountStatus: AccountStatus = !user || profileLoading
    ? "loading"
    : profile && accountId && role
      ? "ready"
      : statusDetail
        ? "error"
        : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        accountStatus,
        accountStatusDetail: statusDetail,
        accountId,
        accountRole: role,
        account,
        accounts,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context) return context;

  return {
    user: null,
    profile: null,
    loading: false,
    profileLoading: false,
    signOut: async () => {
      window.location.href = "/login";
    },
    refreshProfile: async () => {},
    accountStatus: "loading",
    accountStatusDetail: null,
    accountId: null,
    accountRole: null,
    account: null,
    accounts: [],
    defaultCurrency: DEFAULT_CURRENCY,
    isOwner: false,
    isAdmin: false,
    isAgent: false,
    isViewer: false,
    canManageMembers: false,
    canEditSettings: false,
    canSendMessages: false,
  };
}
