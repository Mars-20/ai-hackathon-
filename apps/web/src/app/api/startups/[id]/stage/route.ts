// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/startups/[id]/stage
// Advances a project to the next stage in its track order.
// Body: { to }
// The server recomputes the live suggestion at confirm time and stores its
// basis in the history row (client refs are never trusted).
//
// GET /api/startups/[id]/stage
// Progress payload for the suggestion card: { stage, track, order,
// position, suggestion }. Suggestions are computed, never stored.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isStageInOrder, normalizeKey, resolveOrder, stagePosition } from "@/lib/progress/tracks";
import {
  canWriteStartup,
  computeStageBasis,
  fetchStageRow,
} from "@/lib/progress/stage-context";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const row = await fetchStageRow(supabase, id);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canWriteStartup(supabase, row, user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const basis = await computeStageBasis(supabase, row);
  const order = resolveOrder(row.stage_track, row.stage_order);
  return NextResponse.json({
    stage: row.stage,
    track: row.stage_track,
    order,
    position: stagePosition(order, row.stage),
    suggestion: basis.suggestion,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { to?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : null;
  if (!to) {
    return NextResponse.json({ error: "Missing target stage", code: "INVALID" }, { status: 400 });
  }

  const row = await fetchStageRow(supabase, id);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canWriteStartup(supabase, row, user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const basis = await computeStageBasis(supabase, row);
  if (
    !isStageInOrder(row.stage_track, row.stage_order, to) ||
    normalizeKey(to) === normalizeKey(row.stage)
  ) {
    return NextResponse.json(
      { error: "Invalid stage for this project's track", code: "INVALID" },
      { status: 400 },
    );
  }

  const matched =
    basis.suggestion && normalizeKey(basis.suggestion.to) === normalizeKey(to)
      ? basis.suggestion
      : null;

  const { error: updateError } = await supabase
    .from("startups")
    .update({ stage: to })
    .eq("id", id);
  if (updateError) {
    return NextResponse.json({ error: "Failed to advance stage" }, { status: 500 });
  }

  const { data: historyRow, error: historyError } = await supabase
    .from("startup_stage_history")
    .insert({
      startup_id: id,
      workspace_id: row.workspace_id,
      from_stage: row.stage,
      to_stage: to,
      actor: matched ? "suggestion" : "user",
      reason: matched ? matched.reason : null,
      supporting_refs: matched ? matched.refs : {},
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (historyError || !historyRow) {
    return NextResponse.json({ error: "Failed to record stage history" }, { status: 500 });
  }

  return NextResponse.json({
    stage: to,
    history_id: (historyRow as unknown as Record<string, unknown>).id,
  });
}
