// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search
// Global search across startups, assumptions, and evidence within user's workspaces
//
// Query params:
//   q      — search query (required, min 2 chars)
//   type   — startups | assumptions | evidence | all (default: all)
//   limit  — results per type (default: 5, max: 20)
//   page   — page number per type, parsed manually (default: 1; zod schema
//             owned by T1 and intentionally untouched)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { searchQuerySchema } from "@/lib/validation";
import { escapePostgrest } from "../../../../../../packages/admin/escape";

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const parsed = searchQuerySchema.safeParse({
    q: searchParams.get("q") ?? "",
    type: searchParams.get("type") ?? "all",
    limit: searchParams.get("limit") ?? "5",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  }
  const { q, type, limit } = parsed.data;

  // Manual page parse (NOT zod — T1 owns the schema; pagination offset only).
  const pageRaw = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 100) : 1;
  const offset = (page - 1) * limit;

  // Get workspace IDs
  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id);
  const workspaceIds = ((memberships || []) as { workspace_id: string }[]).map((m) => m.workspace_id);
  if (workspaceIds.length === 0) {
    return NextResponse.json({
      query: q,
      total_hits: 0,
      counts: { startups: 0, assumptions: 0, evidence: 0 },
      results: { startups: [], assumptions: [], evidence: [] },
      meta: { total: 0, page, limit, pages: 0 },
    });
  }

  const results: Record<string, Record<string, unknown>[]> = { startups: [], assumptions: [], evidence: [] };

  // pg_trgm similarity ordering: server-side preference is
  //   ORDER BY similarity(name, q) DESC  (requires `create extension pg_trgm`
  //   + GIN indexes idx_startups_name_trgm / idx_evidence_claim_trgm in
  //   schema-unified.sql). PostgREST has no function-ordering primitive here,
  //   so the ilike query below stays as the fallback and results are re-ranked
  //   in code with an equivalent bigram Dice score mirroring similarity().
  function bigramDice(a: string, b: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const sa = norm(a);
    const sb = norm(b);
    if (!sa || !sb) return 0;
    if (sa.includes(sb) || sb.includes(sa)) return 1;
    const bigrams = (s: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
      return out;
    };
    const ba = bigrams(sa);
    const bb = bigrams(sb);
    if (ba.length === 0 || bb.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
    let hits = 0;
    for (const g of bb) {
      const c = counts.get(g) ?? 0;
      if (c > 0) {
        hits++;
        counts.set(g, c - 1);
      }
    }
    return (2 * hits) / (ba.length + bb.length);
  }

  // Relevance first, chronological (newest first) tie-break so equal
  // similarity scores resolve deterministically instead of input order.
  function timeOf(row: Record<string, unknown>): number {
    const raw = (row.created_at as string) ?? (row.collected_at as string) ?? "";
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  function rankBySimilarity<T extends Record<string, unknown>>(rows: T[], textOf: (row: T) => string): T[] {
    return [...rows].sort((x, y) =>
      bigramDice(textOf(y), q) - bigramDice(textOf(x), q) || timeOf(y) - timeOf(x),
    );
  }

  const eq = escapePostgrest(q);
  const counts = { startups: 0, assumptions: 0, evidence: 0 };

  // ── Search Startups (ilike fallback, similarity re-rank) ───────────────────
  // count:"exact" returns the DB total (not the sliced page); chronological
  // .order() seeds the DB order and .range() paginates in the DB.
  if (type === "all" || type === "startups") {
    const { data, count } = await supabase
      .from("startups")
      .select("id, name, one_liner, domain, stage, created_at", { count: "exact" })
      .in("workspace_id", workspaceIds)
      .or(`name.ilike.%${eq}%,one_liner.ilike.%${eq}%,domain.ilike.%${eq}%,target_customer.ilike.%${eq}%`)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    counts.startups = count ?? (data || []).length;
    const mapped = (data || []).map(s => ({ ...s, _type: "startup" }));
    results.startups = rankBySimilarity(mapped, (s: Record<string, unknown>) => `${(s.name as string) ?? ""} ${(s.one_liner as string) ?? ""} ${(s.domain as string) ?? ""}`);
  }

  // ── Search Assumptions ─────────────────────────────────────────────────────
  // Workspace isolation pushed into the query via the startups!inner join
  // (filters on startups.workspace_id in the DB, not post-fetch).
  if (type === "all" || type === "assumptions") {
    const { data, count } = await supabase
      .from("assumptions")
      .select("id, statement, category, risk_level, status, startup_id, created_at, startups!inner(name, workspace_id)", { count: "exact" })
      .in("startups.workspace_id", workspaceIds)
      .or(`statement.ilike.%${eq}%,reasoning.ilike.%${eq}%`)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    counts.assumptions = count ?? (data || []).length;
    const mapped = (data || []).map(a => ({
      ...a,
      startup_name: (a.startups as unknown as { name: string })?.name,
      _type: "assumption"
    }));
    results.assumptions = rankBySimilarity(mapped, (a: Record<string, unknown>) => `${(a.statement as string) ?? ""}`);
  }

  // ── Search Evidence ────────────────────────────────────────────────────────
  // Same startups!inner workspace pattern as assumptions above. Evidence rows
  // carry collected_at (no created_at), so both DB order and the tie-break
  // use collected_at. Thin-evidence counting rules belong to T7 — nothing is
  // excluded or re-weighted here.
  if (type === "all" || type === "evidence") {
    const { data, count } = await supabase
      .from("evidence")
      .select("id, claim, strength, evidence_type, source_url, startup_id, collected_at, startups!inner(name, workspace_id)", { count: "exact" })
      .in("startups.workspace_id", workspaceIds)
      .or(`claim.ilike.%${eq}%`)
      .order("collected_at", { ascending: false })
      .range(offset, offset + limit - 1);
    counts.evidence = count ?? (data || []).length;
    const mapped = (data || []).map(e => ({
      ...e,
      startup_name: (e.startups as unknown as { name: string })?.name,
      _type: "evidence"
    }));
    results.evidence = rankBySimilarity(mapped, (e: Record<string, unknown>) => `${(e.claim as string) ?? ""}`);
  }

  const total = counts.startups + counts.assumptions + counts.evidence;
  // Each type paginates independently with the same page/limit, so pages must
  // cover the largest per-type count.
  const pages = Math.ceil(Math.max(counts.startups, counts.assumptions, counts.evidence, 0) / limit);

  return NextResponse.json({
    query: q,
    total_hits: total,
    counts,
    results,
    meta: { total, page, limit, pages },
  });
}
