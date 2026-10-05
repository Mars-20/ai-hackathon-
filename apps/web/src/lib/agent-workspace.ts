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
  await supabase.from("workspace_members").insert({
    workspace_id: created.id,
    user_id: userId,
    role: "owner",
    joined_at: new Date().toISOString(),
  });
  return created.id;
}
