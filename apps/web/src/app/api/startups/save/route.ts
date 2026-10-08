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
import { resolveEffectiveWorkspaceId } from "@/lib/agent-workspace";
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
  const requestedWorkspaceId = parsed.data.workspace_id ?? "";

  // Membership gate: reject any workspace_id the caller is not a member of.
  if (requestedWorkspaceId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", requestedWorkspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: "Forbidden: not a workspace member" }, { status: 403 });
    }
  }

  // Effective workspace: prod enforces workspace_id NOT NULL (migration
  // 0008), so an absent workspace_id resolves to the caller's first
  // membership, else a personal workspace created on demand (same helper
  // as the agent memo persist path) — never NULL, which the DB rejects
  // with 23502. Unresolvable → fail closed (429), never 500.
  const effectiveWorkspaceId = requestedWorkspaceId
    ? requestedWorkspaceId
    : await resolveEffectiveWorkspaceId(supabase, user.id, "");
  if (!effectiveWorkspaceId) {
    return NextResponse.json(
      { error: "Workspace unavailable. Try again shortly." },
      { status: 429 },
    );
  }
  const rawWorkspaceId = effectiveWorkspaceId;

  // Owner fallback: when a client-supplied id targets an
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
  // Unknown track → 400 INVALID, on creation and on update alike.
  // Track switches go through PATCH .../stage/track (narrow update): the
  // full-row upsert here must never apply a track to an existing row, since
  // absent fields resolve to defaults and would clobber it. An unchanged
  // stage on an existing row always passes (it may sit off-track at
  // position -1: stepper shows it, suggestions pause until manual advance).
  const suppliedTrack = parsed.data.track ?? null;
  if (suppliedTrack && TRACKS[normalizeKey(suppliedTrack)] === undefined) {
    return NextResponse.json(
      { error: "Unknown stage track", code: "INVALID" },
      { status: 400 },
    );
  }
  const stageChanged =
    !existingStartup ||
    normalizeKey(parsed.data.stage) !== normalizeKey(existingStartup.stage);
  const effectiveTrack = existingStartup ? existingTrack : (suppliedTrack ?? null);
  const effectiveOrder = existingStartup ? existingOrder : null;
  if ((!existingStartup || stageChanged) && !isStageInOrder(effectiveTrack, effectiveOrder, parsed.data.stage)) {
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
    // stage_track only on creation with an explicit track. Updates never
    // carry a track here (switches use the narrow PATCH endpoint) — legacy
    // saves omit the key so they keep working before migration 0016.
    ...(!existingStartup && suppliedTrack
      ? { stage_track: normalizeKey(suppliedTrack) }
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
    const errRec = error as unknown as Record<string, unknown>;
    console.error("[Save API] Failed to save startup", {
      message: typeof errRec.message === "string" ? errRec.message : null,
      code: typeof errRec.code === "string" ? errRec.code : null,
      details: typeof errRec.details === "string" ? errRec.details : null,
      hint: typeof errRec.hint === "string" ? errRec.hint : null,
    });
    return NextResponse.json({ error: "Failed to save startup" }, { status: 500 });
  }

  return NextResponse.json({ startup: data });
}
