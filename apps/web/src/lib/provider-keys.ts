/**
 * Provider multi-key rotation support.
 *
 * Pure helpers (no SDK imports) so they are unit-testable in isolation.
 * Rotation exists for QUOTA errors only (429 / quota-exceeded): a different
 * key carries its own quota, so failover recovers. Non-quota errors fail fast
 * exactly as before — cycling keys cannot fix a retired model or a bad request.
 */

function parseKeyList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Ordered Gemini API keys: GEMINI_API_KEYS (comma-separated) wins, else the legacy single GEMINI_API_KEY. */
export function getGeminiKeys(env: Record<string, string | undefined> = process.env): string[] {
  const multi = parseKeyList(env.GEMINI_API_KEYS);
  if (multi.length > 0) return multi;
  const single = (env.GEMINI_API_KEY ?? "").trim();
  return single ? [single] : [];
}

/** Ordered Groq API keys: GROQ_API_KEYS (comma-separated) wins, else the legacy single GROQ_API_KEY. */
export function getGroqKeys(env: Record<string, string | undefined> = process.env): string[] {
  const multi = parseKeyList(env.GROQ_API_KEYS);
  if (multi.length > 0) return multi;
  const single = (env.GROQ_API_KEY ?? "").trim();
  return single ? [single] : [];
}

/** True when the error is a quota/rate-limit rejection worth rotating keys for. */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|quota|exceed/i.test(msg);
}
