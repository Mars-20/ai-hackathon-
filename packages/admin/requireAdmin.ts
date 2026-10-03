// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/requireAdmin.ts — dual-tier admin gate (spec §2).
// Every /api/admin/* route starts with requireAdmin(); the layout redirect
// is UX-only and never authoritative.
//
// Tiers:
//   platform  — row in platform_admins (checked via is_platform_admin RPC,
//               SECURITY DEFINER, fixed search_path — Task 1 migration).
//   workspace — at least one workspace_members row with a non-viewer role
//               (member/admin/owner per the §7 matrix; viewers get 403).
//
// Throws structural AdminError: 401 (no user), 403 (viewer or none).
//
// DEPENDENCY-INJECTION design (deliberate): the client is expressed as three
// narrow closures (RequireAdminDeps) rather than the Supabase client type.
// Matching the real client's GENERIC builder methods against a concrete
// structural interface triggers TS2589 (excessively deep instantiation),
// while generic INFERENCE (closures typed from real calls) stays shallow.
// Callers adapt in ~5 lines — see the Task 2 report for the canonical
// adapter snippet — and stub tests just pass three async functions.
// This module has zero runtime imports (only `import type`), so it compiles
// anywhere, including outside apps/web/node_modules resolution.
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminError } from "./errors";

export interface AdminUser {
  id: string;
  email?: string;
}

export type AdminTier = "platform" | "workspace";

export interface RequireAdminResult {
  user: AdminUser;
  tier: AdminTier;
  workspaceIds: string[];
}

export interface MembershipRow {
  workspace_id: string;
  role: string;
}

export function isMembershipRow(value: unknown): value is MembershipRow {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["workspace_id"] === "string" && typeof record["role"] === "string";
}

export interface RequireAdminDeps {
  getUser(): PromiseLike<{ data: { user: AdminUser | null } }>;
  checkPlatformAdmin(userId: string): PromiseLike<boolean>;
  listMemberships(userId: string): PromiseLike<MembershipRow[]>;
}

/** Roles that grant admin-area access; viewers are explicitly excluded. */
const ELIGIBLE_ROLES: ReadonlySet<string> = new Set(["member", "admin", "owner"]);

function adminError(status: number, code: string, message: string): AdminError {
  const err = new Error(message);
  err.name = "AdminError";
  const withProps = err as Error & { status: number; code: string };
  withProps.status = status;
  withProps.code = code;
  return withProps as AdminError;
}

export async function requireAdmin(deps: RequireAdminDeps): Promise<RequireAdminResult> {
  const { data } = await deps.getUser();
  const user: AdminUser | null = data.user;
  if (!user) {
    throw adminError(401, "UNAUTHORIZED", "Authentication required");
  }

  // Platform tier via SECURITY DEFINER helper (Task 1 migration).
  // Fail CLOSED on RPC error: fall through to the workspace path, which
  // still enforces membership (a missing migration never grants access).
  let isPlatform = false;
  try {
    isPlatform = await deps.checkPlatformAdmin(user.id);
  } catch (err: unknown) {
    console.warn("[admin:requireAdmin] platform check failed, failing closed", err);
    isPlatform = false;
  }

  const memberships: MembershipRow[] = await deps.listMemberships(user.id);
  const ownWorkspaceIds = memberships.map((m) => m.workspace_id);

  if (isPlatform) {
    return {
      user: { id: user.id, email: user.email },
      tier: "platform",
      workspaceIds: ownWorkspaceIds,
    };
  }

  const eligibleIds = memberships
    .filter((m) => ELIGIBLE_ROLES.has(m.role))
    .map((m) => m.workspace_id);
  if (eligibleIds.length === 0) {
    throw adminError(403, "FORBIDDEN", "Admin access required");
  }
  return {
    user: { id: user.id, email: user.email },
    tier: "workspace",
    workspaceIds: eligibleIds,
  };
}
