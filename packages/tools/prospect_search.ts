/**
 * prospect_search tool (Section 7) — Task 5 DECISION: build search-only.
 *
 * Spec downgrade: sequences / nurture / auto-enrollment are NOT built.
 * This tool searches Apollo REST (interim; MCP OAuth later) via
 * search_people / search_organizations / enrich equivalents, returns
 * { total_matched, sample (max 10), apollo_ids }, and inserts ONLY into the
 * prospects table with match_reason. There is deliberately no sequence,
 * cadence, or auto-enrollment support in this module.
 *
 * Follow-up done: supabase/migrations/20240101000014_prospects_l3.sql.
 * Inserts are best-effort — search results are returned even when persistence fails
 * (e.g. table not yet migrated), with the error surfaced on `error`.
 */

export interface ProspectSearchInput {
  startup_id: string;
  target_customer: string;
  domain: string;
  keywords?: string;
  limit?: number;
  match_reason?: string;
}

export interface ProspectSample {
  apollo_id: string;
  name: string;
  title: string;
  company: string;
  email: string | null;
}

export interface ProspectSearchResult {
  total_matched: number;
  sample: ProspectSample[];
  apollo_ids: string[];
  inserted: number;
  provider: "apollo" | "mock";
  error?: string;
}

interface SupabaseLike {
  from(table: string): any;
}

type FetchFn = typeof fetch;

interface ApolloPersonRaw {
  id?: string;
  name?: string;
  title?: string;
  organization?: { name?: string };
  email?: string;
}

interface ApolloSearchResponse {
  people?: ApolloPersonRaw[];
  pagination?: { total_entries?: number };
}

const APOLLO_SEARCH_URL = "https://api.apollo.io/v1/mixed_people/search";
const SAMPLE_CAP = 10;

export async function prospectSearch(
  input: ProspectSearchInput,
  supabase?: SupabaseLike,
  fetchFn: FetchFn = fetch
): Promise<ProspectSearchResult> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return {
      total_matched: 0,
      sample: [],
      apollo_ids: [],
      inserted: 0,
      provider: "mock",
      error: "APOLLO_API_KEY not configured",
    };
  }
  if (!input.startup_id) {
    return {
      total_matched: 0,
      sample: [],
      apollo_ids: [],
      inserted: 0,
      provider: "apollo",
      error: "startup_id is required",
    };
  }

  let data: ApolloSearchResponse;
  let total: number;
  try {
    const res = await fetchFn(APOLLO_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        per_page: Math.min(input.limit ?? SAMPLE_CAP, SAMPLE_CAP),
        page: 1,
        q_keywords: [input.target_customer, input.domain, input.keywords]
          .filter(Boolean)
          .join(" "),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        total_matched: 0,
        sample: [],
        apollo_ids: [],
        inserted: 0,
        provider: "apollo",
        error: `Apollo API error ${res.status}: ${errText.slice(0, 200)}`,
      };
    }
    data = (await res.json()) as ApolloSearchResponse;
    total = data.pagination?.total_entries ?? (data.people ?? []).length;
  } catch (err) {
    return {
      total_matched: 0,
      sample: [],
      apollo_ids: [],
      inserted: 0,
      provider: "apollo",
      error: `Apollo search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const people = (data.people ?? []).slice(0, SAMPLE_CAP);
  const sample: ProspectSample[] = people.map((p) => ({
    apollo_id: p.id ?? crypto.randomUUID(),
    name: p.name ?? "Unknown",
    title: p.title ?? "",
    company: p.organization?.name ?? "",
    email: p.email ?? null,
  }));
  const apollo_ids = sample.map((s) => s.apollo_id);
  const match_reason =
    input.match_reason ?? `target_customer=${input.target_customer}; domain=${input.domain}`;

  // Persist search-only rows to prospects (never to sequences — unsupported).
  let inserted = 0;
  let error: string | undefined;
  if (supabase && sample.length > 0) {
    try {
      const rows = sample.map((s) => ({
        startup_id: input.startup_id,
        apollo_id: s.apollo_id,
        // Spec Section 9 canonical columns (migration 0014) …
        company_name: s.company,
        contact_name: s.name,
        // … plus compatibility aliases consumed by founder-review UI.
        name: s.name,
        company: s.company,
        title: s.title,
        email: s.email,
        match_reason,
      }));
      const { error: insertError } = await supabase.from("prospects").insert(rows);
      if (insertError) {
        error = insertError.message ?? "Failed to persist prospects";
      } else {
        inserted = rows.length;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return { total_matched: total, sample, apollo_ids, inserted, provider: "apollo", error };
}
