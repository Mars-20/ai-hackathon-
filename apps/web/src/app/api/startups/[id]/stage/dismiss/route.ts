// ─────────────────────────────────────────────────────────────────────────────
// POST /api/startups/[id]/stage/dismiss
// Records rejection of the live suggestion for (current → to).
// Body: { to }
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isStageInOrder, normalizeKey } from "@/lib/progress/tracks";
import {
  canWriteStartup,
  computeStageBasis,
  fetchStageRow,
} from "@/lib/progress/stage-context";

export async function POST(
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

  if (
    !isStageInOrder(row.stage_track, row.stage_order, to) ||
    normalizeKey(to) === normalizeKey(row.stage)
  ) {
    return NextResponse.json(
      { error: "Invalid stage for this project's track", code: "INVALID" },
      { status: 400 },
    );
  }

  const basis = await computeStageBasis(supabase, row);
  const { error } = await supabase.from("stage_suggestion_dismissals").upsert(
    {
      startup_id: id,
      workspace_id: row.workspace_id,
      from_stage: row.stage,
      to_stage: to,
      rung4_count: basis.rung4Count,
      created_at: new Date().toISOString(),
    },
    { onConflict: "startup_id,from_stage,to_stage" },
  );
  if (error) {
    return NextResponse.json({ error: "Failed to record dismissal" }, { status: 500 });
  }

  return NextResponse.json({ dismissed: true });
}
