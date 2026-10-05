// ─────────────────────────────────────────────────────────────────────────────
// Apollo.io API Service — Validation Copilot Lead Finder
// Searches for real potential interviewees/customers to help validate startup
// assumptions with primary evidence from real people.
// Docs: https://apolloio.github.io/apollo-api-docs/
// ─────────────────────────────────────────────────────────────────────────────

export interface ApolloLead {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string | null;
  linkedin_url: string | null;
  city: string | null;
  country: string | null;
  seniority: string | null;
  headline: string | null;
}

export interface ApolloSearchResult {
  leads: ApolloLead[];
  total: number;
  provider: "apollo" | "mock";
  error?: string;
}

// ── Derive job titles from free-text target_customer description ───────────────
function titlesFromTargetCustomer(tc: string): string[] {
  if (/\bcto\b|chief tech/i.test(tc))          return ["CTO", "VP Engineering"];
  if (/\bceo\b|founder|co-founder/i.test(tc))  return ["CEO", "Founder"];
  if (/\bcmo\b|chief market/i.test(tc))        return ["CMO", "VP Marketing"];
  if (/product manager|pm\b/i.test(tc))        return ["Product Manager", "Head of Product"];
  if (/developer|engineer|software/i.test(tc)) return ["Software Engineer", "Engineering Manager"];
  if (/designer|ux\b|ui\b/i.test(tc))          return ["UX Designer", "Product Designer"];
  if (/hr\b|human resource|recruiter/i.test(tc)) return ["HR Manager", "Head of People"];
  if (/sales|bdr|sdr|business dev/i.test(tc))  return ["Sales Manager", "VP Sales"];
  if (/marketer|marketing/i.test(tc))          return ["Marketing Manager", "Growth Marketer"];
  if (/doctor|physician|medical/i.test(tc))    return ["Physician", "Medical Director"];
  if (/teacher|educator|professor/i.test(tc))  return ["Teacher", "Education Director"];
  if (/startup|entrepreneur/i.test(tc))        return ["Startup Founder", "CEO"];
  return [];
}

// ── Map domain string to Apollo industry keyword ───────────────────────────────
function industryFromDomain(domain: string): string | null {
  if (/saas|software|tech/i.test(domain))        return "Computer Software";
  if (/fintech|finance|banking/i.test(domain))   return "Financial Services";
  if (/health|medical|pharma/i.test(domain))     return "Hospital & Health Care";
  if (/edtech|education/i.test(domain))          return "Education Management";
  if (/ecommerce|retail|shop/i.test(domain))     return "Retail";
  if (/real estate|proptech/i.test(domain))      return "Real Estate";
  if (/food|restaurant|hospitality/i.test(domain)) return "Food & Beverages";
  if (/marketing|adtech/i.test(domain))          return "Marketing and Advertising";
  if (/logistics|supply chain/i.test(domain))    return "Logistics and Supply Chain";
  if (/legal|lawtech/i.test(domain))             return "Law Practice";
  return null;
}

import { getApolloKeys } from "./provider-keys";

// ── Main search function ───────────────────────────────────────────────────────
// Multi-key pool (APOLLO_API_KEYS, else legacy APOLLO_API_KEY): rotates to the
// next key on 429 rate-limit only. 401/403 are permanent (bad key or plan
// denial) and fail fast without burning the rest of the pool.
export async function searchLeads(params: {
  targetCustomer: string;
  domain: string;
  keywords?: string;
  limit?: number;
}): Promise<ApolloSearchResult> {
  const apiKeys = getApolloKeys();
  const limit = Math.min(params.limit ?? 10, 20);

  if (apiKeys.length === 0) {
    return { leads: [], total: 0, provider: "mock", error: "APOLLO_API_KEY not configured" };
  }

  try {
    const titles  = titlesFromTargetCustomer(params.targetCustomer);
    const industry = industryFromDomain(params.domain);

    const body: Record<string, unknown> = {
      per_page: limit,
      page: 1,
      contact_email_status_v2: ["verified", "guessed"],
    };
    if (titles.length > 0) body.person_titles = titles;
    if (industry)          body.q_organization_keyword_tags = [industry];
    if (params.keywords)   body.q_keywords = params.keywords;

    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[i];
      const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      // 429 rotates only while another key remains; the last key's 429
      // falls into the error return below (quota exhausted on every key).
      if (res.status === 429 && i < apiKeys.length - 1) continue;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return {
          leads: [],
          total: 0,
          provider: "apollo",
          error: "Apollo API error " + res.status + ": " + errText.slice(0, 200),
        };
      }

    type ApolloPersonRaw = {
      id?: string;
      name?: string;
      title?: string;
      organization?: { name?: string };
      email?: string;
      linkedin_url?: string;
      city?: string;
      country?: string;
      seniority?: string;
      headline?: string;
    };
    const data = await res.json() as {
      people?: ApolloPersonRaw[];
      pagination?: { total_entries?: number };
    };

    const people = data.people ?? [];
    const leads: ApolloLead[] = people.map((p) => ({
      id:           p.id ?? crypto.randomUUID(),
      name:         p.name ?? "Unknown",
      title:        p.title ?? "",
      company:      p.organization?.name ?? "",
      email:        p.email ?? null,
      linkedin_url: p.linkedin_url ?? null,
      city:         p.city ?? null,
      country:      p.country ?? null,
      seniority:    p.seniority ?? null,
      headline:     p.headline ?? null,
    }));

    return {
      leads,
      total: data.pagination?.total_entries ?? leads.length,
      provider: "apollo",
    };
    }
    // Unreachable: the pool is non-empty (guarded above) and every iteration
    // returns. Present only to satisfy the compiler's exhaustiveness check.
    return { leads: [], total: 0, provider: "apollo", error: "Apollo search failed: no keys attempted" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { leads: [], total: 0, provider: "apollo", error: "Apollo search failed: " + msg };
  }
}
 
