// Honest research header labels (client-safe: no server-only imports).
//
// Only evidence with source_type "web_search" AND a source_url was
// returned by a grounding tool (route.ts strips every other URL by
// design). The header must say "grounded" solely for those items —
// anything else is unverified model synthesis, however plausible it
// reads (prod 2026-10-05: "14 grounded claims", zero browsed sources).

interface ResearchItem {
  source_type?: string | null;
  source_url?: string | null;
}

export function describeResearchCoverage(items: ResearchItem[]): string {
  if (items.length === 0) return "Market Research";
  const grounded = items.filter((e) => e.source_type === "web_search" && !!e.source_url).length;
  if (grounded === items.length) return `Market Research — ${items.length} grounded claims`;
  if (grounded === 0)
    return `Market Research — ${items.length} research claims (unverified synthesis)`;
  return `Market Research — ${items.length} research claims (${grounded} grounded)`;
}
