/**
 * Gemini multi-key rotation support.
 *
 * Pure helpers (no SDK imports) so they are unit-testable in isolation.
 * Rotation exists for QUOTA errors only (429 / quota-exceeded): a different
 * key carries its own quota, so failover recovers. All other errors (404
 * retired model, 400 bad request, 503 capacity) fail fast exactly as before —
 * cycling keys cannot fix them.
 */

/** Ordered Gemini API keys: GEMINI_API_KEYS (comma-separated) wins, else the legacy single GEMINI_API_KEY. */
export function getGeminiKeys(env: Record<string, string | undefined> = process.env): string[] {
  const multi = (env.GEMINI_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (multi.length > 0) return multi;
  const single = (env.GEMINI_API_KEY ?? "").trim();
  return single ? [single] : [];
}

/** True when the error is a quota/rate-limit rejection worth rotating keys for. */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|quota|exceed/i.test(msg);
}
