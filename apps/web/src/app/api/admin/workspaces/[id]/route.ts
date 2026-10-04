// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/workspaces/[id] → { workspace, members, metrics }.
// PATCH /api/admin/workspaces/[id] — plan/status write (privileged,
// audit-atomic via the `admin_action` RPC `update_workspace`, spec §§6-7).
// Matrix: platform tier full; workspace tier admin/owner/member read-only
// for GET when the id is in scope (viewer-NONE at the requireAdmin gate);
// PATCH is platform-tier only (spec I1: plans read-only in v1 for the
// workspace tier — workspace callers get 403 with a denied audit trail).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
} from "@/lib/supabase/server";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryWorkspaceDetail } from "@/lib/admin-queries/workspaces";

const VALID_PLANS = ["free", "pro", "team"] as const;
const VALID_STATUS = ["active", "suspended"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "workspace_not_found":
      return 404;
    case "invalid_plan":
    case "invalid_status":
    case "invalid_payload":
    case "workspace_id_required":
    case "invalid_workspace_id":
    case "unknown_action":
      return 400;
    default:
      return 400;
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
  const { id } = await context.params;

  try {
    const deps = await createQueryDeps(admin);
    const dto = await queryWorkspaceDetail(deps, id);
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
  const { id } = await context.params;

  try {
    // Platform-tier only (spec I1): workspace-tier PATCH is denied with a
    // committed `denied` trail (spec §6 every-mutation-trail). The RPC is
    // authoritative for the trail: non-platform callers still route through
    // `admin_action`/`update_workspace` from the user client (which returns
    // {ok:false,error:"forbidden"} and commits the denied row), then the
    // route returns the stable 403 envelope below. Response codes preserved.
    const body: unknown = await request.json().catch(() => null);
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "update_workspace",
          target: { workspace_id: id },
          payload: {
            ...(isRecord(body) && typeof body["plan"] === "string" ? { plan: body["plan"] } : {}),
            ...(isRecord(body) && typeof body["status"] === "string" ? { status: body["status"] } : {}),
          },
          reason: isRecord(body) && typeof body["reason"] === "string" ? body["reason"] : null,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Workspace plan/status is platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }
    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "Missing plan/status fields", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const plan = body["plan"];
    const status = body["status"];
    const reason = body["reason"];
    if (plan === undefined && status === undefined) {
      return NextResponse.json(
        { error: "Nothing to update: provide plan and/or status", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (plan !== undefined && (typeof plan !== "string" || !(VALID_PLANS as readonly string[]).includes(plan))) {
      return NextResponse.json(
        { error: "Invalid plan", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (status !== undefined && (typeof status !== "string" || !(VALID_STATUS as readonly string[]).includes(status))) {
      return NextResponse.json(
        { error: "Invalid status", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`update_workspace`) so the audit row and the mutation commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "update_workspace",
      target: { workspace_id: id },
      payload: {
        ...(typeof plan === "string" ? { plan } : {}),
        ...(typeof status === "string" ? { status } : {}),
      },
      reason: typeof reason === "string" ? reason : null,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, result: data ?? null });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
