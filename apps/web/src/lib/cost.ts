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
// Spend ledger: in-memory counters are the dev/test fallback (single
// instance, lost on restart). In production back checkBudget/recordSpend with
// an atomic Supabase increment (e.g. an RPC over a workspace_spend table);
// the map below is NOT shared across instances.
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
 */
export function extractUsageCost(
  usageMetadata?: UsageMetadata | null,
  fallbackKind: CostKind = "gemini_call"
): number {
  const total = usageMetadata?.totalTokenCount;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    return (total / 1000) * BLENDED_USD_PER_1K_TOKENS;
  }
  return COST_TABLE[fallbackKind]; // FALLBACK: no provider metering available
}

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
  retryAfter?: number;
}

const memSpend = new Map<string, number>();

export function getSpentUsd(workspaceId: string): number {
  return memSpend.get(workspaceId) ?? 0;
}

/** Add spend to a workspace ledger. Returns the new total. Best-effort. */
export function recordSpend(workspaceId: string, amountUsd: number): number {
  if (!workspaceId || !(amountUsd > 0)) return memSpend.get(workspaceId) ?? 0;
  const next = (memSpend.get(workspaceId) ?? 0) + amountUsd;
  memSpend.set(workspaceId, next);
  return next;
}

/**
 * Atomic-budget gate (backed by an atomic store in prod; memory fallback here).
 * Single source of truth for the cap: BUDGET.MAX_COST_USD — never copied.
 */
export async function checkBudget(
  workspaceId: string,
  opts?: { additionalCostUsd?: number }
): Promise<BudgetCheck> {
  const limitUsd = BUDGET.MAX_COST_USD;
  const spentUsd = memSpend.get(workspaceId) ?? 0;
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
