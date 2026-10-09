// Post-session inference pipeline (Task 6).
// Pure prompt/parse/filter stages plus a budget-guarded propose step.
// NEVER imports traces/spend: inference consumes a fixed daily model budget.
import type { ProposeResult, ProposeRow } from "./dal";
import { normalizeForMatch } from "./normalize";
import { INFER_CONFIDENCE_THRESHOLD } from "./ranker";
import { incrBudgetAtomic } from "./redis";
import { containsBlockedSecret, containsThirdPartyPii } from "./scans";
import { memoryKindSchema, memoryValueSchema } from "./validation";

export const INFER_DAILY_LIMIT = 50;

export interface ExtractionCandidate {
  kind: string;
  value: string;
  confidence: number;
}

export interface InferCallResult {
  text: string;
  usage: { totalTokenCount: number };
}

export type InferSkipReason = "over-cap" | "disabled";

// Arabic extraction contract: facts about the account holder ONLY; other
// persons from evidence/interviews, secrets, and third-party contacts are
// banned at the prompt level AND re-enforced by the deterministic filters.
export function buildExtractionPrompt(memoText: string, startupName: string): string {
  return [
    "استخرج حقائق عن صاحب الحساب فقط من مذكرة الجلسة التالية.",
    "ممنوع منعاً باتاً: استنتاج معلومات عن أشخاص آخرين ظهروا في الأدلة أو المقابلات.",
    "ممنوع: الأسرار والمفاتيح (sk-live، AKIA، المفاتيح الخاصة، التوكنات) وأي بيانات تواصل لأشخاص آخرين.",
    `الشركة الناشئة: ${startupName}`,
    `المذكرة: ${memoText}`,
    'أعد مصفوفة JSON فقط بالشكل: [{"kind":"fact|preference|style|episode","value":"...","confidence":0.0-1.0}].',
    "لا تضف أي شرح خارج المصفوفة.",
  ].join("\n");
}

function stripCodeFences(t: string): string {
  const s = t.trim();
  if (!s.startsWith("```")) return s;
  const firstNl = s.indexOf("\n");
  const inner = firstNl === -1 ? "" : s.slice(firstNl + 1);
  return inner.replace(/```\s*$/, "").trim();
}

// Keeps well-formed {kind,value,confidence} items; drops confidence < 0.7,
// out-of-vocabulary kinds, empty/overlong values, and malformed payloads.
// Never throws: a confused model yields [], never a 500.
export function parseExtractionResult(jsonText: string): ExtractionCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(jsonText));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractionCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (!memoryKindSchema.safeParse(rec.kind).success) continue;
    if (typeof rec.value !== "string") continue;
    const value = rec.value.trim();
    if (!memoryValueSchema.safeParse(value).success) continue;
    if (typeof rec.confidence !== "number" || !Number.isFinite(rec.confidence)) continue;
    if (rec.confidence < 0 || rec.confidence > 1) continue;
    if (rec.confidence < INFER_CONFIDENCE_THRESHOLD) continue;
    out.push({ kind: rec.kind as string, value, confidence: rec.confidence });
  }
  return out;
}

function normalizedKey(value: string): string {
  return normalizeForMatch(value).join(" ");
}

// Exact-normalized dupes of already-approved values are suppressed;
// near-misses are KEPT (Task 7 flags possible conflicts at decide time).
export function dedupeAgainstApproved(
  cands: ExtractionCandidate[],
  approvedValues: string[],
): ExtractionCandidate[] {
  const approved = new Set(approvedValues.map(normalizedKey));
  return cands.filter((c) => !approved.has(normalizedKey(c.value)));
}

// Full deterministic chain: secret scan -> third-party-PII scan (the user's
// own contact is allowlisted) -> approved-dupe suppress -> within-batch
// normalized-dupe suppress (keep first). Conflicts are NOT dropped here.
export function filterExtractionCandidates(
  cands: ExtractionCandidate[],
  opts: { userEmail: string; approvedValues: string[] },
): ExtractionCandidate[] {
  const allowlist = [opts.userEmail];
  const seen = new Set<string>();
  const out: ExtractionCandidate[] = [];
  for (const c of dedupeAgainstApproved(cands, opts.approvedValues)) {
    if (containsBlockedSecret(c.value)) continue;
    if (containsThirdPartyPii(c.value, allowlist)) continue;
    const key = normalizedKey(c.value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Spend-first-drop-later: the daily budget counter increments BEFORE the
// model call, so count 51 over a limit of 50 skips with NO model spend.
// Disabled skips before any spend as well. Redis outage NO LONGER skips
// (live gap 2026-10-09: 16 consecutive prod skips with a dead counter):
// fail-open proceeds WITHOUT the increment and stamps budgetFallback so the
// trace shows the daily cap was unenforced. Abuse-bounded anyway: the caller
// still ledgers every model call against the quota budget key.
export async function runPostSessionInference(args: {
  userId: string;
  userEmail: string;
  memoText: string;
  startupName: string;
  approvedValues: string[];
  isEnabled?: boolean;
  callAI: (prompt: string) => Promise<InferCallResult>;
  propose: (rows: ProposeRow[]) => Promise<ProposeResult>;
}): Promise<
  | { skipped: InferSkipReason }
  | {
      proposed: ProposeResult;
      usage: { totalTokenCount: number };
      proposeError?: string;
      budgetFallback?: boolean;
    }
> {
  if (args.isEnabled === false) return { skipped: "disabled" };
  let count = 0;
  let budgetFallback = false;
  try {
    count = await incrBudgetAtomic(args.userId);
  } catch {
    // Fail-open (see header): dead counter ⇒ proceed, stamped.
    budgetFallback = true;
  }
  if (!budgetFallback && count > INFER_DAILY_LIMIT) return { skipped: "over-cap" };
  const stamp = budgetFallback ? { budgetFallback: true as const } : {};
  const { text, usage } = await args.callAI(
    buildExtractionPrompt(args.memoText, args.startupName),
  );
  const rows: ProposeRow[] = filterExtractionCandidates(parseExtractionResult(text), {
    userEmail: args.userEmail,
    approvedValues: args.approvedValues,
  }).map((c) => ({ kind: c.kind, value: c.value, confidence: c.confidence }));
  if (rows.length === 0) return { proposed: { results: [], dropped: [] }, usage, ...stamp };
  // Channel stamp (review minor): inferred rows carry their provenance like
  // manual rows carry "manual". startup_id stays null — only the startup
  // NAME is known at infer time, never its id.
  const stamped = rows.map((r) => ({ ...r, source_ref: "post-session" }));
  try {
    return { proposed: await args.propose(stamped), usage, ...stamp };
  } catch (e) {
    // The model call already spent tokens: surface usage WITH the failure so
    // the hook still ledgers spend instead of dropping it (review #9).
    // Nothing was proposed — results stay empty, never partial.
    return {
      proposed: { results: [], dropped: [] },
      usage,
      proposeError: e instanceof Error ? e.message : String(e),
      ...stamp,
    };
  }
}
