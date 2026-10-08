import { normalizeKey, stagePosition, type StageStep } from "./tracks";

export interface SuggestDecision {
  id: string;
  verdict: string;
  created_at: string;
}

export interface SuggestDismissal {
  from: string;
  to: string;
  rung4_count: number;
  created_at: string;
}

export interface SuggestInput {
  stage: string;
  order: StageStep[];
  decisions: SuggestDecision[];
  rung4Count: number;
  rung4Ids: string[];
  dismissals: SuggestDismissal[];
  /** Threshold map of the active track (stage key → minimum rung-4 count). */
  thresholds: Record<string, number>;
}

export interface StageSuggestion {
  to: string;
  reason: string;
  refs: { decisionIds: string[]; evidenceIds: string[] };
}

/**
 * Pure hybrid-advancement rule engine. R1 (latest Go) wins over R2
 * (evidence threshold). A dismissal suppresses its (from,to) pair until a
 * newer Go lands or the rung-4 count grows past the dismissed count.
 * Off-track and final stages yield null (suggestions pause).
 */
export function suggestNextStage(input: SuggestInput): StageSuggestion | null {
  const idx = stagePosition(input.order, input.stage);
  if (idx < 0 || idx >= input.order.length - 1) return null;
  const next = input.order[idx + 1];

  const dismissal = input.dismissals
    .filter(
      (d) =>
        normalizeKey(d.from) === normalizeKey(input.stage) &&
        normalizeKey(d.to) === normalizeKey(next.key),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];

  const gos = input.decisions
    .filter((d) => d.verdict === "go")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const latestGo = gos[0];

  if (
    latestGo &&
    (!dismissal || latestGo.created_at > dismissal.created_at)
  ) {
    return {
      to: next.key,
      reason: "قرار Go معتمد يدعم الانتقال للمرحلة التالية",
      refs: { decisionIds: [latestGo.id], evidenceIds: [] },
    };
  }

  const threshold = input.thresholds[normalizeKey(input.stage)] ?? Infinity;
  if (
    input.rung4Count >= threshold &&
    (!dismissal || input.rung4Count > dismissal.rung4_count)
  ) {
    return {
      to: next.key,
      reason: `عتبة الأدلة تحققت (${input.rung4Count}) للانتقال للمرحلة التالية`,
      refs: { decisionIds: [], evidenceIds: input.rung4Ids },
    };
  }

  return null;
}
