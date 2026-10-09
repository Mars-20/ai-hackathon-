// ── Skills pipeline pure helpers (fully unit-tested) ────────────────────
// Testable core for the icp_sizing / investor_readiness integration:
// verdict gating, prompt-string constructors with caps, fail-soft model
// JSON parsing, and the trace slice-plus-append persistence rule.
import type { IcpProfile, InvestorScorecard, InvestorSignal, TraceEvent, Verdict } from "@/lib/types";

const VALID_VERDICTS = new Set<Verdict>(["go", "iterate", "stop", "test_more"]);

export function normalizeVerdict(v: unknown): Verdict | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return VALID_VERDICTS.has(t as Verdict) ? (t as Verdict) : null;
}

export function shouldRunInvestorReadiness(verdict: unknown): boolean {
  const n = normalizeVerdict(verdict);
  return n === "go" || n === "iterate";
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildIcpSummary(p: IcpProfile): string {
  return clip(
    `${p.role_title} in ${p.context}; pain: ${p.pain}; workaround: ${p.workaround}; SOM: ${p.som.value}`,
    300,
  );
}

export interface MarketNumbers {
  tam: { value: string; source_url?: string };
  sam: { value: string; source_note?: string };
  som: { value: string; basis?: string };
}

export function buildMarketCtx(m: MarketNumbers, icpOneLiner: string): string {
  // Defensive: synthesis may return partial objects (missing tam/sam/som);
  // degrade to the known parts instead of throwing (fail-soft, spec §3.2).
  const tam = m?.tam?.value ?? "";
  const sam = m?.sam?.value ?? "";
  const som = m?.som?.value ?? "";
  if (!tam && !sam && !som) return "";
  return clip(
    `TAM: ${tam}${m.tam?.source_url ? ` (${m.tam.source_url})` : ""}; ` +
      `SAM: ${sam}${m.sam?.source_note ? ` (${m.sam.source_note})` : ""}; ` +
      `SOM: ${som}${m.som?.basis ? ` (${m.som.basis})` : ""}; ICP: ${icpOneLiner}`,
    800,
  );
}

export function marketBlock(marketCtx: string): string {
  // Synthesis output is model text: mark it untrusted so downstream prompts
  // never render it as instructions (same pattern as route toUntrusted).
  return marketCtx ? `MARKET:\n<untrusted>${marketCtx}</untrusted>` : "";
}

export function fallbackIcpProfile(targetCustomer: string): IcpProfile {
  const t = targetCustomer.trim() || "unspecified customer";
  return {
    role_title: t, context: "unspecified", pain: "unspecified",
    workaround: "unspecified", buying_authority: "unknown",
    tam: { value: "unknown" }, sam: { value: "unknown" }, som: { value: "unknown" },
    preliminary: true,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Groq fallback commonly wraps JSON in ```json fences or prose: extract the
// payload with the same match used by route parseJsonSafely.
function extractJson(text: string): unknown {
  const raw = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? text;
  return JSON.parse(raw) as unknown;
}

export function parseIcpProfile(text: string): IcpProfile | null {
  try {
    const o = extractJson(text);
    if (!isRecord(o)) return null;
    for (const k of ["role_title", "context", "pain", "workaround", "buying_authority"])
      if (typeof o[k] !== "string") return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "unknown");
    const sub = (v: unknown): { value: string } => ({ value: str(isRecord(v) ? v.value : undefined) });
    return {
      role_title: o.role_title as string, context: o.context as string,
      pain: o.pain as string, workaround: o.workaround as string,
      buying_authority: o.buying_authority as string,
      tam: { value: str(isRecord(o.tam) ? o.tam.value : undefined), ...(isRecord(o.tam) && typeof o.tam.source_url === "string" ? { source_url: o.tam.source_url } : {}) },
      sam: { value: str(isRecord(o.sam) ? o.sam.value : undefined), ...(isRecord(o.sam) && typeof o.sam.source_note === "string" ? { source_note: o.sam.source_note } : {}) },
      som: { value: str(isRecord(o.som) ? o.som.value : undefined), ...(isRecord(o.som) && typeof o.som.basis === "string" ? { basis: o.som.basis } : {}) },
      preliminary: o.preliminary !== false,
    };
  } catch {
    return null;
  }
}

const SIGNAL_KEYS = new Set(["team", "market", "product", "business_model", "brand", "traction", "plan", "persuasion"]);
const FITS = new Set(["fundable", "not_yet", "unfit"]);

export function parseInvestorScorecard(text: string): InvestorScorecard | null {
  try {
    const o = extractJson(text);
    if (!isRecord(o) || !Array.isArray(o.signals)) return null;
    const signals: InvestorSignal[] = [];
    for (const s of o.signals) {
      if (!isRecord(s) || !SIGNAL_KEYS.has(s.key as string) || typeof s.note !== "string") continue;
      const n = Number(s.score_1_10);
      if (!Number.isFinite(n)) continue;
      signals.push({ key: s.key as InvestorSignal["key"], score_1_10: Math.min(10, Math.max(1, Math.round(n))), note: s.note });
    }
    if (signals.length === 0) return null;
    if (!FITS.has(o.verdict_fit as string) || !Array.isArray(o.top_gaps)) return null;
    const overall = Number(o.overall_1_10);
    return {
      signals,
      overall_1_10: Number.isFinite(overall) ? Math.min(10, Math.max(1, Math.round(overall))) : 5,
      verdict_fit: o.verdict_fit as InvestorScorecard["verdict_fit"],
      top_gaps: (o.top_gaps as unknown[]).filter((g): g is string => typeof g === "string").slice(0, 5),
    };
  } catch {
    return null;
  }
}

// ── Evidence grounding ──
export interface Groundable {
  evidence_type?: string | null;
  source_url?: string | null;
  source_type?: string | null;
  grounding_status?: string | null;
}

function isHttpUrlLocal(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const t = url.trim();
  return /^https?:\/\/\S/i.test(t);
}

export function isGroundedEvidence(e: Groundable): boolean {
  if (e.evidence_type === "primary") return true;
  const gs = e?.grounding_status;
  if (gs !== undefined && gs !== null && gs !== "grounded") return false;
  if (typeof e?.source_type !== "string" || e.source_type.trim().length === 0) return false;
  return isHttpUrlLocal(e?.source_url);
}

export function splitEvidenceByGrounding<T extends Groundable>(rows: T[]): { grounded: T[]; ungrounded: T[] } {
  const grounded: T[] = [];
  const ungrounded: T[] = [];
  for (const r of rows) {
    if (isGroundedEvidence(r)) grounded.push(r);
    else ungrounded.push(r);
  }
  return { grounded, ungrounded };
}

export function ungroundedCount<T extends Groundable>(rows: T[]): number {
  let n = 0;
  for (const r of rows) if (!isGroundedEvidence(r)) n += 1;
  return n;
}

export function claimHasNumericContent(claim: string): boolean {
  if (!claim) return false;
  const stripped = claim.replace(/\[[SAEDMW]\d+\]/g, "");
  if (!stripped.trim()) return false;
  return /[0-9٠-٩]|[%٪$]|million|billion|trillion|CAGR|مليار|مليون/i.test(stripped);
}

// Persist first-50 PLUS late investor rows (cap 55); investor rows win
// overflow slots; dedupe by id. Non-investor rows past 50 drop as today.
export function sliceTraceForPersist(trace: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>();
  const persisted = trace.slice(0, 50).filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  for (const t of trace.slice(50)) {
    if (persisted.length >= 55) break;
    if (t.actor !== "skill:investor-readiness") continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    persisted.push(t);
  }
  return persisted;
}
