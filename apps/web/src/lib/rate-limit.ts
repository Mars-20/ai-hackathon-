// ─────────────────────────────────────────────────────────────────────────────
// Rate limit — distributed sliding-window gate for API routes.
//
// Backend selection is env-driven at call time:
// - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set → shared Redis
//   sorted-set sliding window (all instances see the same buckets).
// - Otherwise → in-memory per-instance fallback. Dev/test only: buckets are
//   lost on restart and NOT shared across instances. Do not rely on it in prod.
//
// Fail-closed: any Redis transport/response error returns { limited: true }
// with a computed retryAfter. A Redis outage must never silently disable
// the limit.
// ─────────────────────────────────────────────────────────────────────────────

export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 60_000;

export interface RateLimitArgs {
  key: string;
  limit?: number;
  windowMs?: number;
}

export interface RateLimitResult {
  limited: boolean;
  /** Seconds until the oldest hit in the window expires. 0 when not limited. */
  retryAfter: number;
}

export function resolveRateLimitKey(parts: { userId?: string; ip?: string; route?: string }): string {
  const uid = parts.userId?.trim();
  if (uid) return `user:${uid}`;
  return `ip:${parts.ip?.trim() || "unknown"}:${parts.route ?? ""}`;
}

// ── In-memory fallback (dev/test only — single instance, lost on restart) ────
const memBuckets = new Map<string, number[]>();

function checkMemory(key: string, limit: number, windowMs: number, now: number): RateLimitResult {
  const cutoff = now - windowMs;
  const hits = (memBuckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limit) {
    const oldest = hits[0] ?? now;
    memBuckets.set(key, hits);
    return { limited: true, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }
  hits.push(now);
  memBuckets.set(key, hits);
  return { limited: false, retryAfter: 0 };
}

/** Test-only reset for the in-memory fallback store. */
export function resetRateLimitForTests(): void {
  memBuckets.clear();
}

// ── Upstash Redis backend (shared sliding window via sorted set) ──────────────
function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function redisCmd(url: string, token: string, cmd: Array<string | number>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Upstash REST ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }
  return data?.result;
}

async function checkRedis(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  env: { url: string; token: string }
): Promise<RateLimitResult> {
  const cutoff = now - windowMs;
  await redisCmd(env.url, env.token, ["ZREMRANGEBYSCORE", key, 0, cutoff]);
  const countRaw = await redisCmd(env.url, env.token, ["ZCARD", key]);
  const count = typeof countRaw === "number" ? countRaw : Number(countRaw);
  // Fail-closed on shape anomalies too: an unparseable count must never
  // silently become "allowed".
  if (!Number.isFinite(count)) throw new Error("Upstash: unexpected ZCARD shape");
  if (Number.isFinite(count) && count >= limit) {
    const oldestRaw = await redisCmd(env.url, env.token, ["ZRANGE", key, 0, 0]);
    const first = Array.isArray(oldestRaw) ? String(oldestRaw[0] ?? "") : "";
    const oldest = Number(first.split(":")[0]);
    const retryAfter = Number.isFinite(oldest)
      ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
      : Math.ceil(windowMs / 1000);
    return { limited: true, retryAfter };
  }
  await redisCmd(env.url, env.token, ["ZADD", key, now, `${now}:${Math.random().toString(36).slice(2)}`]);
  await redisCmd(env.url, env.token, ["PEXPIRE", key, windowMs]);
  return { limited: false, retryAfter: 0 };
}

// ── Public gate ───────────────────────────────────────────────────────────────
export async function checkRateLimit({
  key,
  limit = RATE_MAX,
  windowMs = RATE_WINDOW_MS,
}: RateLimitArgs): Promise<RateLimitResult> {
  const env = redisEnv();
  if (!env) return checkMemory(key, limit, windowMs, Date.now());
  try {
    return await checkRedis(key, limit, windowMs, Date.now(), env);
  } catch {
    // Fail-closed: never bypass the limit because Redis is down.
    return { limited: true, retryAfter: Math.ceil(windowMs / 1000) };
  }
}
