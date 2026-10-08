"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  Brain, Plus, LogOut, Users, ChevronDown,
  ArrowRight, FlaskConical, Target, CheckCircle2, Clock,
  TrendingUp, Zap, Crown, User as UserIcon, History, ShieldCheck, MessageCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { MEMORY_COPY } from "@/lib/companion/copy";
import { StageStepper } from "@/components/StageStepper";
import type { AuthUser, Workspace, WorkspaceMember, MemberRole, Startup } from "@/lib/types";

interface WorkspaceWithRole extends Workspace {
  role: MemberRole;
}

interface DashboardData {
  user: AuthUser | null;
  workspaces: WorkspaceWithRole[];
  activeWorkspace: WorkspaceWithRole | null;
  members: (WorkspaceMember & { user_email?: string; user_name?: string })[];
  startups: Startup[];
}

const ROLE_BADGE_STYLE: Record<MemberRole, string> = {
  owner:  "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  admin:  "bg-brand-500/20 text-brand-400 border-brand-500/30",
  member: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  viewer: "bg-slate-700/20 text-slate-500 border-slate-700/30",
};

export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("nav");

  const [data, setData] = useState<DashboardData>({
    user: null,
    workspaces: [],
    activeWorkspace: null,
    members: [],
    startups: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showWorkspaceSwitcher, setShowWorkspaceSwitcher] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  // Trial paywall (Task 7): consumed/paused accounts get this modal (NOT a
  // redirect) when they click "New validation".
  const [showPaywallModal, setShowPaywallModal] = useState(false);
  const paywallCloseRef = useRef<HTMLButtonElement>(null);

  // Trial paywall (Task 7 R1): dialog semantics — autofocus close on open,
  // ESC-to-close, return focus to the trigger on close.
  useEffect(() => {
    if (!showPaywallModal) return;
    paywallCloseRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPaywallModal(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.getElementById("new-startup-btn")?.focus();
    };
  }, [showPaywallModal]);



  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) { router.replace(withLocale("/login", locale)); return; }

    // Admin entry point: show the /admin link only when the admin gate passes.
    // The gate itself stays server-side (requireAdmin); this is UX-only.
    try {
      const meRes = await fetch("/api/admin/me");
      if (meRes.ok) {
        const meBody: unknown = await meRes.json();
        if (typeof meBody === "object" && meBody !== null && "tier" in meBody) setIsAdmin(true);
      }
    } catch { /* non-admin or offline — link stays hidden */ }

    const user: AuthUser = {
      id: authUser.id,
      email: authUser.email!,
      full_name: authUser.user_metadata?.full_name,
      avatar_url: authUser.user_metadata?.avatar_url,
      created_at: authUser.created_at,
    };

    // Fetch workspaces the user belongs to (via workspace_members join)
    const { data: memberRows } = await supabase
      .from("workspace_members")
      .select("role, workspaces(*)")
      .eq("user_id", user.id);

    const workspaces: WorkspaceWithRole[] = (memberRows || []).map((row: unknown) => {
      const r = row as { workspaces: Workspace | Workspace[]; role: string };
      const ws = Array.isArray(r.workspaces) ? r.workspaces[0] : r.workspaces;
      return { ...ws, role: r.role as MemberRole };
    });

    // Honor the previously-selected workspace across reloads (validate +
    // history scope persistence to this id). Fall back to first membership.
    let activeWorkspace = workspaces[0] || null;
    try {
      const stored = localStorage.getItem("active_workspace_id");
      if (stored) {
        const match = workspaces.find((w) => w.id === stored);
        if (match) activeWorkspace = match;
      }
    } catch { /* private mode — fall back to first */ }

    // Fetch members of active workspace
    let members: DashboardData["members"] = [];
    let startups: Startup[] = [];

    if (activeWorkspace) {
      const { data: memberData } = await supabase
        .from("workspace_members")
        .select("*")
        .eq("workspace_id", activeWorkspace.id);
      members = memberData || [];

      const { data: startupData } = await supabase
        .from("startups")
        .select("*")
        .eq("workspace_id", activeWorkspace.id)
        .order("created_at", { ascending: false });
      startups = startupData || [];
    }

    setData({ user, workspaces, activeWorkspace, members, startups });
    // Sync for /validate: the agent scopes persistence to this workspace.
    // Without this, validate sends no workspace_id and runs land in a
    // different (or personal-fallback) workspace — history looks empty.
    try {
      if (activeWorkspace) localStorage.setItem("active_workspace_id", activeWorkspace.id);
    } catch {}
    setIsLoading(false);
  }, [supabase, router, locale]);

  // ── Load user + workspace data ─────────────────────────────────────────────
  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // ── Task 5: persist account locale ─────────────────────────────────────────
  // LanguageSwitcher writes the NEXT_LOCALE cookie; this effect writes
  // profiles.locale so the account locale follows the switch ("switch writes
  // both", plan Task 5). DB wins at login (login page + auth callback read
  // it back into the cookie). Fail-open: persistence never blocks the UI
  // (the RLS update policy lands with the Task 5 migration; until then the
  // write is a silent no-op).
  const lastPersistedLocale = useRef<AppLocale | null>(null);
  const accountId = data.user?.id;
  useEffect(() => {
    if (!accountId || lastPersistedLocale.current === locale) return;
    lastPersistedLocale.current = locale;
    void supabase.from("profiles").update({ locale }).eq("user_id", accountId);
  }, [supabase, accountId, locale]);

  async function switchWorkspace(ws: WorkspaceWithRole) {
    setShowWorkspaceSwitcher(false);
    try { localStorage.setItem("active_workspace_id", ws.id); } catch {}
    setData(prev => ({ ...prev, activeWorkspace: ws }));
    // Re-load members/startups for the new workspace
    const [{ data: memberData }, { data: startupData }] = await Promise.all([
      supabase.from("workspace_members").select("*").eq("workspace_id", ws.id),
      supabase.from("startups").select("*").eq("workspace_id", ws.id).order("created_at", { ascending: false }),
    ]);
    setData(prev => ({ ...prev, members: memberData || [], startups: startupData || [] }));
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace(withLocale("/login", locale));
  }

  // Trial paywall (Task 7): fresh entitlement check on "New validation".
  // Consumed/paused accounts get the paywall modal (NOT a redirect);
  // every other status keeps the existing direct navigation to /validate.
  // preventDefault runs SYNCHRONOUSLY: an async preventDefault (after the
  // fetch await) always loses the race and the browser navigates anyway.
  async function handleNewValidation(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    try {
      const res = await fetch("/api/entitlements/me", { cache: "no-store" });
      if (!res.ok) {
        router.push(withLocale("/validate", locale));
        return;
      }
      const ent = (await res.json()) as { status?: string };
      if (ent.status === "trial_consumed" || ent.status === "paused") {
        setShowPaywallModal(true);
        return;
      }
    } catch {
      /* fail-open: fall through to /validate */
    }
    router.push(withLocale("/validate", locale));
  }

  async function sendInvite() {
    if (!data.activeWorkspace || !inviteEmail) return;
    setInviteStatus("sending");
    // In production: call /api/workspace/invite which sends email + creates WorkspaceInvite row
    const res = await fetch("/api/workspace/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: data.activeWorkspace.id,
        email: inviteEmail,
        role: inviteRole,
      }),
    });
    if (res.ok) {
      setInviteStatus("sent");
      setInviteEmail("");
      setTimeout(() => { setShowInviteModal(false); setInviteStatus("idle"); }, 2000);
    } else {
      setInviteStatus("error");
    }
  }

  async function createNewWorkspace() {
    if (!data.user) return;
    const name = prompt("Workspace name:");
    if (!name) return;
    const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") + "-" + Date.now();
    const { data: ws, error } = await supabase.from("workspaces").insert({
      name, slug, owner_id: data.user.id, plan: "free",
    }).select().single();
    if (!error && ws) {
      const { error: memberError } = await supabase.from("workspace_members").insert({
        workspace_id: ws.id, user_id: data.user.id, role: "owner", joined_at: new Date().toISOString(),
      });
      if (memberError) {
        alert("Workspace created but membership failed — please refresh. If this persists, run migration 0009_workspace_bootstrap.sql in Supabase.");
        return;
      }
      try { localStorage.setItem("active_workspace_id", (ws as { id: string }).id); } catch {}
      loadDashboard();
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-brand-500/30 border-t-brand-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500 text-sm">Loading your workspace…</p>
        </div>
      </div>
    );
  }

  const { user, workspaces, activeWorkspace, members, startups } = data;
  const canInvite = activeWorkspace && ["owner", "admin"].includes(activeWorkspace.role);

  return (
    <div className="min-h-dvh">
      {/* ── HEADER ──────────────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5 safe-top">
        <div className="container-app flex items-center justify-between h-14">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
              <Brain className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">
              Validation <span className="gradient-text">Copilot</span>
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
            {/* Language switch (i18n Task 3) */}
            <Suspense>
              <LanguageSwitcher locale={locale} />
            </Suspense>
            {/* Workspace Switcher */}
            <div className="relative">
              <button
                onClick={() => setShowWorkspaceSwitcher(!showWorkspaceSwitcher)}
                className="glass glass-hover flex items-center gap-2 px-1.5 sm:px-3 py-1.5 rounded-lg text-xs border border-white/5"
                id="workspace-switcher-btn"
              >
                <span className="w-5 h-5 rounded bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white text-xs font-bold">
                  {activeWorkspace?.name?.[0] || "W"}
                </span>
                <span className="hidden sm:inline text-slate-300 max-w-24 truncate">{activeWorkspace?.name || "No Workspace"}</span>
                <span className={`hidden sm:inline text-xs px-1.5 py-0.5 rounded border ${ROLE_BADGE_STYLE[activeWorkspace?.role || "member"]}`}>
                  {activeWorkspace?.role}
                </span>
                <ChevronDown className="w-3 h-3 text-slate-500 hidden sm:block" />
              </button>

              {showWorkspaceSwitcher && (
                <div className="absolute top-full right-0 mt-2 w-72 glass rounded-2xl border border-white/10 shadow-xl p-2 z-50">
                  <p className="text-xs text-slate-500 px-3 py-2 font-medium uppercase tracking-wider">Your Workspaces</p>
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => switchWorkspace(ws)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all text-sm ${
                        activeWorkspace?.id === ws.id ? "bg-brand-500/20 text-brand-300" : "text-slate-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {ws.name[0]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{ws.name}</div>
                        <div className="text-xs text-slate-500 capitalize">{ws.role} · {ws.plan}</div>
                      </div>
                      {ws.role === "owner" && <Crown className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />}
                    </button>
                  ))}
                  <div className="border-t border-white/5 mt-2 pt-2">
                    <button
                      onClick={createNewWorkspace}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/5 text-sm transition-all"
                      id="create-workspace-btn"
                    >
                      <Plus className="w-4 h-4" /> New Workspace
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Admin entry (gate-checked, UX-only) */}
            {isAdmin && (
              <Link
                href={withLocale("/admin", locale)}
                className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
                id="admin-link"
                title="Admin"
                aria-label="Admin"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-brand-400" />
                <span className="hidden sm:inline">Admin</span>
              </Link>
            )}

            {/* Assistant entry */}
            <Link
              href={withLocale("/assistant", locale)}
              className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
              id="assistant-link"
              title={t("assistant")}
              aria-label={t("assistant")}
            >
              <MessageCircle className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">{t("assistant")}</span>
            </Link>

            {/* History entry */}
            <Link
              href={withLocale("/history", locale)}
              className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
              id="history-link"
              title={t("history")}
              aria-label={t("history")}
            >
              <History className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">{t("history")}</span>
            </Link>

            {/* Memories console entry (companion Task 9) */}
            <Link
              href={withLocale("/memories", locale)}
              className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
              id="memories-link"
              title={MEMORY_COPY.page_title}
              aria-label={MEMORY_COPY.page_title}
            >
              <Brain className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">{MEMORY_COPY.page_title}</span>
            </Link>

            {/* User avatar / sign out */}
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                {user?.avatar_url
                  /* eslint-disable-next-line @next/next/no-img-element */
                  ? <img src={user.avatar_url} alt="avatar" className="w-full h-full object-cover" />
                  : user?.full_name?.[0] || user?.email?.[0]?.toUpperCase() || "?"}
              </div>
              <button onClick={handleSignOut} className="text-slate-500 hover:text-red-400 transition-colors" title="Sign out">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ── MAIN CONTENT ───────────────────────────────────────────────────── */}
      <main className="pt-20 pb-16 px-6">
        <div className="container-app max-w-5xl">

          {/* Welcome */}
          <div className="mb-8">
            <h1 className="text-2xl font-black mb-1">
              Welcome back, <span className="gradient-text">{user?.full_name || user?.email?.split("@")[0]}</span> 👋
            </h1>
            <p className="text-slate-400 text-sm">
              {activeWorkspace?.name} · {startups.length} startup{startups.length !== 1 ? "s" : ""} · {members.length} member{members.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { label: "Startups", value: startups.length, icon: <Target className="w-4 h-4" />, color: "#5c7cfa" },
              { label: "Team Members", value: members.length, icon: <Users className="w-4 h-4" />, color: "#7950f2" },
              { label: "Experiments", value: "—", icon: <FlaskConical className="w-4 h-4" />, color: "#74c0fc" },
              { label: "Decisions", value: "—", icon: <TrendingUp className="w-4 h-4" />, color: "#51cf66" },
            ].map((stat) => (
              <div key={stat.label} className="glass rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">{stat.label}</span>
                  <span style={{ color: stat.color }}>{stat.icon}</span>
                </div>
                <div className="text-2xl font-black" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Startups list */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-200 text-sm">Your Startups</h2>
                <Link
                  href={withLocale("/validate", locale)}
                  onClick={handleNewValidation}
                  className="btn-glow text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5"
                  id="new-startup-btn"
                >
                  <Plus className="w-3.5 h-3.5" /> New Startup
                </Link>
              </div>

              {startups.length === 0 ? (
                <div className="glass rounded-2xl p-10 text-center border border-dashed border-white/10">
                  <Brain className="w-8 h-8 text-slate-600 mx-auto mb-3" />
                  <p className="text-slate-400 text-sm mb-4">No startups yet in this workspace.</p>
                  <Link href={withLocale("/validate", locale)} className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg inline-flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" /> Validate Your First Idea
                  </Link>
                </div>
              ) : (
                startups.map((s) => (
                  <div key={s.id} className="glass glass-hover rounded-2xl p-5 border border-white/5 group">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-slate-200 mb-1">{s.name}</div>
                        <p className="text-xs text-slate-400 line-clamp-2">{s.one_liner}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-slate-500">{s.domain}</span>
                        </div>
                        <StageStepper
                          startupId={s.id}
                          stage={s.stage}
                          track={s.stage_track ?? null}
                          customOrder={s.stage_order ?? null}
                        />
                      </div>
                      <Link
                        href={withLocale(`/validate?startup_id=${s.id}`, locale)}
                        className="text-slate-500 group-hover:text-brand-400 transition-colors flex-shrink-0"
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Team members panel */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-200 text-sm">Team</h2>
                {canInvite && (
                  <button
                    onClick={() => setShowInviteModal(true)}
                    className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 transition-colors"
                    id="invite-member-btn"
                  >
                    <Plus className="w-3.5 h-3.5" /> Invite
                  </button>
                )}
              </div>

              <div className="glass rounded-2xl p-4 space-y-3">
                {members.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-4">No members loaded yet.</p>
                ) : (
                  members.map((m) => (
                    <div key={m.id} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        <UserIcon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-slate-300 truncate">
                          {m.user_name || m.user_id.slice(0, 8) + "..."}
                        </div>
                        <div className="text-xs text-slate-500">
                          {m.joined_at ? `Joined ${new Date(m.joined_at).toLocaleDateString()}` : "Pending"}
                        </div>
                      </div>
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${ROLE_BADGE_STYLE[m.role]}`}>
                        {m.role}
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* Quick actions */}
              <div className="glass rounded-2xl p-4 space-y-2">
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">Quick Actions</p>
                {[
                  { label: "Invite Members", icon: <Users className="w-3.5 h-3.5" />, action: () => setShowInviteModal(true), disabled: !canInvite },
                  { label: t("history"), icon: <History className="w-3.5 h-3.5" />, href: withLocale("/history", locale) },
                  { label: t("validate"), icon: <FlaskConical className="w-3.5 h-3.5" />, href: withLocale("/validate", locale) },
                ].map((action, i) => (
                  action.href ? (
                    <Link key={i} href={action.href} className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 py-1.5 transition-colors">
                      <span className="text-slate-600">{action.icon}</span> {action.label}
                    </Link>
                  ) : (
                    <button key={i} onClick={action.action} disabled={action.disabled}
                      className="w-full flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      <span className="text-slate-600">{action.icon}</span> {action.label}
                    </button>
                  )
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── INVITE MODAL ──────────────────────────────────────────────────── */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="glass rounded-3xl p-8 w-full max-w-md border border-white/10">
            <h3 className="font-bold text-slate-200 text-lg mb-1">Invite to Workspace</h3>
            <p className="text-slate-400 text-xs mb-6">They&apos;ll receive an email with a join link. Only {activeWorkspace?.name} members can access its data.</p>

            <div className="space-y-4">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full glass rounded-xl px-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="invite-email-input"
              />

              <div className="grid grid-cols-4 gap-2">
                {(["viewer", "member", "admin", "owner"] as MemberRole[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setInviteRole(r)}
                    className={`py-2 rounded-xl text-xs font-medium border transition-all capitalize ${
                      inviteRole === r
                        ? ROLE_BADGE_STYLE[r] + " scale-105"
                        : "border-white/5 text-slate-500 hover:bg-white/5"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>

              <div className="text-xs text-slate-500 p-3 glass rounded-xl">
                <strong className="text-slate-400">Role permissions:</strong><br />
                {inviteRole === "viewer" && "Read-only access. Cannot edit or run experiments."}
                {inviteRole === "member" && "Can edit startups and run experiments. Cannot invite others."}
                {inviteRole === "admin" && "Full edit + invite access. Cannot delete workspace."}
                {inviteRole === "owner" && "Full control including workspace deletion."}
              </div>

              {inviteStatus === "sent" && (
                <div className="flex items-center gap-2 text-green-400 text-xs p-3 glass rounded-xl border border-green-500/20">
                  <CheckCircle2 className="w-4 h-4" /> Invite sent successfully!
                </div>
              )}
              {inviteStatus === "error" && (
                <div className="text-red-400 text-xs p-3 glass rounded-xl border border-red-500/20">
                  ❌ Failed to send invite. Check the email and try again.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setShowInviteModal(false); setInviteStatus("idle"); setInviteEmail(""); }}
                  className="flex-1 glass py-3 rounded-xl text-sm text-slate-400 hover:text-slate-200 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={sendInvite}
                  disabled={!inviteEmail || inviteStatus === "sending"}
                  className="flex-1 btn-glow text-white font-bold py-3 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  id="send-invite-btn"
                >
                  {inviteStatus === "sending"
                    ? <><Clock className="w-4 h-4 animate-spin" /> Sending…</>
                    : <><Users className="w-4 h-4" /> Send Invite</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── TRIAL PAYWALL MODAL (Task 7) ─────────────────────────────────── */}
      {showPaywallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div dir="rtl" role="dialog" aria-modal="true" aria-labelledby="paywall-modal-title" className="glass rounded-3xl p-8 w-full max-w-md border border-white/10">
            <h3 id="paywall-modal-title" className="font-bold text-slate-200 text-lg mb-2">انتهت تجربتك المجانية</h3>
            <p className="text-slate-400 text-sm mb-6">
              استخدمت مشروعك التجريبي المجاني — جميع مشاريعك ونتائجك محفوظة ويمكنك الاطلاع عليها في أي وقت. اشترك لبدء مشروع جديد.
            </p>
            <div className="flex gap-3">
              <Link
                href={withLocale("/plans", locale)}
                id="paywall-modal-cta"
                className="flex-1 btn-glow text-white font-bold py-3 rounded-xl text-sm text-center"
              >
                عرض خطط الاشتراك
              </Link>
              <button
                ref={paywallCloseRef}
                onClick={() => setShowPaywallModal(false)}
                aria-label="إغلاق النافذة"
                className="flex-1 glass py-3 rounded-xl text-sm text-slate-400 hover:text-slate-200 transition-all"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
