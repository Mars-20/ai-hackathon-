// ─────────────────────────────────────────────────────────────────────────────
// Snov.io API Service — Validation Copilot Lead Finder (fallback provider)
// Database Search API: prospect search is FREE; only the per-prospect email
// reveal costs 1 credit (trial balance: 50). Reveals are capped via
// SNOV_MAX_REVEALS (default 5) so one validation run cannot drain the trial.
// Probed 2026-10-05: token POST /v1/oauth/access_token is form-encoded;
// prospects/start accepts ONLY form-encoded filters
// (filters[prospect][job_titles][include][], filters[company][industries][include][]);
// JSON bodies 422 with "At least one filter must be provided."
// Docs: https://snov.io/knowledgebase/how-to-use-database-search-api
// ─────────────────────────────────────────────────────────────────────────────

import type { ApolloLead } from "./apollo";

export interface SnovSearchResult {
  leads: ApolloLead[];
  total: number;
  provider: "snov" | "mock";
  error?: string;
}

const SNOV_BASE = "https://api.snov.io";
const TOKEN_TTL_MARGIN_MS = 60_000;
const DEFAULT_MAX_REVEALS = 5;

interface SnovCredentials {
  userId: string;
  secret: string;
}

function getSnovCredentials(env: Record<string, string | undefined> = process.env): SnovCredentials | null {
  const userId = (env.SNOV_API_USER_ID ?? "").trim();
  const secret = (env.SNOV_API_SECRET ?? "").trim();
  if (!userId || !secret) return null;
  return { userId, secret };
}

function getMaxReveals(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env.SNOV_MAX_REVEALS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 20);
  return DEFAULT_MAX_REVEALS;
}

// ── Cached OAuth token (module-level; per serverless instance) ───────────────
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

/** Test-only helper: clears the in-memory token cache between tests. */
export function __resetSnovTokenCache(): void {
  cachedToken = null;
}

async function getSnovToken(creds: SnovCredentials): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  const res = await fetch(`${SNOV_BASE}/v1/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=client_credentials" +
      "&client_id=" + encodeURIComponent(creds.userId) +
      "&client_secret=" + encodeURIComponent(creds.secret),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("Snov token error " + res.status + ": " + errText.slice(0, 200));
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Snov token error: missing access_token");
  const ttlMs = (data.expires_in ?? 3600) * 1000 - TOKEN_TTL_MARGIN_MS;
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + Math.max(ttlMs, 0) };
  return data.access_token;
}

// ── Derive job titles from free-text target_customer description ─────────────
// Snov matches title variations ("CEO" also matches "Chief Executive Officer").
function titlesFromTargetCustomer(tc: string): string[] {
  if (/\bcto\b|chief tech/i.test(tc))           return ["CTO", "VP Engineering"];
  if (/\bceo\b|founder|co-founder/i.test(tc))   return ["CEO", "Founder"];
  if (/\bcmo\b|chief market/i.test(tc))         return ["CMO", "VP Marketing"];
  if (/product manager|pm\b/i.test(tc))         return ["Product Manager", "Head of Product"];
  if (/developer|engineer|software/i.test(tc))   return ["Software Engineer", "Engineering Manager"];
  if (/designer|ux\b|ui\b/i.test(tc))           return ["UX Designer", "Product Designer"];
  if (/hr\b|human resource|recruiter/i.test(tc)) return ["HR Manager", "Head of People"];
  if (/sales|bdr|sdr|business dev/i.test(tc))   return ["Sales Manager", "VP Sales"];
  if (/marketer|marketing/i.test(tc))           return ["Marketing Manager", "Growth Marketer"];
  return [];
}

// ── Map domain string to a Snov industry name ─────────────────────────────────
// Only values verified against the live API are returned; anything else omits
// the industry filter (titles-only search) rather than risk a 422.
function industryFromDomain(domain: string): string | null {
  if (/saas|software|tech/i.test(domain)) return "Computer Software";
  return null;
}

function buildFilterForm(titles: string[], industry: string | null): URLSearchParams {
  const form = new URLSearchParams();
  const picks = titles.length > 0 ? titles.slice(0, 3) : ["CEO"];
  for (const t of picks) form.append("filters[prospect][job_titles][include][]", t);
  if (industry) form.append("filters[company][industries][include][]", industry);
  return form;
}

type SnovProspectRaw = {
  first_name?: string;
  last_name?: string;
  job_title?: string;
  location?: string;
  linkedin_url?: string;
  industry?: string;
  company?: { name?: string; domain?: string; location?: string; industry?: string; size?: string };
  email_and_hidden_info_reveal?: string;
};

type SnovRevealRaw = {
  first_name?: string;
  last_name?: string;
  linkedin_url?: string;
  email?: string;
  emails?: Array<{ email?: string }>;
  email_status?: string;
  position?: string;
  company?: { name?: string };
};

async function pollResult<T>(url: string, token: string, attempts = 6): Promise<T> {
  let last: T | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Snov result error " + res.status + ": " + errText.slice(0, 200));
    }
    last = (await res.json()) as T & { status?: string };
    const status = (last as { status?: string }).status;
    if (status === "completed" || status === "done" || status === undefined) return last;
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return last as T;
}

// ── Main search function ─────────────────────────────────────────────────────
// Free prospect search → capped email reveals → ApolloLead shape so the caller
// (runLeadFinderSkill) can use either provider interchangeably. Provider is
// "snov" on any real attempt; "mock" only when credentials are missing.
export async function searchSnovLeads(params: {
  targetCustomer: string;
  domain: string;
  limit?: number;
}): Promise<SnovSearchResult> {
  const creds = getSnovCredentials();
  const limit = Math.min(params.limit ?? 10, 20);
  const maxReveals = Math.min(getMaxReveals(), limit);

  if (!creds) {
    return { leads: [], total: 0, provider: "mock", error: "SNOV_API_USER_ID / SNOV_API_SECRET not configured" };
  }

  try {
    const token = await getSnovToken(creds);
    const titles = titlesFromTargetCustomer(params.targetCustomer);
    const industry = industryFromDomain(params.domain);

    const startRes = await fetch(`${SNOV_BASE}/v2/database-search/prospects/start`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: buildFilterForm(titles, industry),
      signal: AbortSignal.timeout(15_000),
    });
    if (!startRes.ok) {
      const errText = await startRes.text().catch(() => "");
      return { leads: [], total: 0, provider: "snov", error: "Snov search error " + startRes.status + ": " + errText.slice(0, 200) };
    }
    const startData = (await startRes.json()) as { links?: { result?: string }; meta?: { task_hash?: string } };
    const resultUrl = startData.links?.result ??
      (startData.meta?.task_hash ? `${SNOV_BASE}/v2/database-search/prospects/result/${startData.meta.task_hash}` : null);
    if (!resultUrl) return { leads: [], total: 0, provider: "snov", error: "Snov search error: missing result URL" };

    const result = await pollResult<{ status?: string; data?: { total?: number; prospects?: SnovProspectRaw[] } }>(resultUrl, token);
    const prospects = result.data?.prospects ?? [];
    const total = result.data?.total ?? prospects.length;

    const leads: ApolloLead[] = [];
    for (const p of prospects.slice(0, maxReveals)) {
      if (!p.email_and_hidden_info_reveal) continue;
      try {
        const revStart = await fetch(p.email_and_hidden_info_reveal, {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15_000),
        });
        if (!revStart.ok) continue;
        const revData = (await revStart.json()) as { links?: { result?: string }; meta?: { task_hash?: string } };
        const revUrl = revData.links?.result ??
          (revData.meta?.task_hash
            ? `${SNOV_BASE}/v2/database-search/prospects/search-emails/result/${revData.meta.task_hash}`
            : null);
        if (!revUrl) continue;
        const revealed = await pollResult<{ status?: string; data?: SnovRevealRaw }>(revUrl, token, 4);
        const d = revealed.data;
        const email = d?.email ?? d?.emails?.[0]?.email ?? null;
        if (!email) continue;
        const fullName = [d?.first_name ?? p.first_name ?? "", d?.last_name ?? ""].join(" ").trim() || "Unknown";
        leads.push({
          id: crypto.randomUUID(),
          name: fullName,
          title: d?.position ?? p.job_title ?? "",
          company: d?.company?.name ?? p.company?.name ?? "",
          email,
          linkedin_url: d?.linkedin_url ?? null,
          city: null,
          country: p.location ?? null,
          seniority: null,
          headline: null,
        });
      } catch {
        continue;
      }
    }

    return { leads, total, provider: "snov" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { leads: [], total: 0, provider: "snov", error: "Snov search failed: " + msg };
  }
}
