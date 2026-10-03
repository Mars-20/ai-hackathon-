// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history
// Returns validation sessions (startups + decisions + experiments) for the
// authenticated user's active workspace, with search & filter support.
//
// Query params:
//   q          — full-text search across name, domain, one_liner
//   verdict    — go | iterate | stop | test_more (comma-separated)
//   stage      — idea | prototype | live | scaling (comma-separated)
//   confidence — low | medium | high (comma-separated)
//   from       — ISO date string (created_at >=)
//   to         — ISO date string (created_at <=)
//   sort       — created_at | name | updated_at (default: created_at)
//   order      — asc | desc (default: desc)
//   page       — page number (default: 1)
//   limit      — results per page (default: 20, max: 100)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { historyQuerySchema, workspaceIdSchema } from "@/lib/validation";
import { escapePostgrest } from "../../../../../../packages/admin/escape";

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  // Auth check
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse query params (minimal zod whitelist; counts/RPC owned by Task 6).
  const { searchParams } = new URL(request.url);
  const rawQ = searchParams.get("q")?.trim() || "";
  const rawVerdicts = searchParams.get("verdict")?.split(",").filter(Boolean) || [];
  const rawStages = searchParams.get("stage")?.split(",").filter(Boolean) || [];
  const rawConfidences = searchParams.get("confidence")?.split(",").filter(Boolean) || [];
  const parsedFilters = historyQuerySchema.safeParse({
    q: rawQ,
    verdicts: rawVerdicts,
    stages: rawStages,
    confidences: rawConfidences,
    sort: searchParams.get("sort") || "created_at",
    order: searchParams.get("order") || "desc",
    page: searchParams.get("page") || "1",
    limit: searchParams.get("limit") || "20",
  });
  if (!parsedFilters.success) {
    return NextResponse.json({ error: "Invalid query", issues: parsedFilters.error.issues }, { status: 400 });
  }
  const { q, verdicts, stages, confidences, sort, order: orderStr, page, limit } = parsedFilters.data;
  const order = orderStr === "asc" ? true : false;
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const offset = (page - 1) * limit;
  const startupIdParam = searchParams.get("startup_id")?.trim() || "";
  if (startupIdParam && !workspaceIdSchema.safeParse(startupIdParam).success) {
    return NextResponse.json({ error: "Invalid startup_id" }, { status: 400 });
  }

  // Get user's workspace IDs
  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id);

  const workspaceIds = ((memberships || []) as { workspace_id: string }[]).map((m) => m.workspace_id);

  if (workspaceIds.length === 0) {
    return NextResponse.json({
      data: [], meta: { total: 0, page, limit, pages: 0 }
    });
  }

  // ── Detail mode for resume (?startup_id=): single startup + relations ──────
  // Used by /validate?page resume. Workspace scoping stays in the DB query.
  if (startupIdParam) {
    const { data: startup, error: detailError } = await supabase
      .from("startups")
      .select(`
        id, name, one_liner, domain, target_customer, stage, business_model,
        created_at, updated_at, workspace_id, owner_id,
        decisions(id, verdict, confidence, rationale, next_experiment, evidence_ids, sample_size, created_at),
        experiments(id, type, status, design, created_at),
        assumptions(id, statement, category, risk_level, status, reasoning, created_at),
        evidence(id, assumption_id, evidence_type, source_type, source_url, claim, strength, sample_size, collected_at)
      `)
      .eq("id", startupIdParam)
      .in("workspace_id", workspaceIds)
      .maybeSingle();
    if (detailError) {
      console.error("[History API] Detail error:", detailError);
      return NextResponse.json({ error: "Failed to fetch startup" }, { status: 500 });
    }
    if (!startup) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ data: startup });
  }

  // ── Build startups query ───────────────────────────────────────────────────
  // Workspace isolation is pushed into the Supabase query (never post-fetch).
  // Child-table workspace scoping elsewhere uses the startups!inner/workspace_id
  // pattern; here startups is the base table so the direct workspace_id filter
  // applies, and verdict/confidence are pushed via decisions!inner so that the
  // DB count (not a post-fetch JS filter) drives total/pages.
  const needsDecisionJoin = verdicts.length > 0 || confidences.length > 0;
  const decisionsSelect = needsDecisionJoin
    ? "decisions!inner(id, verdict, confidence, rationale, next_experiment, created_at)"
    : "decisions(id, verdict, confidence, rationale, next_experiment, created_at)";
  let query = supabase
    .from("startups")
    .select(`
      id, name, one_liner, domain, stage, created_at, updated_at, workspace_id, owner_id,
      ${decisionsSelect},
      experiments(id, type, status, created_at),
      assumptions(id, status, risk_level, category)
    `, { count: "exact" })
    .in("workspace_id", workspaceIds);

  // Verdict/confidence pushed into the DB query via the inner join above.
  if (verdicts.length > 0) {
    query = query.in("decisions.verdict", verdicts);
  }
  if (confidences.length > 0) {
    query = query.in("decisions.confidence", confidences);
  }

  // Full-text search (escaped to prevent .or() injection / wildcard abuse)
  if (q) {
    const eq = escapePostgrest(q);
    query = query.or(`name.ilike.%${eq}%,one_liner.ilike.%${eq}%,domain.ilike.%${eq}%`);
  }

  // Stage filter
  if (stages.length > 0) {
    query = query.in("stage", stages);
  }

  // Date range
  if (from) query = query.gte("created_at", from);
  if (to)   query = query.lte("created_at", to);

  // Sort
  const validSortCols = ["created_at", "name", "updated_at"];
  const sortCol = validSortCols.includes(sort) ? sort : "created_at";
  query = query.order(sortCol, { ascending: order });

  // Pagination (applied in DB after all filters, so total/pages stay correct)
  query = query.range(offset, offset + limit - 1);

  const { data: startups, count, error } = await query;

  if (error) {
    console.error("[History API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }

  // ── Post-process: shape only (no filtering — total comes from DB count) ────
  type DBDecision = { created_at: string; verdict: string; confidence: string; rationale: string; next_experiment: string };
  type DBAssumption = { status: string; risk_level: string; category: string };
  type DBStartup = { id: string; name: string; one_liner: string; domain: string; stage: string; workspace_id: string; created_at: string; updated_at: string; decisions?: DBDecision[]; experiments?: { id: string }[]; assumptions?: DBAssumption[] };

  const results = (startups || []).map((s: unknown) => {
    const startup = s as DBStartup;
    const latestDecision = startup.decisions?.sort(
      (a: DBDecision, b: DBDecision) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0] || null;

    const assumptionStats = {
      total: startup.assumptions?.length || 0,
      validated: startup.assumptions?.filter((a: DBAssumption) => a.status === "validated").length || 0,
      invalidated: startup.assumptions?.filter((a: DBAssumption) => a.status === "invalidated").length || 0,
      critical: startup.assumptions?.filter((a: DBAssumption) => a.risk_level === "critical").length || 0,
    };

    return {
      id: startup.id,
      name: startup.name,
      one_liner: startup.one_liner,
      domain: startup.domain,
      stage: startup.stage,
      workspace_id: startup.workspace_id,
      created_at: startup.created_at,
      updated_at: startup.updated_at,
      latest_decision: latestDecision,
      experiment_count: startup.experiments?.length || 0,
      assumption_stats: assumptionStats,
    };
  });

  const total = count || 0;

  return NextResponse.json({
    data: results,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      filters_applied: {
        q: q || null,
        verdicts: verdicts.length ? verdicts : null,
        stages: stages.length ? stages : null,
        confidences: confidences.length ? confidences : null,
        from: from || null,
        to: to || null,
      },
    },
  });
}
