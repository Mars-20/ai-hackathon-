import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { compareTs, resolveOrder, TRACKS, type StageStep } from "./tracks";
import { suggestNextStage, type StageSuggestion } from "./suggest";

export interface StageRow {
  id: string;
  owner_id: string;
  workspace_id: string | null;
  stage: string;
  stage_track: string | null;
  stage_order: StageStep[] | null;
  /** Trial-exhaustion freeze — mirrors the save route's is_frozen gate. */
  is_frozen: boolean;
}

export interface StageBasis {
  order: StageStep[];
  thresholds: Record<string, number>;
  suggestion: StageSuggestion | null;
  rung4Count: number;
}

/** Rung-4+ strengths: the platform's own bar for a Go (commitment ladder). */
const RUNG4 = new Set(["contact_shared", "commitment"]);

type Db = SupabaseClient;

/** Loads startup + decision/evidence/dismissal basis. Never throws. */
export async function fetchStageRow(
  db: Db,
  startupId: string,
): Promise<StageRow | null> {
  let track: string | null = null;
  let order: StageStep[] | null = null;
  try {
    const { data, error } = await db
      .from("startups")
      .select("id, owner_id, workspace_id, stage, stage_track, stage_order, is_frozen")
      .eq("id", startupId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as unknown as Record<string, unknown>;
    track = typeof r.stage_track === "string" ? r.stage_track : null;
    order = Array.isArray(r.stage_order) ? (r.stage_order as StageStep[]) : null;
    return {
      id: String(r.id),
      owner_id: String(r.owner_id),
      workspace_id:
        typeof r.workspace_id === "string" ? r.workspace_id : null,
      stage: String(r.stage ?? "idea"),
      stage_track: track,
      stage_order: order,
      is_frozen: r.is_frozen === true,
    };
  } catch {
    // Pre-migration-0016 fallback: no track columns yet.
    try {
      const { data, error } = await db
        .from("startups")
        .select("id, owner_id, workspace_id, stage")
        .eq("id", startupId)
        .maybeSingle();
      if (error || !data) return null;
      const r = data as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        owner_id: String(r.owner_id),
        workspace_id:
          typeof r.workspace_id === "string" ? r.workspace_id : null,
        stage: String(r.stage ?? "idea"),
        stage_track: null,
        stage_order: null,
        is_frozen: false,
      };
    } catch {
      return null;
    }
  }
}

/** Owner or workspace member. Tables may be absent pre-migration → false. */export async function canWriteStartup(
  db: Db,
  row: StageRow,
  userId: string,
): Promise<boolean> {
  if (row.owner_id === userId) return true;
  if (!row.workspace_id) return false;
  try {
    const { data } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", row.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

/** 403 for frozen startups — identical shape across all stage endpoints. */
export function frozenResponse(): NextResponse {
  return NextResponse.json(
    { error: "Startup is frozen", code: "FROZEN" },
    { status: 403 },
  );
}

export async function computeStageBasis(
  db: Db,
  row: StageRow,
): Promise<StageBasis> {
  const order = resolveOrder(row.stage_track, row.stage_order);
  const trackKey = (row.stage_track ?? "general").trim().toLowerCase();
  const thresholds =
    (row.stage_order ? undefined : TRACKS[trackKey]?.thresholds) ??
    TRACKS.general.thresholds;

  let decisions: { id: string; verdict: string; created_at: string }[] = [];
  let rung4Count = 0;
  let rung4Ids: string[] = [];
  let dismissals: {
    from: string;
    to: string;
    rung4_count: number;
    created_at: string;
  }[] = [];
  // A Go is consumed by the advancement it triggered: only decisions newer
  // than the last recorded advancement (any actor) can fire R1 again.
  // Pre-migration-0016 the history table is absent → no consumption.
  let lastAdvanceAt: string | null = null;
  try {
    const { data } = await db
      .from("decisions")
      .select("id, verdict, created_at")
      .eq("startup_id", row.id);
    if (Array.isArray(data)) {
      decisions = (data as unknown as Record<string, unknown>[]).map((d) => ({
        id: String(d.id),
        verdict: String(d.verdict ?? ""),
        created_at: String(d.created_at ?? ""),
      }));
    }
  } catch {
    decisions = [];
  }
  try {
    const { data } = await db
      .from("evidence")
      .select("id, strength")
      .eq("startup_id", row.id);
    if (Array.isArray(data)) {
      const rung4 = (data as unknown as Record<string, unknown>[]).filter(
        (e) => RUNG4.has(String(e.strength ?? "")),
      );
      rung4Count = rung4.length;
      rung4Ids = rung4.map((e) => String(e.id));
    }
  } catch {
    rung4Count = 0;
    rung4Ids = [];
  }
  try {
    const { data } = await db
      .from("stage_suggestion_dismissals")
      .select("from_stage, to_stage, rung4_count, created_at")
      .eq("startup_id", row.id);
    if (Array.isArray(data)) {
      dismissals = (data as unknown as Record<string, unknown>[]).map(
        (d) => ({
          from: String(d.from_stage ?? ""),
          to: String(d.to_stage ?? ""),
          rung4_count:
            typeof d.rung4_count === "number" ? d.rung4_count : 0,
          created_at: String(d.created_at ?? ""),
        }),
      );
    }
  } catch {
    dismissals = [];
  }

  try {
    const { data } = await db
      .from("startup_stage_history")
      .select("actor, created_at")
      .eq("startup_id", row.id);
    if (Array.isArray(data)) {
      for (const h of data as unknown as Record<string, unknown>[]) {
        const at = String(h.created_at ?? "");
        if (at && (lastAdvanceAt === null || compareTs(at, lastAdvanceAt) > 0)) {
          lastAdvanceAt = at;
        }
      }
    }
  } catch {
    lastAdvanceAt = null;
  }
  if (lastAdvanceAt !== null) {
    const cutoff = lastAdvanceAt;
    decisions = decisions.filter((d) => compareTs(d.created_at, cutoff) > 0);
  }

  const suggestion = suggestNextStage({
    stage: row.stage,
    order,
    decisions,
    rung4Count,
    rung4Ids,
    dismissals,
    thresholds,
  });
  return { order, thresholds, suggestion, rung4Count };
}
