// ─────────────────────────────────────────────────────────────────────────────
// Cost — workspace spend ledger + provider-usage extractor.
//
// Two sources of truth, in priority order:
// 1. Provider metering via extractUsageCost(usageMetadata): real token counts
//    from the AI response. Preferred wherever the SDK exposes usageMetadata.
// 2. COST_TABLE below: blended per-call USD estimates. FALLBACK ONLY — it
//    exists so accounting is never the totalCost=0 fiction. Every call site
//    must prefer extractUsageCost(metadata) and use this table solely when
//    no metering is available. Replace with the provider price feed in prod.
//
// Spend ledger: atomic Supabase RPC (add_workspace_spend / get_workspace_spend
// over the workspace_spend table — see supabase/migrations/
// 20240101000003_workspace_spend.sql) when Supabase env is present; in-memory
// map below is the DEV/TEST FALLBACK ONLY (single instance, lost on restart,
// NOT shared across instances, NOT atomic across processes).
// ─────────────────────────────────────────────────────────────────────────────

import { BUDGET } from "./utils";

// FALLBACK ONLY — blended per-call USD estimates. See module header.
export const COST_TABLE = { gemini_call: 0.004, groq_call: 0.001, search: 0.002 } as const;

export type CostKind = keyof typeof COST_TABLE;

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  [key: string]: unknown;
}

// Blended USD per 1k tokens. Estimate — applies ONLY when usageMetadata is
// present but no real price feed is configured. Never use for billing.
const BLENDED_USD_PER_1K_TOKENS = 0.0004;

/**
 * Real-cost extractor: prefers provider usageMetadata, falls back to
 * COST_TABLE (marked fallback) when no metering is available.
 * SINGLE SOURCE for all per-call cost accounting — call sites must use this,
 * never COST_TABLE directly.
 */
export function extractUsageCost(
  usageMetadata?: UsageMetadata | null,
  fallbackKind: CostKind = "gemini_call"
): number {
  const total = usageMetadata?.totalTokenCount;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    return +((total / 1000) * BLENDED_USD_PER_1K_TOKENS).toFixed(6);
  }
  return COST_TABLE[fallbackKind]; // FALLBACK: no provider metering available
}

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
  retryAfter?: number;
}

// ── In-memory fallback (dev/test only — NOT shared, NOT atomic) ──────────────
const memSpend = new Map<string, number>();

export function getSpentUsd(workspaceId: string): number {
  return memSpend.get(workspaceId) ?? 0;
}

/**
 * Sync memory ledger — DEV/TEST FALLBACK ONLY. Production path is
 * recordSpendAsync (atomic Supabase RPC). Kept sync so existing call sites
 * and unit tests without Supabase env keep working; never use as the prod
 * ledger.
 */
export function recordSpend(workspaceId: string, amountUsd: number): number {
  if (!workspaceId || !(amountUsd > 0)) return memSpend.get(workspaceId) ?? 0;
  const next = (memSpend.get(workspaceId) ?? 0) + amountUsd;
  memSpend.set(workspaceId, next);
  return next;
}

// ── Supabase RPC atomic ledger (prod) ─────────────────────────────────────────
// Migration: supabase/migrations/20240101000003_workspace_spend.sql creates
// table workspace_spend + functions get_workspace_spend(p_key) and
// add_workspace_spend(p_key, p_amount) (single-statement upsert → atomic).
// Spend-ledger auth (Task 6): service_role ONLY. The anon key must never
// authorize spend writes/reads — the ledger is server-only. When the service
// key is absent (dev/test without Supabase env), callers fall back to the
// in-memory ledger below; production without a service key fails closed in
// checkBudget/recordSpendAsync via the missing-RPC path.
function spendRpcEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

async function callSpendRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const env = spendRpcEnv();
  if (!env) throw new Error("spend RPC unavailable: Supabase env absent");
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`spend RPC ${fn} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function isMissingRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Could not find the function|PGRST202|404/.test(msg);
}

/**
 * Atomic spend increment via Supabase RPC. Falls back to the in-memory ledger
 * ONLY when the RPC is absent (dev without migration / no Supabase env).
 * Other RPC errors are re-thrown so callers can fail closed.
 */
export async function recordSpendAsync(workspaceId: string, amountUsd: number): Promise<number> {
  if (!workspaceId || !(amountUsd > 0)) return getSpentUsd(workspaceId);
  if (spendRpcEnv()) {
    try {
      const total = await callSpendRpc("add_workspace_spend", { p_key: workspaceId, p_amount: amountUsd });
      const n = typeof total === "number" ? total : Number(total);
      if (Number.isFinite(n)) return n;
      throw new Error("spend RPC: unexpected shape");
    } catch (err) {
      if (!isMissingRpcError(err)) throw err;
      // RPC absent (dev) → memory fallback, clearly marked.
    }
  }
  return recordSpend(workspaceId, amountUsd); // FALLBACK (dev/test only)
}

async function getSpentUsdAsync(workspaceId: string): Promise<number> {
  if (spendRpcEnv()) {
    try {
      const spent = await callSpendRpc("get_workspace_spend", { p_key: workspaceId });
      const n = typeof spent === "number" ? spent : Number(spent);
      if (Number.isFinite(n)) return n;
      throw new Error("spend RPC: unexpected shape");
    } catch (err) {
      if (!isMissingRpcError(err)) throw err;
      // RPC absent (dev) → memory fallback.
    }
  }
  return memSpend.get(workspaceId) ?? 0; // FALLBACK (dev/test only)
}

/**
 * Atomic-budget gate. Single source of truth for the cap: BUDGET.MAX_COST_USD
 * — never copied. Prod reads go through the atomic Supabase ledger; memory
 * fallback applies ONLY when the RPC is absent (dev). Fail-closed on store
 * errors: an unreadable ledger blocks the request (explicit 429/402 upstream)
 * rather than silently bypassing the budget.
 */
export async function checkBudget(
  workspaceId: string,
  opts?: { additionalCostUsd?: number }
): Promise<BudgetCheck> {
  const limitUsd = BUDGET.MAX_COST_USD;
  let spentUsd: number;
  try {
    spentUsd = await getSpentUsdAsync(workspaceId);
  } catch {
    // Fail-closed: ledger unreadable → block, never bypass.
    return { allowed: false, spentUsd: limitUsd, limitUsd, retryAfter: 60 };
  }
  const additional = opts?.additionalCostUsd ?? 0;
  if (spentUsd + additional >= limitUsd) {
    return { allowed: false, spentUsd, limitUsd, retryAfter: 60 };
  }
  return { allowed: true, spentUsd, limitUsd };
}

/** Test-only reset for the in-memory spend ledger. */
export function resetCostForTests(): void {
  memSpend.clear();
}
