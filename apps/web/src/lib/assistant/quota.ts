// Independent daily chat quota (D3): never touches validation quota.
// consume/refund hit the SECURITY DEFINER RPCs (service-role only); user
// clients can neither read nor write assistant_quota (zero public policies).

import type { SupabaseClient } from "@supabase/supabase-js";

export const ASSISTANT_QUOTA_DEFAULT = 50;

/**
 * Env guard identical to trial-claims resolvePositiveInt (module-local there):
 * finite positive int or fallback.
 */
export function getDailyQuota(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = (env.ASSISTANT_DAILY_QUOTA ?? "").trim();
  const n = Number(raw);
  if (raw.length > 0 && Number.isFinite(n) && Math.floor(n) === n && n > 0) {
    return n;
  }
  return ASSISTANT_QUOTA_DEFAULT;
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  remaining: number;
}

/** Atomic consume (row-locked in SQL). Throws on RPC/infra failure (fail-closed). */
export async function consumeOne(
  admin: SupabaseClient,
  userId: string,
  max: number
): Promise<QuotaDecision> {
  const { data, error } = await admin.rpc("consume_assistant_message", {
    p_user: userId,
    p_max: max,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as QuotaDecision | null;
  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("consume_assistant_message returned an unexpected shape");
  }
  return { allowed: row.allowed, used: row.used, remaining: row.remaining };
}

/** Refund one unit (provider-total-outage before dispatch only). */
export async function refundOne(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await admin.rpc("refund_assistant_message", {
    p_user: userId,
  });
  if (error) throw error;
}

/** Seconds from nowMs to next UTC midnight (Retry-After for 402 quota). */
export function secondsToUtcMidnight(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1
  );
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}
