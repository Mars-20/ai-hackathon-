// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/content/screen → { ok, decision_id, verdict } (spec §§3,6-7).
// Content policy screen: approve maps to a 'go' decision, reject to 'stop',
// recorded as a decisions row through the single-transaction `admin_action`
// RPC (`screen_decision`) so audit + decision commit atomically; denies
// return { ok:false } with the trail preserved (no RAISE).
// ROLE_RANK max-own (viewer1 member2 admin3 owner4): platform tier bypasses;
// workspace tier needs admin/owner (rank >= 3) in the startup's workspace —
// members are read-only on this path (flag/unflag is their write path).
// NULL-workspace legacy rows are EXCLUDED (400 invalid_workspace_id).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

const VALID_DECISIONS = ["approve", "reject"] as const;
const VALID_CONFIDENCE = ["low", "medium", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "startup_not_found":
      return 404;
    case "invalid_startup_id":
    case "invalid_decision":
    case "invalid_confidence":
    case "invalid_workspace_id":
    case "unknown_action":
      return 400;
    default:
      return 400;
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
    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "Missing screen fields", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const startupId = body["startup_id"];
    const decision = body["decision"];
    const confidence = body["confidence"];
    const rationale = body["rationale"];
    const reason = body["reason"];
    if (typeof startupId !== "string" || startupId.length === 0) {
      return NextResponse.json(
        { error: "startup_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (typeof decision !== "string" || !(VALID_DECISIONS as readonly string[]).includes(decision)) {
      return NextResponse.json(
        { error: "decision must be approve or reject", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (
      confidence !== undefined &&
      (typeof confidence !== "string" || !(VALID_CONFIDENCE as readonly string[]).includes(confidence))
    ) {
      return NextResponse.json(
        { error: "Invalid confidence", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (rationale !== undefined && typeof rationale !== "string") {
      return NextResponse.json(
        { error: "rationale must be a string", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const service = createServiceRoleClient();
    const { data: startup, error: startupError } = await service
      .from("startups")
      .select("id,workspace_id")
      .eq("id", startupId)
      .maybeSingle();
    if (startupError) throw startupError;
    if (!isRecord(startup)) {
      return NextResponse.json(
        { error: "Startup not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    const startupWs = typeof startup["workspace_id"] === "string" ? (startup["workspace_id"] as string) : null;
    // NULL-workspace legacy rows are excluded from screening.
    if (startupWs === null) {
      return NextResponse.json(
        { error: "Startup has no workspace scope", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Route-level ROLE_RANK max-own guard (the RPC re-enforces atomically):
    // workspace tier needs admin/owner in the startup's workspace. Scoping
    // note: this single-startup mutation resolves the startup's workspace
    // first and checks membership/rank on it — the single-id equivalent of
    // the list-path `.in('workspace_id', workspaceIds)` predicate (which
    // lives in scopedQuery); the RPC re-checks scope + rank atomically.
    if (admin.tier !== "platform") {
      if (!admin.workspaceIds.includes(startupWs)) {
        return NextResponse.json(
          { error: "Startup out of scope", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const userClient = await createServerSupabaseClient();
      const { data: callerRow, error: callerError } = await userClient
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", startupWs)
        .eq("user_id", admin.user.id)
        .maybeSingle();
      if (callerError) throw callerError;
      const callerRole =
        isRecord(callerRow) && typeof callerRow["role"] === "string"
          ? (callerRow["role"] as string)
          : null;
      if (callerRole === null || (ROLE_RANK[callerRole] ?? 0) < (ROLE_RANK["admin"] ?? 3)) {
        return NextResponse.json(
          { error: "Screening requires an admin role or higher", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "screen_decision",
      target: { startup_id: startupId },
      payload: {
        decision,
        ...(typeof confidence === "string" ? { confidence } : {}),
        ...(typeof rationale === "string" ? { rationale } : {}),
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
    const result = isRecord(data) && isRecord(data["result"]) ? (data["result"] as Record<string, unknown>) : null;
    return NextResponse.json({
      ok: true,
      decision_id: result !== null && typeof result["decision_id"] === "string" ? result["decision_id"] : null,
      verdict: result !== null && typeof result["verdict"] === "string" ? result["verdict"] : null,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
