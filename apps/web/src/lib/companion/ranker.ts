import { estimateTokens, normalizeForMatch } from "./normalize";
import { toUntrusted } from "./escape";

export const MEMORY_KIND_WEIGHTS = {
  fact: 0.6,
  preference: 0.5,
  episode: 0.3,
  style: 0.1,
} as const;
export type MemoryKind = keyof typeof MEMORY_KIND_WEIGHTS;

export const INFER_CONFIDENCE_THRESHOLD = 0.7;
export const COMPILED_CONTEXT_TOKEN_LIMIT = 300;
export const MEMORY_RECENCY_HALF_LIFE_DAYS = 30;

// Full nullable DB shape of public.companion_memory (Task 3 interface).
export interface MemoryRow {
  id: string;
  kind: string;
  value: string;
  created_at: string;
  status?: string | null;
  confidence?: number | null;
  source_ref?: string | null;
  startup_id?: string | null;
  decided_at?: string | null;
}

const MS_PER_DAY = 86_400_000;

export function scoreMemory(row: MemoryRow, queryTokens: string[], nowMs: number): number {
  const weight = (MEMORY_KIND_WEIGHTS as Record<string, number>)[row.kind] ?? 0;
  // Unparseable timestamps score as age 0 — never NaN (NaN poisons the
  // sort comparator into nondeterminism). Review minor.
  const parsed = Date.parse(row.created_at);
  const ageDays = Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / MS_PER_DAY) : 0;
  const decay = Math.exp(-ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);
  const tokens = new Set(normalizeForMatch(row.value));
  const normQuery = queryTokens.flatMap((t) => normalizeForMatch(t));
  // Empty query: recency x kind only (stays finite, no NaN division).
  if (normQuery.length === 0) return weight * decay;
  const shared = normQuery.filter((t) => tokens.has(t)).length;
  return weight * decay * (1 + shared / normQuery.length);
}

// Greedy-takes in score-desc order (id tiebreak for determinism) while the
// running budget holds; values are wrapped via escape.ts AT COMPILE TIME, so
// the cached block is the WRAPPED block. The final join is re-measured, so
// output always respects COMPILED_CONTEXT_TOKEN_LIMIT.
export function compileContext(rows: MemoryRow[], query: string, nowMs: number): string {
  const q = normalizeForMatch(query);
  const scored = rows.map((r) => ({ r, s: scoreMemory(r, q, nowMs) }));
  scored.sort((a, b) => b.s - a.s || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  let acc = "";
  for (const { r } of scored) {
    const line = `[${r.kind}] ${toUntrusted(r.value)}`;
    const candidate = acc === "" ? line : acc + "\n" + line;
    if (estimateTokens(candidate) > COMPILED_CONTEXT_TOKEN_LIMIT) break;
    acc = candidate;
  }
  return acc;
}

// Same-kind + Jaccard(shared/union) >= 0.5 + remainder differs. Normalized
// exact-dupes are NOT flagged here (dedupe owns them). Returns candidate
// index -> conflicting approved id.
export function flagPossibleConflicts(
  cands: MemoryRow[],
  approved: MemoryRow[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < cands.length; i++) {
    const cSet = new Set(normalizeForMatch(cands[i].value));
    for (const a of approved) {
      if (a.kind !== cands[i].kind) continue;
      const aSet = new Set(normalizeForMatch(a.value));
      const shared = [...cSet].filter((t) => aSet.has(t)).length;
      const union = new Set([...cSet, ...aSet]).size;
      if (union === 0) continue;
      if (shared / union < 0.5) continue;
      const identical = cSet.size === aSet.size && [...cSet].every((t) => aSet.has(t));
      if (identical) continue;
      out.set(i, a.id);
      break;
    }
  }
  return out;
}
