/**
 * Exa web-search grounding (DIY grounding: free Search API + our own LLM).
 *
 * Canonical shapes follow the build-with-exa skill (v0.2.0,
 * references/search.md) — the skill is the source of truth, not memory:
 * POST https://api.exa.ai/search with `{ query, type: "auto",
 * contents: { highlights: true } }` and nothing else. Auth via the
 * `x-api-key` header. A bare query returns metadata only, so highlights
 * are the one content control we send (never stacked with text/summary).
 *
 * Fail-soft by design: search is best-effort evidence. Missing key,
 * non-OK status, network failure, or a malformed body all resolve to []
 * so the caller falls through to the existing Gemini → Groq chain.
 */

import { resolveTimeoutMs, withTimeout } from "./timeout";

export interface ExaSource {
  title: string;
  url: string;
  highlights: string[];
  publishedDate?: string;
}

export interface GroundedClaim {
  claim: string;
  url: string;
  published_at?: string;
}

type Env = Record<string, string | undefined>;

/** Trimmed EXA_API_KEY, or "" when unconfigured. */
export function getExaKey(env: Env = process.env): string {
  return (env.EXA_API_KEY ?? "").trim();
}

function isHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url);
}

/**
 * Run one Exa /search call with the skill-recommended request.
 * Never throws: every failure mode resolves to [].
 */
export async function searchExa(query: string, env: Env = process.env): Promise<ExaSource[]> {
  const key = getExaKey(env);
  if (!key) return [];
  const timeoutMs = resolveTimeoutMs(env.EXA_SEARCH_TIMEOUT_MS, 20_000);
  try {
    const res = await withTimeout(
      fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query,
          type: "auto",
          contents: { highlights: true },
        }),
      }),
      timeoutMs,
      "exa:search"
    );
    if (!res.ok) {
      console.warn(`[Exa search] non-OK status ${res.status}, falling through`);
      return [];
    }
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body?.results)) return [];
    const out: ExaSource[] = [];
    for (const r of body.results) {
      const item = r as {
        title?: unknown;
        url?: unknown;
        highlights?: unknown;
        publishedDate?: unknown;
      };
      if (typeof item?.title !== "string" || !isHttpUrl(item?.url)) continue;
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.filter((h): h is string => typeof h === "string")
        : [];
      const src: ExaSource = { title: item.title, url: item.url, highlights };
      if (typeof item.publishedDate === "string" && item.publishedDate) {
        src.publishedDate = item.publishedDate;
      }
      out.push(src);
    }
    return out;
  } catch (err) {
    console.warn("[Exa search] failed, falling through:", err);
    return [];
  }
}

/**
 * Anti-hallucination gate: keep only claims whose URL is exactly one of
 * the Exa-returned source URLs. An LLM-invented link never survives —
 * it cannot launder itself into a web_search citation. Caps at 6.
 */
export function matchClaimsToSources(
  claims: GroundedClaim[],
  sources: ExaSource[]
): GroundedClaim[] {
  const allowed = new Set(sources.map((s) => s.url));
  return claims
    .filter(
      (c) =>
        typeof c?.claim === "string" &&
        c.claim.trim().length > 0 &&
        typeof c?.url === "string" &&
        allowed.has(c.url) &&
        isHttpUrl(c.url)
    )
    .slice(0, 6)
    .map((c) => ({ claim: c.claim, url: c.url, ...(c.published_at ? { published_at: c.published_at } : {}) }));
}
