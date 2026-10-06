// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/requests — admin subscription-request queue (Task 8)
// Owner-only queue for the manual subscription approval flow. The owner gate
// reuses the repo PLATFORM_OWNER_EMAILS env contract (comma-separated emails,
// case-insensitive compare) defined canonically in lib/platform-owner.ts
// (repo-wide search shows no pre-existing mechanism).
//   PLATFORM_OWNER_EMAILS="owner@example.com,second@example.com"
// The env is EMPTY pre-launch → the owner list is [] → every caller gets the
// stable 403 {"error":"محظور","code":"FORBIDDEN"} (operational pre-launch
// step: the owner must set the env; see the Task 8 report / R3 notes).
//
// Money-adjacent posture: every state change goes through the `admin_action`
// RPC (approve_subscription / reject_subscription / pause_subscription) —
// NEVER direct table writes (no update/insert/upsert/delete anywhere here;
// user_entitlements is read for display context only, never trusted).
// The mutation RPC runs on the REQUEST USER client (repo convention per the
// ops/email + workspaces admin routes): auth.uid() + is_platform_admin()
// enforcement and the audit actor attribution only work with the caller's
// JWT — a service-role call would arrive with auth.uid() NULL and every
// branch would deny not_authenticated. Cross-user READS (queue list,
// request lookup, entitlement context) use the service-role client because
// RLS intentionally exposes own-rows-only to the user client.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { isPlatformOwnerEmail } from "@/lib/platform-owner";

// ── Owner gate: canonical PLATFORM_OWNER_EMAILS contract lives in ───────────
// ── lib/platform-owner.ts (route modules must export routes only). ──────────

function forbidden() {
  return NextResponse.json({ error: "محظور", code: "FORBIDDEN" }, { status: 403 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUEUE_ACTIONS = ["approve", "reject", "pause"] as const;
type QueueAction = (typeof QUEUE_ACTIONS)[number];

const RPC_ACTION: Record<QueueAction, string> = {
  approve: "approve_subscription",
  reject: "reject_subscription",
  pause: "pause_subscription",
};

const RESULT_STATUS: Record<QueueAction, string> = {
  approve: "approved",
  reject: "rejected",
  pause: "paused",
};

const LIST_STATUSES = ["pending", "approved", "rejected"] as const;

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "forbidden":
      return 403;
    case "user_id_required":
    case "invalid_plan":
    case "unknown_action":
      return 400;
    default:
      return 400;
  }
}

// ── GET: pending queue newest-first with entitlement display context ────────
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformOwnerEmail(user.email)) {
    return forbidden();
  }

  const statusParam =
    request.nextUrl.searchParams.get("status") ?? "pending";
  if (
    !(LIST_STATUSES as readonly string[]).includes(statusParam)
  ) {
    return NextResponse.json(
      { error: "Invalid status", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const service = createServiceRoleClient();
  const { data: rows, error } = await service
    .from("subscription_requests")
    .select("id,user_id,plan,full_name,phone,company,status,created_at")
    .eq("status", statusParam)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json(
      { error: "Failed to list requests" },
      { status: 500 },
    );
  }

  const list = (Array.isArray(rows) ? rows : []) as Array<
    Record<string, unknown>
  >;
  const userIds = list
    .map((row) => row["user_id"])
    .filter((id): id is string => typeof id === "string");

  let entitlements: Array<Record<string, unknown>> = [];
  if (userIds.length > 0) {
    const { data: entRows, error: entError } = await service
      .from("user_entitlements")
      .select("user_id,status,plan")
      .in("user_id", userIds);
    if (entError) {
      return NextResponse.json(
        { error: "Failed to list requests" },
        { status: 500 },
      );
    }
    entitlements = (Array.isArray(entRows) ? entRows : []) as Array<
      Record<string, unknown>
    >;
  }
  const entByUser = new Map<string, { status: unknown; plan: unknown }>();
  for (const ent of entitlements) {
    if (typeof ent["user_id"] === "string") {
      entByUser.set(ent["user_id"] as string, {
        status: ent["status"] ?? null,
        plan: ent["plan"] ?? null,
      });
    }
  }

  return NextResponse.json({
    requests: list.map((row) => ({
      id: row["id"],
      user_id: row["user_id"],
      plan: row["plan"],
      full_name: row["full_name"],
      phone: row["phone"],
      company: row["company"] ?? null,
      status: row["status"],
      created_at: row["created_at"],
      entitlement:
        typeof row["user_id"] === "string"
          ? (entByUser.get(row["user_id"] as string) ?? null)
          : null,
    })),
  });
}

// ── POST: approve / reject / pause one request via admin_action ─────────────
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid input", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }
  const record = isRecord(body) ? body : null;
  const requestId =
    record && typeof record["request_id"] === "string"
      ? (record["request_id"] as string)
      : null;
  const action =
    record && typeof record["action"] === "string"
      ? (record["action"] as string)
      : null;
  const plan =
    record && typeof record["plan"] === "string"
      ? (record["plan"] as string)
      : null;

  if (!requestId || !UUID_RE.test(requestId)) {
    return NextResponse.json(
      { error: "Invalid request_id", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }
  if (!action || !(QUEUE_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: "Invalid action", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }
  if (plan !== null && plan !== "pro" && plan !== "team") {
    return NextResponse.json(
      { error: "Invalid plan", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  if (!isPlatformOwnerEmail(user.email)) {
    return forbidden();
  }

  const queueAction = action as QueueAction;

  // Resolve the target user from the request row (service-role read:
  // cross-user rows are invisible to the user client by RLS design).
  const service = createServiceRoleClient();
  const { data: row, error: lookupError } = await service
    .from("subscription_requests")
    .select("id,user_id,plan,status")
    .eq("id", requestId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json(
      { error: "Failed to load request" },
      { status: 500 },
    );
  }
  if (!isRecord(row) || typeof row["user_id"] !== "string") {
    return NextResponse.json(
      { error: "الطلب غير موجود", code: "NOT_FOUND" },
      { status: 404 },
    );
  }

  const requestedPlan =
    typeof row["plan"] === "string" ? (row["plan"] as string) : "pro";
  const resolvedPlan =
    queueAction === "approve" ? (plan ?? requestedPlan) : requestedPlan;
  if (queueAction === "approve" && resolvedPlan !== "pro" && resolvedPlan !== "team") {
    return NextResponse.json(
      { error: "Invalid plan", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  // Privileged mutation — single-transaction `admin_action` RPC on the user
  // client (see module header for why service-role cannot carry auth.uid()).
  // Pause only flips subscribed→paused inside the RPC; its deny is surfaced.
  const { data, error } = await supabase.rpc("admin_action", {
    action: RPC_ACTION[queueAction],
    target: { user_id: row["user_id"] },
    payload: queueAction === "approve" ? { plan: resolvedPlan } : {},
    reason: `admin queue ${queueAction} ${requestId}`,
  });
  if (error) {
    if ((error as { code?: string }).code === "P0001") {
      return NextResponse.json(
        { error: "الطلب غير موجود", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "Admin action failed" },
      { status: 500 },
    );
  }
  if (isRecord(data) && data["ok"] === false) {
    const code =
      typeof data["error"] === "string" ? (data["error"] as string) : "unknown";
    if (code === "forbidden") {
      return forbidden();
    }
    return NextResponse.json(
      { error: code, code: code.toUpperCase() },
      { status: rpcDenyToStatus(code) },
    );
  }

  return NextResponse.json({
    request: {
      id: requestId,
      status: RESULT_STATUS[queueAction],
      plan: resolvedPlan,
    },
  });
}
