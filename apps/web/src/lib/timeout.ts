// Per-request timeout guard (Section 6.3 hardening).
//
// Root cause (prod 2026-10-05): upstream LLM calls had no timeout —
// Gemini `generateContent` and the Groq `fetch` could hang indefinitely,
// and the cooperative `checkTimeout()` budget guard cannot preempt an
// in-flight await. One slow provider call (intake: 209.2s) ate the whole
// 90s run budget with zero partial value.
//
// `withTimeout` bounds every call so a hung provider fails fast into the
// existing Gemini→Groq→error failover chain instead of wedging the run.
// Promise.race subscribes to the work promise, so a late loser rejection
// is already handled (no unhandled-rejection noise); the timer is always
// cleared on settle. Note: racing does not CANCEL the underlying request
// (the provider still answers into the void) — it only stops the run from
// waiting on it. That is the standard SDK-agnostic tradeoff.

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// Env override parsing: positive integers win, anything else falls back to
// the default. Keeps timeout tuning deploy-time without a code change
// (same convention as GEMINI_PLANNER_MODEL / GROQ_ROUTER_MODEL).
export function resolveTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(parsed) && (parsed as number) > 0 ? (parsed as number) : fallbackMs;
}
