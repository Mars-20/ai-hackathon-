// ─────────────────────────────────────────────────────────────────────────────
// Agent workspace resolution — personal-workspace fallback for persistence.
// prod enforces workspace_id NOT NULL on startups/assumptions/evidence/
// experiments/decisions (migration 0008_workspace_id_not_null). The agent
// persist path must therefore NEVER write NULL: a NULL write fails closed
// at the DB, the best-effort catch swallows it, and the run's decision is
// lost forever (history stays empty). Resolution order (mirrors the
// auth/callback first-login flow, the working reference):
//   1. caller-requested workspace the user belongs to → it;
//   2. otherwise the caller's first membership → it;
//   3. otherwise create a personal workspace + owner membership → it.
// Returns null only when persistence must be skipped (caller keeps its
// explicit skip-with-warning path; streaming is never blocked).
// ─────────────────────────────────────────────────────────────────────────────

import type { createServerSupabaseClient } from "@/lib/supabase/server";

// The user-scoped server client. Tests pass a structurally-compatible fake
// (cast once at the seam); the helper only uses from/select/eq/limit/
// insert/maybeSingle/single — all exercised by agent-workspace.test.ts.
export type WorkspaceClient = Awaited<
  ReturnType<typeof createServerSupabaseClient>
>;

export async function resolveEffectiveWorkspaceId(
  supabase: WorkspaceClient,
  userId: string,
  requestedId: string
): Promise<string | null> {
  // 1. Explicit request: honor only with membership (never trust the body).
  // Fail-closed on mismatch (null, no writes) — saving to a different
  // workspace than requested would leak data across tenants. Stale
  // localStorage ids are healed by dashboard sync (active_workspace_id is
  // rewritten on load/switch), so mismatch means deleted/removed workspace.
  if (requestedId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", requestedId)
      .eq("user_id", userId)
      .maybeSingle();
    const row = membership as { workspace_id?: string } | null;
    return row?.workspace_id ? requestedId : null;
  }

  // 2. First existing membership.
  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1);
  const first = (memberships as Array<{ workspace_id?: string }> | null)?.[0]
    ?.workspace_id;
  if (first) return first;

  // 3. No membership at all (email-signup users skip the OAuth callback
  // auto-create): create a personal workspace + owner membership, same
  // shape as app/auth/callback/route.ts.
  const slug = `personal-${userId.slice(0, 8)}-${Date.now()}`;
  const { data: workspace } = await supabase
    .from("workspaces")
    .insert({
      name: "Personal Workspace",
      slug,
      owner_id: userId,
      plan: "free",
    })
    .select()
    .single();
  const created = workspace as { id?: string } | null;
  if (!created?.id) return null;
  const { error: memberError } = await supabase.from("workspace_members").insert({
    workspace_id: created.id,
    user_id: userId,
    role: "owner",
    joined_at: new Date().toISOString(),
  });
  // RLS bootstrap deadlock (members_insert requires owner/admin role, but the
  // first member has no role yet) surfaces here as memberError. Return the id
  // only when membership landed; otherwise null so the caller skips
  // persistence with an explicit warning instead of writing orphan rows.
  if (memberError) return null;
  return created.id;
}

// Spend-bucket guard (review #12 follow-up): the agent's spend ledger is
// keyed by a workspace id taken from the request body. Verify-only probe —
// NEVER creates anything, returns a boolean. True only when the user is a
// member of exactly the given workspace. Fails CLOSED (false) on empty ids,
// lookup errors, and RLS-denied reads: the caller falls back to ledgering
// under the authenticated user id. A false negative only degrades pooling,
// never grants cap evasion — so false stays the safe answer.
export async function verifyWorkspaceMembership(
  supabase: WorkspaceClient,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  if (!userId || !workspaceId) return false;
  try {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    const row = membership as { workspace_id?: string } | null;
    return row?.workspace_id === workspaceId;
  } catch {
    return false;
  }
}
