// ─────────────────────────────────────────────────────────────────────────────
// /api/subscription-requests — manual subscription approval intake (Task 6)
// POST {plan, full_name, phone, company?, notes?} → 201 {request:{id,plan,status}}
// GET  → own rows (RLS subreq_select_own)
//
// PII posture (phone numbers): RLS own-only (subreq_select_own /
// subreq_insert_own enforce auth.uid() = user_id); only the platform
// service-role client reads cross-user rows (owner_alerts fan-out below);
// phone values are stored as-given and NEVER logged.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { subscriptionRequestSchema } from "@/lib/validation";

// POST rate gate: 5 attempts per hour per user (abuse brake on manual review).
const SUBREQ_RATE_LIMIT = 5;
const SUBREQ_RATE_WINDOW_MS = 60 * 60 * 1000;

// ── POST: file a subscription request ───────────────────────────────────────
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
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const parsed = subscriptionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let rate: { limited: boolean; retryAfter: number };
  try {
    rate = await checkRateLimit({
      key: `subreq:${user.id}`,
      limit: SUBREQ_RATE_LIMIT,
      windowMs: SUBREQ_RATE_WINDOW_MS,
    });
  } catch {
    rate = { limited: true, retryAfter: Math.ceil(SUBREQ_RATE_WINDOW_MS / 1000) }; // fail-closed
  }
  if (rate.limited) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rate.retryAfter },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfter) },
      },
    );
  }

  const { plan, full_name, phone, company, notes } = parsed.data;
  // Phone stored as-given (no normalization); never logged (see PII posture above).
  const { data, error } = await supabase
    .from("subscription_requests")
    .insert({
      user_id: user.id,
      plan,
      full_name,
      phone,
      company: company ?? null,
      notes: notes ?? null,
    })
    .select("id,plan,status")
    .single();

  if (error) {
    // Partial unique index one_pending_request → exactly one pending row/user.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "لديك طلب قيد المراجعة", code: "DUPLICATE_PENDING" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Failed to create request" }, { status: 500 });
  }

  const created = data as { id: string; plan: string; status: string };

  // Best-effort owner fan-out via service-role (owner_alerts has no user-RLS
  // write path by design). Failure → warn, still 201: the request itself
  // is already durably stored.
  try {
    const admin = createServiceRoleClient();
    const { error: alertError } = await admin.from("owner_alerts").insert({
      kind: "subscription_request",
      ref_id: created.id,
    });
    if (alertError) {
      console.warn("[subscription-requests] owner_alert insert failed", {
        ref_id: created.id,
      });
    }
  } catch {
    console.warn("[subscription-requests] owner_alert insert failed", {
      ref_id: created.id,
    });
  }

  return NextResponse.json(
    { request: { id: created.id, plan: created.plan, status: created.status } },
    { status: 201 },
  );
}

// ── GET: list own requests ──────────────────────────────────────────────────
export async function GET(_request?: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("subscription_requests")
    .select("id,plan,status,full_name,phone,company,notes,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: "Failed to list requests" }, { status: 500 });
  }

  return NextResponse.json({ requests: data ?? [] });
}
