// ─────────────────────────────────────────────────────────────────────────────
// Rate limit — distributed sliding-window gate for API routes.
//
// Backend selection is env-driven at call time:
// - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set → shared Redis
//   sliding window via a SINGLE atomic Lua script (EVAL). All instances share
//   the same buckets; concurrent bursts cannot overshoot the limit because
//   ZREMRANGEBYSCORE + ZCARD + ZADD + PEXPIRE run atomically server-side.
// - Otherwise → in-memory per-instance fallback. Dev/test only: buckets are
//   lost on restart and NOT shared across instances. Do not rely on it in prod.
//
// Fail-closed: any Redis transport/response error returns { limited: true }
// with a computed retryAfter. A Redis outage must never silently disable
// the limit.
//
// Live-Redis gate (Task 9 infra follow-up): the Upstash path is covered by
// mocked-fetch integration tests (EVAL/Lua shape + atomic single-roundtrip).
// Before prod, verify against a real Upstash instance with
// UPSTASH_REDIS_REST_URL/TOKEN set (Task 9 env docs own the secret wiring).
// ─────────────────────────────────────────────────────────────────────────────

export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 60_000;

/** Redis key namespace — all rate-limit buckets live under this prefix. */
export const RATE_KEY_PREFIX = "ratelimit:";

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

/**
 * Resolve the bucket key. Authenticated user id wins; else the workspace id
 * (so one abusive workspace cannot hide behind rotating ips); anonymous
 * callers without a workspace fall back to ip+route.
 *
 * TRUSTED-PROXY NOTE (Task 9 infra follow-up): `x-forwarded-for` is
 * client-spoofable unless an edge proxy overwrites it. Never treat the ip key
 * as an identity — it is only a coarse abuse brake. Behind a CDN/LB, configure
 * trusted proxies (or use the platform-provided client ip, e.g. Vercel's
 * `x-vercel-forwarded-for` / `x-real-ip`) so the first XFF entry is the edge
 * value, not attacker input. Authenticated `user:` keys are always preferred,
 * `workspace:` keys second; the `ip:` key is last resort only.
 */
export function resolveRateLimitKey(parts: { userId?: string; workspaceId?: string; ip?: string; route?: string }): string {
  const uid = parts.userId?.trim();
  if (uid) return `${RATE_KEY_PREFIX}user:${uid}`;
  const ws = parts.workspaceId?.trim();
  if (ws) return `${RATE_KEY_PREFIX}workspace:${ws}`;
  return `${RATE_KEY_PREFIX}ip:${parts.ip?.trim() || "unknown"}:${parts.route ?? ""}`;
}

/**
 * Extract the client ip for rate-limit bucketing. See TRUSTED-PROXY NOTE on
 * resolveRateLimitKey: the first XFF entry is used as a best-effort signal
 * only; authenticated user keys take precedence wherever available.
 */
export function getClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // Platform fallbacks (Vercel / generic) — still untrusted without edge config.
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
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

// ── Upstash Redis backend (ATOMIC sliding window via single EVAL) ─────────────
// One roundtrip per check. The Lua script runs atomically server-side, so a
// concurrent burst of N requests can never admit more than `limit` hits —
// unlike the previous 4-roundtrip ZREM/ZCARD/ZADD/PEXPIRE sequence which
// raced under burst load.
export const RATE_LIMIT_LUA_SCRIPT = `
local key = KEYS[1]
local cutoff = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]
local windowMs = tonumber(ARGV[4])
local limit = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = tonumber(oldest[2]) or now
  local retryMs = (oldestScore + windowMs) - now
  local retrySec = math.max(1, math.ceil(retryMs / 1000))
  return {1, retrySec}
else
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {0, 0}
end
`.trim();

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function redisEval(url: string, token: string, script: string, key: string, args: Array<string | number>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(["EVAL", script, 1, key, ...args]),
  });
  if (!res.ok) throw new Error(`Upstash REST ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }
  return data?.result;
}

async function checkRedisAtomic(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  env: { url: string; token: string }
): Promise<RateLimitResult> {
  const cutoff = now - windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;
  const result = await redisEval(env.url, env.token, RATE_LIMIT_LUA_SCRIPT, key, [
    cutoff,
    now,
    member,
    windowMs,
    limit,
  ]);
  // Fail-closed on shape anomalies too: an unparseable script result must
  // never silently become "allowed".
  if (!Array.isArray(result) || result.length < 2) throw new Error("Upstash: unexpected EVAL shape");
  const limitedFlag = Number(result[0]);
  const retryRaw = Number(result[1]);
  if (!Number.isFinite(limitedFlag)) throw new Error("Upstash: unexpected EVAL shape");
  if (limitedFlag === 1) {
    const retryAfter = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.ceil(retryRaw) : Math.ceil(windowMs / 1000);
    return { limited: true, retryAfter };
  }
  if (limitedFlag === 0) return { limited: false, retryAfter: 0 };
  throw new Error("Upstash: unexpected EVAL shape");
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
    return await checkRedisAtomic(key, limit, windowMs, Date.now(), env);
  } catch {
    // Fail-closed: never bypass the limit because Redis is down.
    return { limited: true, retryAfter: Math.ceil(windowMs / 1000) };
  }
}
