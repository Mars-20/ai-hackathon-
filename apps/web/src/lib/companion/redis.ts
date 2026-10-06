// Upstash Redis accelerator for companion memory (Task 4). Raw REST fetch —
// NO new npm deps. Same UPSTASH_REDIS_REST_URL/TOKEN vars as rate-limit; the
// 15-line REST shape below replicates lib/rate-limit.ts:126-145 (no import).
//
// Failure contract (opposite of rate-limit's fail-closed): reads degrade to
// null and writes are best-effort swallowed, because the compiled block and
// the inference budget are NON-CRITICAL paths with a Postgres fallback.
// Budget-path throw (incr) means the CALLER skips inference.

import { normalizeForMatch } from "./normalize";

export function companionCtxKey(userId: string): string {
  return `companion:ctx:v1:${userId}`;
}

// Cache-generation counter per user: writes bump it (invalidating every
// per-query entry at once); readers embed it in the entry key. Old entries
// are never deleted — they TTL out (≤3600 s) unread.
export function companionCtxGenKey(userId: string): string {
  return `companion:ctxgen:v1:${userId}`;
}

// Order-insensitive fingerprint of the normalized query tokens, so the same
// idea in different words hits the same entry while different ideas never
// share a query-ranked block (review #4).
export function queryFingerprint(query: string): string {
  const toks = normalizeForMatch(query).sort().join(" ");
  let h = 0x811c9dc5;
  for (let i = 0; i < toks.length; i++) {
    h ^= toks.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function companionCtxEntryKey(userId: string, gen: string, fp: string): string {
  return `companion:ctx:v1:${userId}:${gen}:${fp}`;
}

export function companionBudgetKey(userId: string, nowMs: number = Date.now()): string {
  // UTC YYYYMMDD, NO dashes.
  const day = new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");
  return `companion:inferbudget:${userId}:${day}`;
}

const BUDGET_TTL_SECONDS = 86_400;

// Atomic daily counter: INCR + EXPIRE 86400 on first hit. The 50/day cap is a
// CLIENT-SIDE compare on the returned counter — Lua does NOT enforce it.
const BUDGET_LUA_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`.trim();

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function redisCommand(args: Array<string | number>): Promise<unknown> {
  const env = redisEnv();
  if (!env) throw new Error("Upstash Redis env missing");
  const res = await fetch(env.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash REST ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }
  return data?.result;
}

export async function redisGet(key: string): Promise<string | null> {
  try {
    const result = await redisCommand(["GET", key]);
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

export async function redisSetex(key: string, ttlSec: number, value: string): Promise<void> {
  try {
    await redisCommand(["SET", key, value, "EX", ttlSec]);
  } catch (err) {
    console.warn("[companion] redisSetex swallowed:", (err as Error)?.message ?? err);
  }
}

export async function redisDel(key: string): Promise<void> {
  try {
    await redisCommand(["DEL", key]);
  } catch (err) {
    console.warn("[companion] redisDel swallowed:", (err as Error)?.message ?? err);
  }
}

export async function incrBudgetAtomic(userId: string): Promise<number> {
  const key = companionBudgetKey(userId);
  const result = await redisCommand(["EVAL", BUDGET_LUA_SCRIPT, 1, key, String(BUDGET_TTL_SECONDS)]);
  const n = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(n)) throw new Error("Upstash: non-numeric budget counter");
  return n;
}
