// ─────────────────────────────────────────────────────────────────────────────
// POST /api/startups/save
// Persists a validate-page startup snapshot for the authenticated user.
// Body: { startup: { id?, workspace_id?, name, one_liner, domain,
//   target_customer?, stage, business_model? } }
// Returns: { startup } on success.
// Client keeps its localStorage fallback intact on non-OK/404/network failure.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveSaveGate, type EntitlementStatus } from "@/lib/entitlements";
import { startupSaveSchema } from "@/lib/validation";
import {
  isStageInOrder,
  normalizeKey,
  TRACKS,
  type StageStep,
} from "@/lib/progress/tracks";

function normId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

// Trial-paywall denial messages (402). Frozen rows carry their own message.
const SAVE_GATE_MESSAGES: Record<string, string> = {
  TRIAL_CONSUMED: "انتهت تجربتك المجانية — اشترك لفتح مشاريع جديدة",
  SUBSCRIPTION_REQUIRED: "هذا الإجراء يتطلب اشتراكًا",
  ACCOUNT_PAUSED: "حسابك موقوف مؤقتًا — راجع الإدارة",
};

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Trial-paywall entitlement fetch (service-role: user_entitlements has no
  // user-RLS read path). Missing row (pre-migration user — cannot happen
  // post-0010, defensive only) → legacy. Unreadable → fail closed (429).
  // The gate itself is evaluated below, after the hijack guards.
  const service = createServiceRoleClient();
  let entitlementStatus: EntitlementStatus | null = "legacy";
  try {
    const { data: entitlement, error: entitlementError } = await service
      .from("user_entitlements")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (entitlementError) throw entitlementError;
    if (!entitlement) {
      console.warn("[save] missing user_entitlements row, treating as legacy", { user_id: user.id });
    } else {
      const rawStatus = (entitlement as { status?: unknown }).status;
      entitlementStatus = typeof rawStatus === "string" ? (rawStatus as EntitlementStatus) : "legacy";
    }
  } catch {
    return NextResponse.json({ error: "Entitlement check unavailable. Try again shortly." }, { status: 429 });
  }

  let body: { startup?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const s = body.startup ?? {};
  const rawIdInput = normId(s.id);
  const rawWorkspaceInput = normId(s.workspace_id);
  const rawStageInput = normId(s.stage);
  const rawDomainInput = typeof s.domain === "string" ? s.domain : undefined;
  const rawTrackInput =
    typeof s.track === "string" && s.track.trim() ? s.track.trim() : undefined;

  const parsed = startupSaveSchema.safeParse({
    id: rawIdInput,
    name: s.name,
    stage: rawStageInput,
    track: rawTrackInput,
    domain: rawDomainInput,
    workspace_id: rawWorkspaceInput,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const rawId = parsed.data.id ?? crypto.randomUUID();
  const clientSuppliedId = rawIdInput !== undefined;
  const rawWorkspaceId = parsed.data.workspace_id ?? null;

  // Membership gate: reject any workspace_id the caller is not a member of.
  if (rawWorkspaceId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", rawWorkspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: "Forbidden: not a workspace member" }, { status: 403 });
    }
  }

  // Owner fallback: when workspace_id is absent (personal startup), isolation
  // relies on owner_id === auth user. When a client-supplied id targets an
  // existing row, verify the caller owns it or is a member of its workspace
  // so one user cannot hijack another's startup via guessed UUID.
  // (Trial paywall: the fetched row is reused below — isNew = !existing,
  // and the update path enforces is_frozen. Hijack guards unchanged.)
  let existingStartup: { owner_id: string; workspace_id: string | null; is_frozen: boolean; stage: string } | null = null;
  // Track info for the in-order stage check. Fetched separately so rows
  // created before migration 0016 (no stage_track/stage_order columns) keep
  // the legacy select working — a missing-column error falls back to nulls.
  let existingTrack: string | null = null;
  let existingOrder: StageStep[] | null = null;
  if (clientSuppliedId) {
    const { data: existing } = await supabase
      .from("startups")
      .select("id, owner_id, workspace_id, is_frozen, stage")
      .eq("id", rawId)
      .maybeSingle();
    if (existing) {
      const typed = existing as { owner_id: string; workspace_id: string | null; is_frozen: boolean; stage: string };
      if (typed.owner_id !== user.id) {
        if (!typed.workspace_id) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const { data: m } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("workspace_id", typed.workspace_id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!m) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      existingStartup = typed;
      try {
        const { data: trackRow, error: trackError } = await supabase
          .from("startups")
          .select("stage_track, stage_order")
          .eq("id", rawId)
          .maybeSingle();
        if (trackError) throw trackError;
        const t = trackRow as { stage_track?: unknown; stage_order?: unknown } | null;
        existingTrack = typeof t?.stage_track === "string" ? t.stage_track : null;
        existingOrder = Array.isArray(t?.stage_order) ? (t.stage_order as StageStep[]) : null;
      } catch {
        existingTrack = null;
        existingOrder = null;
      }
    }
  }

  // Track-aware stage check: the stage must belong to the project's track
  // order (existing row's track, or the client-supplied track on creation).
  // Unknown creation track → 400 INVALID (no silent fallback). A track
  // switch keeps an unchanged current stage even when off the new track
  // (position -1: stepper shows it, suggestions pause until manual advance).
  const suppliedTrack = parsed.data.track ?? null;
  if (suppliedTrack && !TRACKS[normalizeKey(suppliedTrack)] && !existingStartup) {
    return NextResponse.json(
      { error: "Unknown stage track", code: "INVALID" },
      { status: 400 },
    );
  }
  const trackSwitch =
    !!existingStartup &&
    !!suppliedTrack &&
    TRACKS[normalizeKey(suppliedTrack)] !== undefined &&
    normalizeKey(suppliedTrack) !== normalizeKey(existingTrack ?? "general");
  const stageChanged =
    !existingStartup ||
    normalizeKey(parsed.data.stage) !== normalizeKey(existingStartup.stage);
  const effectiveTrack = existingStartup
    ? trackSwitch
      ? suppliedTrack
      : existingTrack
    : (suppliedTrack ?? null);
  const effectiveOrder = existingStartup && !trackSwitch ? existingOrder : null;
  if ((stageChanged || !trackSwitch) && !isStageInOrder(effectiveTrack, effectiveOrder, parsed.data.stage)) {
    return NextResponse.json(
      { error: "Invalid stage for this project's track", code: "INVALID" },
      { status: 400 },
    );
  }

  // Trial-paywall gate (402). Creation of a second startup consumes the
  // trial (consume_trial runs BEFORE the upsert; result ignored except a
  // warn — the second snapshot is blocked anyway). Updates to own rows are
  // denied when the row is frozen or the status is consumed/paused.
  if (!existingStartup) {
    const { count } = await supabase
      .from("startups")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id);
    const saveGate = resolveSaveGate(entitlementStatus, true, count ?? 0);
    if (!saveGate.allowed) {
      if (saveGate.consumeTrial) {
        try {
          const { error: consumeError } = await service.rpc("consume_trial", {
            p_user_id: user.id,
            p_startup_id: rawId,
          });
          if (consumeError) console.warn("[save] consume_trial failed", { user_id: user.id });
        } catch {
          console.warn("[save] consume_trial failed", { user_id: user.id });
        }
      }
      return NextResponse.json(
        {
          error: SAVE_GATE_MESSAGES[saveGate.code] ?? SAVE_GATE_MESSAGES.SUBSCRIPTION_REQUIRED,
          code: saveGate.code,
          plans_url: "/plans",
        },
        { status: 402 },
      );
    }
  } else {
    if (existingStartup.is_frozen) {
      const frozenCode = entitlementStatus === "paused" ? "ACCOUNT_PAUSED" : "TRIAL_CONSUMED";
      return NextResponse.json(
        { error: "هذا المشروع مجمّد — اشترك للمتابعة", code: frozenCode, plans_url: "/plans" },
        { status: 402 },
      );
    }
    const saveGate = resolveSaveGate(entitlementStatus, false, 0);
    if (!saveGate.allowed) {
      return NextResponse.json(
        {
          error: SAVE_GATE_MESSAGES[saveGate.code] ?? SAVE_GATE_MESSAGES.SUBSCRIPTION_REQUIRED,
          code: saveGate.code,
          plans_url: "/plans",
        },
        { status: 402 },
      );
    }
  }

  const row = {
    id: rawId,
    workspace_id: rawWorkspaceId,
    owner_id: user.id,
    name: parsed.data.name,
    one_liner: typeof s.one_liner === "string" ? s.one_liner : "",
    domain: parsed.data.domain?.trim() ? parsed.data.domain.trim() : "general",
    target_customer:
      typeof s.target_customer === "string" && s.target_customer.trim()
        ? s.target_customer
        : null,
    stage: parsed.data.stage,
    // stage_track only when explicitly (re)set: on creation with a track,
    // or on a track switch. Legacy saves omit the key so they keep working
    // before migration 0016 is applied.
    ...((!existingStartup && suppliedTrack) || trackSwitch
      ? { stage_track: normalizeKey(suppliedTrack as string) }
      : {}),
    business_model:
      typeof s.business_model === "string" && s.business_model.trim()
        ? s.business_model
        : null,
  };

  const { data, error } = await supabase
    .from("startups")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    console.error("[Save API] Failed to save startup");
    return NextResponse.json({ error: "Failed to save startup" }, { status: 500 });
  }

  return NextResponse.json({ startup: data });
}
