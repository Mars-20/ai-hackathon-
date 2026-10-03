// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/ops/admins (Task 5 addendum, Task 7 C1).
// GET → { admins, total }: platform_admins list (user_id + email +
// granted_by/granted_at). POST { user_id, reason? } → grant: platform-tier
// only via the `admin_action` RPC (`grant_platform`, audit-atomic).
// DELETE { user_id } (body or ?user_id=) → revoke: platform-tier only via
// the `admin_action` RPC (`revoke_platform`, audit-atomic; revoking the
// last platform admin is 409 CONFLICT).
// Matrix: platform tier full; workspace tier gets 403 on all three methods
// with a committed `denied` trail (Task-4 PATCH pattern — spec §6
// every-mutation-trail). The RPC is authoritative for the trail:
// non-platform callers still route through `admin_action` from the user
// client (which returns {ok:false,error:"forbidden"} and commits the
// denied row), then the route returns the stable 403 envelope below.
// Viewers get NONE at the requireAdmin gate. Errors use the admin-only
// envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

interface PlatformAdminEntry {
  user_id: string;
  email: string;
  granted_by: string | null;
  granted_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "membership_not_found":
      return 404;
    case "last_platform_admin":
      return 409;
    case "user_id_required":
    case "invalid_user_id":
    case "unknown_action":
      return 400;
    default:
      return 400;
  }
}

function asAdminEntries(
  rows: unknown,
  emailByUser: Map<string, string>,
): PlatformAdminEntry[] {
  if (!Array.isArray(rows)) return [];
  const out: PlatformAdminEntry[] = [];
  for (const item of rows) {
    if (!isRecord(item) || typeof item["user_id"] !== "string") continue;
    const grantedBy = item["granted_by"];
    const grantedAt = item["granted_at"];
    const userId = item["user_id"] as string;
    out.push({
      user_id: userId,
      email: emailByUser.get(userId) ?? "",
      granted_by: typeof grantedBy === "string" ? grantedBy : null,
      granted_at: typeof grantedAt === "string" ? grantedAt : "",
    });
  }
  out.sort((a, b) => a.user_id.localeCompare(b.user_id));
  return out;
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    // Platform-tier only: workspace-tier GET is denied with a committed
    // `denied` trail (Task-4 PATCH pattern). The grant_platform branch
    // checks platform-tier first, so an empty target still records a
    // `forbidden` trail for non-platform callers.
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "grant_platform",
          target: {},
          payload: {},
          reason: "platform admins list read",
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Platform admins are platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    const service = createServiceRoleClient();
    const { data, error } = await service
      .from("platform_admins")
      .select("user_id,granted_by,granted_at")
      .limit(1000);
    if (error) throw error;
    const rows: unknown[] = Array.isArray(data) ? data : [];
    const ids = rows
      .filter(isRecord)
      .map((r) => r["user_id"])
      .filter((v): v is string => typeof v === "string");
    const emailByUser = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles, error: profilesError } = await service
        .from("profiles")
        .select("user_id,email")
        .in("user_id", ids);
      if (profilesError) throw profilesError;
      if (Array.isArray(profiles)) {
        for (const p of profiles) {
          if (!isRecord(p) || typeof p["user_id"] !== "string") continue;
          emailByUser.set(
            p["user_id"] as string,
            typeof p["email"] === "string" ? (p["email"] as string) : "",
          );
        }
      }
    }
    const admins = asAdminEntries(rows, emailByUser);
    return NextResponse.json({ admins, total: admins.length });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const userId =
      isRecord(body) && typeof body["user_id"] === "string"
        ? (body["user_id"] as string)
        : null;
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    // Platform-tier only (Task-4 PATCH deny-trail pattern).
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "grant_platform",
          target: { user_id: userId },
          payload: {},
          reason,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Platform grants are platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!userId || userId.length === 0) {
      return NextResponse.json(
        { error: "user_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const service = createServiceRoleClient();
    const { data: target } = await service.auth.admin.getUserById(userId);
    if (!isRecord(target) || !isRecord(target["user"])) {
      return NextResponse.json(
        { error: "User not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`grant_platform`) so the audit row and the grant commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "grant_platform",
      target: { user_id: userId },
      payload: {},
      reason,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, granted: userId });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function DELETE(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const url = new URL(request.url);
    const fromBody =
      isRecord(body) && typeof body["user_id"] === "string"
        ? (body["user_id"] as string)
        : null;
    const fromQuery = url.searchParams.get("user_id");
    const userId =
      fromBody !== null && fromBody.length > 0
        ? fromBody
        : fromQuery !== null && fromQuery.trim().length > 0
          ? fromQuery.trim()
          : null;
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    // Platform-tier only (Task-4 PATCH deny-trail pattern).
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "revoke_platform",
          target: { user_id: userId },
          payload: {},
          reason,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Platform grants are platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!userId || userId.length === 0) {
      return NextResponse.json(
        { error: "user_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`revoke_platform`) so the audit row and the revoke commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "revoke_platform",
      target: { user_id: userId },
      payload: {},
      reason,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      if (code === "membership_not_found") {
        return NextResponse.json(
          { error: "Platform admin not found", code: "NOT_FOUND" },
          { status: 404 },
        );
      }
      if (code === "last_platform_admin") {
        return NextResponse.json(
          {
            error: "Cannot revoke the last platform admin",
            code: "CONFLICT",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, revoked: userId });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
