// ─────────────────────────────────────────────────────────────────────────────
// Stats Tool — deterministic math, never by the model (Section 7)
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth: packages/tools/stats.ts. Re-exported here so app
// code keeps one import surface (@/lib/utils) with zero duplicated logic.
// The explicit `.ts` extension is required by the eval ts-bridge, which
// loads this module under `node --experimental-strip-types` (same sanctioned
// pattern as eval/harness/ts-bridge.mjs). Any divergence breaks
// stats-single-source.test.ts by design.
export {
  sampleStats,
  seanEllisScore,
  responseRate,
  confidenceInterval,
} from "../../../../packages/tools/stats.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Leading-Question Validator (Section 8 — survey-designer skill)
// ─────────────────────────────────────────────────────────────────────────────

const LEADING_PATTERNS = [
  /don'?t you think/i,
  /wouldn'?t you (agree|say|like)/i,
  /isn'?t it (true|obvious|clear)/i,
  /surely you/i,
  /as you know/i,
  /obviously/i,
  /clearly you/i,
  /wouldn'?t it be (great|nice|better|amazing)/i,
  /don'?t you (feel|believe|think|agree)/i,
  /^(don'?t you|isn'?t it|wouldn'?t you)/i,
  // Arabic leading-question patterns (Mom Test parity)
  /أليس (صحيح|واضح|من الواضح)/,
  /ألا (تعتقد|توافق|تتفق|ترى)/,
  /بالتأكيد (توافق|تتفق)/,
  /كما تعلم/,
  /من الواضح أنك/,
  /ألا تشعر/,
];

const HYPOTHETICAL_ONLY_PATTERNS = [
  /^(would|could|might|do you think) you (ever |consider |want |like |use |buy )/i,
  /^if .* would you/i,
  /^imagine .* would you/i,
  /would you (ever |consider |want |like |use |buy |pay )/i,
  /how much would you pay/i,
  /would you pay/i,
  // Arabic hypothetical-only
  /هل (ستشتري|ستستخدم|ستدفع|ستجرب)/,
  /تخيل .* هل/,
  /لو .* هل ستشتري/,
];

const PAST_BEHAVIOR_PATTERNS = [
  /last time/i,
  /in the past/i,
  /previously/i,
  /have you ever/i,
  /tell me about a time/i,
  /how (do|did) you currently/i,
  /walk me through/i,
  /describe when/i,
  // Arabic past-behavior (Mom Test)
  /آخر مرة/,
  /في الماضي/,
  /حدثني عن مرة/,
  /كيف تتعامل حاليا/,
  /صف لي موقف/,
  /هل سبق/,
];

export interface QuestionValidationResult {
  isLeading: boolean;
  isHypotheticalOnly: boolean;
  hasPastBehavior: boolean;
  warnings: string[];
  approved: boolean;
}

export function validateQuestion(question: string): QuestionValidationResult {
  const warnings: string[] = [];

  const isLeading = LEADING_PATTERNS.some((p) => p.test(question));
  const isHypotheticalOnly =
    HYPOTHETICAL_ONLY_PATTERNS.some((p) => p.test(question)) &&
    !PAST_BEHAVIOR_PATTERNS.some((p) => p.test(question));
  const hasPastBehavior = PAST_BEHAVIOR_PATTERNS.some((p) => p.test(question));

  if (isLeading) {
    warnings.push(
      "Leading question: implies a desired answer. Rewrite as open-ended (e.g. 'How do you currently handle X?')"
    );
  }
  if (isHypotheticalOnly) {
    warnings.push(
      "Hypothetical-only question: ask about past behavior instead (The Mom Test principle). Add 'Tell me about the last time...' framing."
    );
  }

  return {
    isLeading,
    isHypotheticalOnly,
    hasPastBehavior,
    warnings,
    approved: !isLeading && !isHypotheticalOnly,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence strength helpers (Section 5.3 commitment ladder)
// ─────────────────────────────────────────────────────────────────────────────

import type { EvidenceStrength, Confidence, Verdict } from "./types";

export const STRENGTH_RUNG: Record<EvidenceStrength, number> = {
  opinion: 1,
  intent: 2,
  time_given: 3,
  contact_shared: 4,
  commitment: 5,
};

export const STRENGTH_LABEL: Record<EvidenceStrength, string> = {
  opinion: "Opinion (rung 1)",
  intent: "Stated intent (rung 2)",
  time_given: "Time given (rung 3)",
  contact_shared: "Contact shared (rung 4)",
  commitment: "Hard commitment (rung 5)",
};

export const STRENGTH_COLOR: Record<EvidenceStrength, string> = {
  opinion: "#ff6b6b",
  intent: "#ff922b",
  time_given: "#ffd43b",
  contact_shared: "#74c0fc",
  commitment: "#51cf66",
};

// Determine if evidence meets Go threshold — CANONICAL Gate 1 (playbook §11).
// Single source of truth: Rung 4+ from >=3 independent sources AND
// n>=30 quant OR n>=12 interviews at saturation. eval/run-eval.js mirrors this.
export const GO_THRESHOLD = {
  MIN_RUNG: 4,
  MIN_INDEPENDENT_SOURCES: 3,
  MIN_SAMPLE_QUANT: 30,
  MIN_INTERVIEWS_SATURATED: 12,
} as const;

// Normalize a source URL for independence counting: lowercase, http→https,
// www. stripped, query + fragment stripped, trailing slashes stripped —
// same document, one source. UTM/campaign variants collapse to the base URL.
export function normalizeSourceUrl(u: unknown): string | undefined {
  if (typeof u !== "string" || u.trim().length === 0) return undefined;
  let s = u.trim().toLowerCase();
  s = s.split("#")[0].split("?")[0];
  s = s.replace(/^http:\/\//, "https://").replace(/^https:\/\/www\./, "https://");
  return s.replace(/\/+$/, "");
}

// Distinct independent sources (Task 7 thin-evidence gate): URL-bearing items
// de-duplicate by normalized URL; URL-less primary items (interviews / field
// notes with no link) each count as their own source. One URL repeated N
// times is ONE source — repeating a citation never manufactures independence.
// Exported for the eval ts-bridge (single-source counting, no local recount).
export function countDistinctSources(items: Array<{ source_url?: string }>): number {
  const urls = new Set<string>();
  let urlLess = 0;
  for (const e of items) {
    const n = normalizeSourceUrl(e.source_url);
    if (n) urls.add(n);
    else urlLess++;
  }
  return urls.size + urlLess;
}

export function meetsGoThreshold(
  primaryEvidence: Array<{ strength: EvidenceStrength; sample_size?: number; source_type?: string; source_url?: string }>
): { eligible: boolean; reason: string } {
  const rung4Plus = primaryEvidence.filter((e) => STRENGTH_RUNG[e.strength] >= GO_THRESHOLD.MIN_RUNG);
  const distinctSources = countDistinctSources(rung4Plus);
  const totalSample = rung4Plus.reduce((acc, e) => acc + (e.sample_size ?? 1), 0);
  const interviewSample = rung4Plus
    .filter((e) => e.source_type === "interview")
    .reduce((acc, e) => acc + (e.sample_size ?? 1), 0);

  if (rung4Plus.length === 0) {
    return { eligible: false, reason: "No rung-4+ primary evidence. Minimum: contact shared (rung 4)." };
  }
  if (distinctSources < GO_THRESHOLD.MIN_INDEPENDENT_SOURCES) {
    return {
      eligible: false,
      reason: `Only ${distinctSources} independent rung-4+ source(s) after URL de-dup. Minimum ${GO_THRESHOLD.MIN_INDEPENDENT_SOURCES} distinct sources required — a single repeated URL is thin evidence.`,
    };
  }
  if (totalSample >= GO_THRESHOLD.MIN_SAMPLE_QUANT) {
    return { eligible: true, reason: "Evidence meets Gate 1: rung-4+ x3+ sources, n>=30." };
  }
  if (interviewSample >= GO_THRESHOLD.MIN_INTERVIEWS_SATURATED) {
    return { eligible: true, reason: "Evidence meets Gate 1 via interviews: rung-4+ x3+ sources, n>=12 saturated." };
  }
  return {
    eligible: false,
    reason: `Sample too small (${totalSample} total, ${interviewSample} interviews). Need n>=30 quant or n>=12 saturated interviews.`,
  };
}

export function deriveConfidence(
  primaryEvidence: Array<{ strength: EvidenceStrength; sample_size?: number; source_type?: string; source_url?: string }>
): Confidence {
  const rung5 = primaryEvidence.filter((e) => STRENGTH_RUNG[e.strength] >= 5);
  const rung4Plus = primaryEvidence.filter((e) => STRENGTH_RUNG[e.strength] >= GO_THRESHOLD.MIN_RUNG);
  // Confidence rests on DISTINCT independent sources — repeating one URL
  // never manufactures medium/high (same-URL x3 stays low).
  const distinctSources = countDistinctSources(rung4Plus);
  // High rests on rung-5 depth specifically: padding a thin rung-5 base with
  // rung-4 volume must never read as high.
  const rung5Sample = rung5.reduce((acc, e) => acc + (e.sample_size ?? 1), 0);
  // Spec §2: the medium floor counts saturated INTERVIEWS only — survey/
  // usage volume must never masquerade as interview depth.
  const interviewSample = rung4Plus
    .filter((e) => e.source_type === "interview")
    .reduce((acc, e) => acc + (e.sample_size ?? 1), 0);

  if (distinctSources >= GO_THRESHOLD.MIN_INDEPENDENT_SOURCES && rung5.length >= GO_THRESHOLD.MIN_INDEPENDENT_SOURCES && rung5Sample >= GO_THRESHOLD.MIN_SAMPLE_QUANT) return "high";
  if (distinctSources >= GO_THRESHOLD.MIN_INDEPENDENT_SOURCES && rung4Plus.length >= GO_THRESHOLD.MIN_INDEPENDENT_SOURCES && interviewSample >= GO_THRESHOLD.MIN_INTERVIEWS_SATURATED) return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifier gate helpers (spec §4.4 — Task 10: gate, not advisory)
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifierResult {
  approved: boolean;
  unsupportedClaims: string[];
}

// A factual line is covered only by URL-bearing evidence that actually talks
// about the same claim (shared significant token or shared number) — one
// stray source_url never blankets unrelated claims (per-claim, not global).
export function claimHasUrlSupport(
  line: string,
  evidence: Array<{ claim?: string; source_url?: string }>
): boolean {
  const tokens = new Set(
    line
      .toLowerCase()
      .split(/[^a-z0-9\u0600-\u06ff]+/u)
      .filter((t) => t.length >= 4)
  );
  if (tokens.size === 0) return false;
  const numbers = line.match(/\d[\d.,%]*/g) ?? [];
  return evidence.some((e) => {
    if (!e.source_url || !e.claim) return false;
    const claimLower = e.claim.toLowerCase();
    const claimTokens = claimLower.split(/[^a-z0-9\u0600-\u06ff]+/u).filter((t) => t.length >= 4);
    if (claimTokens.some((t) => tokens.has(t))) return true;
    if (numbers.length > 0 && numbers.some((n) => claimLower.includes(n.toLowerCase()))) return true;
    return false;
  });
}

// Citation markers ([S1]/[A2]/[E3]/[D4]/[M5]) are provenance pointers, not
// factual content: the digit inside a marker must never trip the numeric
// detector, or every cited reply is flagged unsupported (markers never carry
// source_url). Bare numbers/URLs elsewhere in the line are still checked.
const CITATION_MARKER_RE = /\[[SAEDMW]\d+\]/g;

// Deterministic safety net: factual lines (numbers / $ / % / URLs / market
// sizing words) with no per-claim URL support are ungrounded.
export function findUnsupportedFactualClaims(
  text: string,
  evidence: Array<{ claim?: string; source_url?: string }>
): string[] {
  const out: string[] = [];
  const factualLines = text
    .replace(CITATION_MARKER_RE, "")
    .split(/[\n;.]/)
    .map((l) => l.trim())
    .filter((l) => /(\d|%|\$|http|million|billion|market worth)/i.test(l));
  for (const line of factualLines) {
    if (line.length > 12 && !claimHasUrlSupport(line, evidence) && !out.includes(line)) {
      out.push(line);
    }
  }
  return out;
}

// Post-memo rescan (final-review follow-up): the verifier checks the planner
// summary BEFORE the memo exists, so re-scan the memo text itself with the
// same deterministic net and union any new lines into the gate input. Pure:
// returns the input unchanged when the memo adds nothing.
export function combineVerifierWithMemoScan(
  verifier: VerifierResult,
  memoText: string,
  evidence: Array<{ claim?: string; source_url?: string }>
): VerifierResult {
  const extra = findUnsupportedFactualClaims(memoText, evidence).filter(
    (l) => !verifier.unsupportedClaims.includes(l)
  );
  if (extra.length === 0) return verifier;
  return { approved: false, unsupportedClaims: [...verifier.unsupportedClaims, ...extra] };
}

// Verifier gate: unsupported>0 blocks go → test_more + warnings[] (spec §4.4).
// Never advisory-only, never downgrades max-severity: only a "go" resting on
// ungrounded claims is patched. stop/iterate/test_more are preserved as-is
// (warnings still attached) — the gate blocks, it does not soften a kill.
export function applyVerifierGate(
  verdict: Verdict,
  verifier: VerifierResult
): { verdict: Verdict; warnings: string[]; overridden: boolean } {
  const warnings = [...verifier.unsupportedClaims];
  if (!verifier.approved || warnings.length > 0) {
    if (verdict === "go") return { verdict: "test_more", warnings, overridden: true };
    return { verdict, warnings, overridden: false };
  }
  return { verdict, warnings: [], overridden: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget guard helpers (Section 6.3)
// ─────────────────────────────────────────────────────────────────────────────

export const BUDGET = {
  MAX_COST_USD: 0.5,
  MAX_TOOL_CALLS: 15,
  HARD_TIMEOUT_MS: 90_000,
};

export function isBudgetExceeded(costUsd: number, toolCalls: number): boolean {
  return costUsd >= BUDGET.MAX_COST_USD || toolCalls >= BUDGET.MAX_TOOL_CALLS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function truncate(str: string, max = 120): string {
  return str.length <= max ? str : str.slice(0, max - 3) + "...";
}

export function getVerdictColor(verdict: string): string {
  const map: Record<string, string> = {
    go: "#40c057",
    iterate: "#fab005",
    stop: "#fa5252",
    test_more: "#5c7cfa",
  };
  return map[verdict] ?? "#94a3b8";
}

export function getRiskColor(risk: string): string {
  const map: Record<string, string> = {
    critical: "#fa5252",
    high: "#ff922b",
    medium: "#ffd43b",
    low: "#51cf66",
  };
  return map[risk] ?? "#94a3b8";
}
