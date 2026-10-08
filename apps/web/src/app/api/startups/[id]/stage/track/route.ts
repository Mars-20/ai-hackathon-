// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/startups/[id]/stage/track
// Switches the project's stage track template: { track: "<known key>" }.
// Narrow by design: it updates ONLY stage_track (and clears any custom
// stage_order, which would otherwise shadow the new template) — never the
// name/one_liner/domain/workspace columns. The full-save upsert must not be
// used for track switches: absent fields there resolve to defaults and would
// clobber the row.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  normalizeKey,
  sanitizeCustomOrder,
  TRACKS,
  type StageStep,
} from "@/lib/progress/tracks";
import { canWriteStartup, fetchStageRow, frozenResponse } from "@/lib/progress/stage-context";

export async function PATCH(
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

  let body: { track?: unknown; order?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const key =
    typeof body.track === "string" && body.track.trim()
      ? normalizeKey(body.track)
      : null;
  if (!key || TRACKS[key] === undefined) {
    return NextResponse.json(
      { error: "Unknown stage track", code: "INVALID" },
      { status: 400 },
    );
  }

  const row = await fetchStageRow(supabase, id);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canWriteStartup(supabase, row, user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (row.is_frozen) {
    return frozenResponse();
  }

  // Optional custom order: stored as-is (shadowing the template), cleared
  // when omitted so a previous customization cannot shadow the new template.
  let customOrder: StageStep[] | null = null;
  if (body.order !== undefined) {
    customOrder = sanitizeCustomOrder(body.order);
    if (!customOrder) {
      return NextResponse.json(
        { error: "Invalid custom stage order", code: "INVALID" },
        { status: 400 },
      );
    }
  }

  const { error } = await supabase
    .from("startups")
    .update({ stage_track: key, stage_order: customOrder })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: "Failed to switch track" }, { status: 500 });
  }
  return NextResponse.json({ track: key });
}
