# Skills–Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 5 methodology playbooks into the live agent memo pipeline with 5 prompt upgrades, a rebuilt market-research phase, 2 new phases (`icp_sizing` always, `investor_readiness` gated), frontend display, and full verification — zero deferrals, zero debt.

**Architecture:** Pure helpers go in a new testable lib module; skill prompts and executor wiring change inside the existing `route.ts` pipeline; SSE/type/frontend contracts extend additively; both new phases are fail-soft with timeout/budget carve-out.

**Tech Stack:** Next.js App Router (TS), SSE streaming, Zod-shaped `SchemaType` prompts via `callAIWithFallback`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-skills-pipeline-integration-design.md` — read it with this plan; the plan argues from it.

## Global Constraints

- English code/prompts; UI labels English to match neighboring cards.
- No DB migration; no new tables; `trace_events` CHECK allow-list already covers `skill_start`/`skill_end`.
- 90s global deadline (`BUDGET.HARD_TIMEOUT_MS`) unchanged; `MAX_TOOL_CALLS:15` unchanged.
- New optional params are appended LAST (after `companionCtx`) — never insert positionally.
- Timeouts/budget errors always propagate; only provider/model/parse errors are fail-soft.
- Windows shell: vitest via `node node_modules/vitest/vitest.mjs run`, tsc via `node node_modules/typescript/bin/tsc --noEmit` from `apps/web`, builds via `npm.cmd run build`, e2e via `node node_modules/@playwright/test/cli.js test`. Never pipe `next build` through `Select-Object -First`. Rebuild `.next` before any e2e (the dev `webServer` serves `next start`).
- Never commit secrets; stage only intended files.

## Review Focus

1. Verdict casing/whitespace (`"Go "`, `"GO"`) must skip-or-run correctly, not crash the gate → pinned in Task 2 (`normalizeVerdict` matrix test).
2. Malformed model JSON for icp/investor must yield fallback/skip, never throw → pinned in Task 2 (`parseIcpProfile`/`parseInvestorScorecard` tests).
3. Empty `marketCtx` (synthesis failed) must omit the memo `MARKET:` block cleanly → pinned in Task 2 (`marketBlock` test) and Task 5 (uses the helper, no inline conditional).
4. Trace overflow past 55 rows must keep investor rows and drop others deterministically → pinned in Task 2 (60-row fixture test).
5. Skip path must emit NO `phase: investor_readiness` frame, only the skip `tool_result` + `done` → pinned in Task 9 (live stream assertion on a `stop` run).

---

## File map

- Modify `apps/web/src/lib/types.ts` — add `IcpProfile`, `InvestorSignal`, `InvestorScorecard`; extend `SessionPhase`, `AgentOutput`, `SessionState`.
- Create `apps/web/src/lib/skills-helpers.ts` — pure, fully unit-tested: `normalizeVerdict`, `shouldRunInvestorReadiness`, `buildIcpSummary` (≤300), `buildMarketCtx` (≤800), `marketBlock`, `fallbackIcpProfile`, `parseIcpProfile`, `parseInvestorScorecard`, `sliceTraceForPersist` (cap 55).
- Create `apps/web/src/lib/__tests__/skills-helpers.test.ts` — gate matrix, constructors/caps, parsers, slice fixtures.
- Modify `apps/web/src/app/api/agent/route.ts` — `runIcpSizingSkill` (new), research rebuild, 4 prompt injections + memo `MARKET` + leads `icpSummary`, `runInvestorReadinessSkill` (new) + executor wiring + skip path + slice-plus-append.
- Modify `apps/web/src/app/validate/page.tsx` — state, SSE data type, 2 cases, `done` hydration, indicator entries, 2 cards.
- Add (untracked → tracked) `packages/skills/{startup-methodology,icp-market-sizing,experiment-design-coach,evidence-quality-coach,investor-pitch-coach}/` — committed in Task 8.

---

### Task 1: Type surface

**Files:**
- Modify: `apps/web/src/lib/types.ts` (append after `Decision` interface ~:170; extend `AgentOutput` :212-220, `SessionState` :262-279, `SessionPhase` :249-260)
- Test: `node node_modules/typescript/bin/tsc --noEmit` from `apps/web`

**Interfaces:**
- Consumes: existing `Assumption`, `Evidence`, `Experiment`, `Decision`, `TraceEvent` types.
- Produces: `IcpProfile`, `InvestorSignal`, `InvestorScorecard` (imported by route.ts, page.tsx, skills-helpers.ts).

- [ ] **Step 1: Add the new interfaces after `Decision`**

```ts
// ── ICP & market sizing (skill:icp-sizing) ──────────────────────────────
export interface IcpProfile {
  role_title: string;
  context: string;
  pain: string;
  workaround: string;
  buying_authority: string;
  tam: { value: string; source_url?: string };
  sam: { value: string; source_note?: string };
  som: { value: string; basis?: string };
  preliminary: boolean; // true until research synthesis confirms numbers
}

// ── Investor readiness (skill:investor-readiness) ───────────────────────
export type InvestorSignalKey =
  | "team" | "market" | "product" | "business_model"
  | "brand" | "traction" | "plan" | "persuasion";
export interface InvestorSignal {
  key: InvestorSignalKey;
  score_1_10: number;
  note: string;
}
export interface InvestorScorecard {
  signals: InvestorSignal[];
  overall_1_10: number;
  verdict_fit: "fundable" | "not_yet" | "unfit";
  top_gaps: string[];
}
```

- [ ] **Step 2: Extend `SessionPhase`, `AgentOutput`, `SessionState`**

```ts
export type SessionPhase =
  | "idle"
  | "intake"
  | "mapping"
  | "icp_sizing"        // NEW
  | "research"
  | "experiment"
  | "leads"
  | "evidence"
  | "verifying"
  | "memo"
  | "investor_readiness" // NEW
  | "done"
  | "error";
```

```ts
export interface AgentOutput {
  startup: Startup;
  assumptions: Assumption[];
  evidence: Evidence[];
  experiment?: Experiment;
  decision?: Decision;
  icp_profile: IcpProfile | null;                 // NEW
  investor_scorecard: InvestorScorecard | null;   // NEW
  trace: TraceEvent[];
  error?: string;
}
```

```ts
export interface SessionState {
  phase: SessionPhase;
  user?: AuthUser;
  workspace?: Workspace;
  memberRole?: MemberRole;
  startup?: Startup;
  assumptions: Assumption[];
  evidence: Evidence[];
  experiment?: Experiment;
  decision?: Decision;
  icp_profile?: IcpProfile | null;                // NEW
  investor_scorecard?: InvestorScorecard | null;  // NEW
  trace: TraceEvent[];
  isLoading: boolean;
  error?: string;
  budget_used_usd: number;
  tool_calls_used: number;
}
```

- [ ] **Step 3: Run tsc, expect clean**

Run: `node node_modules/typescript/bin/tsc --noEmit` from `apps/web`
Expected: no output (clean). `route.ts`/`page.tsx` don't reference the new fields yet, so nothing else breaks.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/types.ts
git commit -m "feat(skills): IcpProfile/InvestorScorecard types + SessionPhase/AgentOutput/SessionState extensions"
```

---

### Task 2: Pure helpers + full unit tests (TDD)

**Files:**
- Create: `apps/web/src/lib/skills-helpers.ts`
- Create: `apps/web/src/lib/__tests__/skills-helpers.test.ts` (precedent: `src/lib/__tests__/progress-tracks.test.ts`)
- Test: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/skills-helpers.test.ts` from `apps/web`

**Interfaces:**
- Consumes: `IcpProfile`, `InvestorScorecard`, `Verdict`, `TraceEvent` from `@/lib/types`.
- Produces (imported by route.ts Tasks 3–6): `normalizeVerdict`, `shouldRunInvestorReadiness`, `buildIcpSummary`, `buildMarketCtx`, `marketBlock`, `fallbackIcpProfile`, `parseIcpProfile`, `parseInvestorScorecard`, `sliceTraceForPersist`.

- [ ] **Step 1: Write the failing test file** (entire file — 9 suites; shown condensed, write all asserts):

```ts
import { describe, test, expect } from "vitest";
import {
  normalizeVerdict,
  shouldRunInvestorReadiness,
  buildIcpSummary,
  buildMarketCtx,
  marketBlock,
  fallbackIcpProfile,
  parseIcpProfile,
  parseInvestorScorecard,
  sliceTraceForPersist,
} from "@/lib/skills-helpers";
import type { IcpProfile, TraceEvent } from "@/lib/types";

const ICP: IcpProfile = {
  role_title: "Head of Operations",
  context: "Series A Egyptian B2B SaaS, 50-500 staff",
  pain: "client feedback scattered across WhatsApp",
  workaround: "Excel + WhatsApp",
  buying_authority: "owns a tools budget",
  tam: { value: "$2.1B MENA ops software" },
  sam: { value: "2,340 Egyptian firms" },
  som: { value: "234 firms Y1", basis: "10% outreach capacity" },
  preliminary: true,
};

describe("normalizeVerdict", () => {
  test.each([
    ["go", "go"], ["Go", "go"], [" GO ", "go"], ["iterate", "iterate"],
    ["STOP", "stop"], ["test_more", "test_more"], ["Test More", null],
    ["", null], [null, null], [undefined, null], [42, null],
  ])("normalizeVerdict(%j) → %j", (input, expected) => {
    expect(normalizeVerdict(input)).toBe(expected);
  });
});

describe("shouldRunInvestorReadiness", () => {
  test.each([["go", true], ["Go", true], ["iterate", true], ["stop", false], ["test_more", false], ["garbage", false], [null, false]])(
    "%j → %j", (v, expected) => expect(shouldRunInvestorReadiness(v)).toBe(expected),
  );
});

describe("builders + caps", () => {
  test("buildIcpSummary ≤300 chars and contains role + SOM", () => {
    const s = buildIcpSummary(ICP);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain("Head of Operations");
    expect(s).toContain("234 firms Y1");
  });
  test("buildMarketCtx ≤800 chars, synthesis-only", () => {
    const m = buildMarketCtx(
      { tam: ICP.tam, sam: ICP.sam, som: ICP.som },
      "ops heads in Egyptian SaaS",
    );
    expect(m.length).toBeLessThanOrEqual(800);
    expect(m).toContain("$2.1B");
  });
  test("marketBlock empty → empty; non-empty → MARKET block", () => {
    expect(marketBlock("")).toBe("");
    expect(marketBlock("TAM: $2.1B")).toContain("MARKET:");
  });
});

describe("parsers are fail-soft", () => {
  test("parseIcpProfile valid → profile; garbage → null", () => {
    expect(parseIcpProfile(JSON.stringify({ ...ICP, extra: 1 }))?.role_title).toBe("Head of Operations");
    expect(parseIcpProfile("not json{{")).toBeNull();
    expect(parseIcpProfile(JSON.stringify({ role_title: 42 }))).toBeNull();
  });
  test("parseInvestorScorecard clamps + whitelists", () => {
    const good = parseInvestorScorecard(JSON.stringify({
      signals: [{ key: "team", score_1_10: 99, note: "strong" }, { key: "bogus", score_1_10: 5, note: "x" }],
      overall_1_10: -3, verdict_fit: "fundable", top_gaps: ["traction"],
    }));
    expect(good?.signals).toHaveLength(1);
    expect(good?.signals[0].score_1_10).toBe(10);
    expect(good?.overall_1_10).toBe(1);
    expect(parseInvestorScorecard("{{bad")).toBeNull();
    expect(parseInvestorScorecard(JSON.stringify({ verdict_fit: "maybe" }))).toBeNull();
  });
});

describe("sliceTraceForPersist", () => {
  const row = (id: string, actor: string): TraceEvent =>
    ({ id, actor, event_type: "tool_result", payload: {}, created_at: new Date().toISOString() }) as TraceEvent;
  test("60-row fixture keeps investor rows, caps at 55, dedupes", () => {
    const trace = Array.from({ length: 57 }, (_, i) => row(`r${i}`, "executor"));
    trace.push(row("inv1", "skill:investor-readiness"), row("inv2", "skill:investor-readiness"), row("r5", "executor"));
    const out = sliceTraceForPersist(trace);
    expect(out.length).toBeLessThanOrEqual(55);
    expect(out.map((t) => t.id)).toContain("inv1");
    expect(out.map((t) => t.id)).toContain("inv2");
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });
  test("short traces pass through untouched", () => {
    const trace = [row("a", "router")];
    expect(sliceTraceForPersist(trace)).toEqual(trace);
  });
});
```

- [ ] **Step 2: Run it, expect failure (module missing)**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/skills-helpers.test.ts` from `apps/web`
Expected: FAIL — `Failed to resolve import "@/lib/skills-helpers"`.

- [ ] **Step 3: Write the minimal implementation** (`apps/web/src/lib/skills-helpers.ts`):

```ts
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
  if (!m.tam.value && !m.sam.value && !m.som.value) return "";
  return clip(
    `TAM: ${m.tam.value}${m.tam.source_url ? ` (${m.tam.source_url})` : ""}; ` +
      `SAM: ${m.sam.value}${m.sam.source_note ? ` (${m.sam.source_note})` : ""}; ` +
      `SOM: ${m.som.value}${m.som.basis ? ` (${m.som.basis})` : ""}; ICP: ${icpOneLiner}`,
    800,
  );
}

export function marketBlock(marketCtx: string): string {
  return marketCtx ? `MARKET:\n${marketCtx}` : "";
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

export function parseIcpProfile(text: string): IcpProfile | null {
  try {
    const o = JSON.parse(text) as unknown;
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
    const o = JSON.parse(text) as unknown;
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
```

- [ ] **Step 4: Run tests, expect all green + tsc clean**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/skills-helpers.test.ts` from `apps/web`
Expected: `Test Files 1 passed`, `Tests 20 passed` (test.each rows count individually).
Then: `node node_modules/typescript/bin/tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/skills-helpers.ts apps/web/src/lib/__tests__/skills-helpers.test.ts
git commit -m "feat(skills): testable helpers (verdict gate, constructors, parsers, trace slice)"
```

---

### Task 3: `runIcpSizingSkill` + executor wiring

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` — new `runIcpSizingSkill` after `runAssumptionMappingSkill` (:1026); executor insert between mapping end (:2183) and research start (:2185)
- Test: tsc + full unit suite (no regressions). No new route-level unit test: the AI-call boundary needs provider mocks the repo doesn't have; logic is covered by Task 2 + live spot-check (Task 9). This is deliberate, not a gap.

**Interfaces:**
- Consumes: `callAIWithFallback`, `composePrompt`, `parseJsonSafely`, `IcpProfile`, `buildIcpSummary`, `fallbackIcpProfile`, `parseIcpProfile`.
- Produces: `IcpProfile` → executor builds `icpSummary` (≤300) for research/experiment/memo/investor; refines in-memory `startup.target_customer` (one-line ≤500 per `UNTRUSTED_FIELD_CHARS`).

- [ ] **Step 1: Add the skill function** (after `runAssumptionMappingSkill`, mirroring its structure):

```ts
// ── ICP & Market Sizing (skill:icp-sizing — synthesis, no web tools) ────
// Always runs, right after mapping: its output grounds research + leads.
// Fail-soft on provider/model/parse errors (fallback profile + warning
// trace); timeout/budget errors propagate.
async function runIcpSizingSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = ""
): Promise<IcpProfile> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:icp-sizing", "skill_start", { startup_id: startup.id }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      role_title: { type: SchemaType.STRING },
      context: { type: SchemaType.STRING },
      pain: { type: SchemaType.STRING },
      workaround: { type: SchemaType.STRING },
      buying_authority: { type: SchemaType.STRING },
      tam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
      sam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
      som: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
    },
    required: ["role_title", "context", "pain", "workaround", "buying_authority", "tam", "sam", "som"],
  };

  const prompt = `Define the Ideal Customer Profile and preliminary market size for this startup.

STARTUP:
- Name: ${toUntrusted(sanitizeStartupField(startup.name))}
- Idea: ${toUntrusted(sanitizeStartupField(startup.one_liner))}
- Domain: ${toUntrusted(sanitizeStartupField(startup.domain))}
- Stated customer: ${toUntrusted(sanitizeStartupField(startup.target_customer || "not specified"))}
- Riskiest assumption: ${toUntrusted(truncateField(assumptions[0]?.statement ?? "", 300))}

RULES (icp-market-sizing):
- ICP is valid ONLY with all five dimensions: precise role/title (never "business owners"), company context (size/geo/stack), hair-on-fire pain, current workaround, buying authority.
- Specificity test: the description must single out ~5-10 people in a crowd of 1000, not "most of the room".
- TAM/SAM/SOM are PRELIMINARY estimates (research confirms them later): TAM = category demand at 100% share; SAM = reachable given channels/geography/language; SOM = SAM x realistic Y1 conversion from stated GTM capacity. Never present TAM as the relevant market.
- B2C: ICP and persona collapse into one (the individual consumer).

Return ONLY the profile as JSON (preliminary is set by code, not the model).`;

  let profile: IcpProfile;
  try {
    const rawText = await callAIWithFallback({
      prompt: composePrompt(prompt, companionCtx),
      systemPrompt: "You are the icp-sizing skill for a Validation Copilot. Respond ONLY with valid JSON.",
      responseSchema: schema,
      trace,
      skillName: "icp-sizing",
      usageAcc,
    });
    const parsed = parseIcpProfile(rawText);
    if (!parsed) throw new Error("icp-sizing returned unparseable JSON");
    profile = parsed;
  } catch (err) {
    if (isBudgetError(err)) throw err; // timeout/budget carve-out: abort, never limp on
    trace.push(makeTrace("skill:icp-sizing", "verification", {
      warning: "icp_fallback", detail: err instanceof Error ? err.message : String(err),
    }));
    profile = fallbackIcpProfile(startup.target_customer || "");
  }

  const latency = Date.now() - t0;
  trace.push(makeTrace("skill:icp-sizing", "skill_end", { preliminary: profile.preliminary }, { latency_ms: latency }));
  return profile;
}
```

(`isBudgetError`: add a tiny local predicate — `const isBudgetError = (e: unknown) => e instanceof Error && /Budget: hard timeout|429/.test(e.message);` — place beside `BUDGET` helpers. The timeout message is `"Budget: hard timeout 90s exceeded"` (route.ts:2102); budget throws carry status 429. If no clean discriminator exists at the call site, catch and re-check via `checkTimeout()` + `assertPhaseBudget()` state instead — executor does both right after anyway.)

- [ ] **Step 2: Wire the executor** (between mapping `skill_end` and the research `phase` send):

```ts
// ── Phase 2b: ICP & Market Sizing (always runs) ────────────────────
await send({ type: "phase", phase: "icp_sizing", trace: [...trace] });
const icpUsage: AiUsage[] = [];
const icpProfile = await runIcpSizingSkill(startup, assumptions, trace, icpUsage, companionCtx);
toolCalls++;
totalCost += costFromUsage(icpUsage, "gemini_call");
checkTimeout();
assertPhaseBudget(totalCost, toolCalls);
const icpSummary = buildIcpSummary(icpProfile);
startup.target_customer = truncateField(icpSummary, 500); // flattened, persisted later
await send({ type: "icp_profile", icp_profile: icpProfile, trace: [...trace] });
```

(Cost-label: match the existing convention — check what string siblings pass to `costFromUsage` (`"groq_call"` at router, `"gemini_call"` elsewhere) and use the same fallback label; do NOT invent a new pricing key.)

- [ ] **Step 3: tsc + full unit suite green**

Run: `node node_modules/typescript/bin/tsc --noEmit`, then `node node_modules/vitest/vitest.mjs run` from `apps/web`.
Expected: clean tsc; all files pass (new tests from Task 2 included).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/agent/route.ts
git commit -m "feat(skills): icp_sizing phase (always-on, fail-soft, grounds research)"
```

---

### Task 4: Market-research rebuild (query shaping + synthesis)

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` — `runMarketResearchSkill` (:1029): add trailing `icpSummary: string = ""` param; shape the 3 queries; append synthesis `callAIWithFallback`; emit `MarketSizing` via `skill_end` + `market_sizing` tool_result trace. Executor: pass `icpSummary`, change research accounting to `toolCalls += 4`.

**Interfaces:**
- Consumes: `icpSummary` (Task 3).
- Produces: `MarketSizing` object on the trace → executor builds `marketCtx` via `buildMarketCtx` (Task 2).

- [ ] **Step 1: Shape the queries** (replace :1039-1043):

```ts
const icpHint = icpSummary ? ` ${truncateField(icpSummary, 120)}` : "";
const queries = [
  `${truncateField(sanitizeStartupField(startup.domain), 100)} market size and growth rate 2024 2025${icpHint} TAM SAM SOM`,
  `${truncateField(sanitizeStartupField(startup.one_liner), 100)} competitors pricing${icpHint}`,
  `${truncateField(criticalAssumption?.statement ?? "", 100)} evidence data`,
].filter(Boolean);
```

- [ ] **Step 2: Append the synthesis step** (before `skill_end` at :1121):

```ts
// Synthesis: grounded TAM/SAM/SOM + competitor landscape (icp-market-sizing).
// Numbers must cite tool-returned URLs; ungrounded numbers are dropped.
let marketSizing: MarketNumbers | null = null;
try {
  const synthSchema = {
    type: SchemaType.OBJECT,
    properties: {
      tam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, source_url: { type: SchemaType.STRING } } },
      sam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, source_note: { type: SchemaType.STRING } } },
      som: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, basis: { type: SchemaType.STRING } } },
      competitors: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ["tam", "sam", "som", "competitors"],
  };
  const synthPrompt = `Summarize the closeable market from these tool results (URLs are tool-grounded; invent none).
ICP: ${toUntrusted(icpSummary || "not specified")}
RESULTS:
${toUntrusted(allResults.slice(0, 12).map((r) => `- [${r.source_type}] ${r.claim}${r.source_url ? ` (${r.source_url})` : ""}`).join("\n"))}
Rules: anchor on SOM, never present TAM as the relevant market; drop any number without a cited URL.`;
  const synthText = await callAIWithFallback({
    prompt: composePrompt(synthPrompt, ""),
    systemPrompt: "You are the market-sizing synthesizer for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: synthSchema,
    trace,
    skillName: "market-sizing",
    usageAcc,
  });
  const parsed = parseJsonSafely<MarketNumbers & { competitors?: string[] }>(synthText, null);
  if (parsed && (parsed.tam?.value || parsed.sam?.value || parsed.som?.value)) {
    marketSizing = { tam: parsed.tam, sam: parsed.sam, som: parsed.som };
    trace.push(makeTrace("tool", "tool_result", { market_sizing: marketSizing, competitors: (parsed.competitors ?? []).slice(0, 8) }));
  } else {
    trace.push(makeTrace("skill:market-research", "verification", { warning: "synthesis_unparseable" }));
  }
} catch (err) {
  if (isBudgetError(err)) throw err;
  trace.push(makeTrace("skill:market-research", "verification", { warning: "synthesis_failed" }));
}
```

(`parseJsonSafely` is the existing helper used at :997 — same call shape. `MarketNumbers` type: import from `@/lib/skills-helpers`.)

- [ ] **Step 3: Executor — pass `icpSummary`, account `+= 4`, build `marketCtx`**

At the research call site: `runMarketResearchSkill(startup, assumptions, trace, usageAcc, icpSummary)`; change its `toolCalls += 3` (:2190) to `toolCalls += 4`; after the call, read the trace for the latest `market_sizing` payload (search `trace` backwards for `payload.market_sizing`) and set `const marketCtx = marketSizing ? buildMarketCtx(marketSizing, icp one-liner) : "";` where the one-liner is `truncateField(icpSummary, 120)`.

- [ ] **Step 4: tsc + unit suite green, then commit**

```bash
git add apps/web/src/app/api/agent/route.ts
git commit -m "feat(skills): market-research ICP shaping + grounded synthesis"
```

---

### Task 5: The 4 prompt injections + memo MARKET + leads param

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` — assumption (:959-985), experiment (:~1275 prompt + :1228 signature), analyzer, memo (:1521-1541 + :1483 signature), leads (:1138 signature).

**Interfaces:**
- Consumes: `icpSummary`, `marketCtx`, `marketBlock` (Tasks 2–4).
- Produces: richer prompts; no behavior change when strings are empty (guard: existing runs without ICP data behave as today).

- [ ] **Step 1: Assumption prompt** — append before `Return assumptions sorted…`:

```
HYPOTHESIS FORMAT (startup-methodology): phrase every statement as
"We believe [customer segment] has [problem]. We will test this by
[specific method]. We will know we are right if [measurable signal]
within [timeframe]." Never let a vague problem statement pass: if the
problem, ICP, or workaround is unspecified, emit a critical desirability
assumption demanding Problem Formulation first.
```

- [ ] **Step 2: Experiment skill** — signature gains trailing `icpSummary: string = ""`; prompt gains `ICP: ${...}` line + ladder block:

```
EXPERIMENT LADDER (experiment-design-coach — cheapest first):
Tier 1 conversation ($0, hours) → Tier 2 signal test ($0-100, days) →
Tier 3 concierge/Wizard-of-Oz ($50-500, weeks) → Tier 4 prototype
($500+, weeks). NEVER recommend Tier 4+ before exhausting Tiers 1-3.
Match type to assumption: desirability/existence → interviews (n≥15);
usage → concierge/WoZ (n≥10); willingness-to-pay → pre-order/pricing
(n≥5); price level → Van Westendorp (n≥20); feasibility → spike/PoC.
```

- [ ] **Step 3: Analyzer prompt** — append Mom-Test + Bayesian block:

```
EVIDENCE GRADING (evidence-quality-coach): classify every item on the
commitment ladder — Rung 1 opinion, 2 stated intent, 3 time given,
4 contact shared, 5 money/commitment. Bayesian weights: Rung 5 confirm
5.0x; Rung 3-4 confirm 2.0x / contradict 0.3x; Rung 1-2 = noise either
way. One Rung 5 contradiction wipes out ten Rung 1 compliments. Mom-Test
rules: their life not your idea; past specifics not hypotheticals;
compliments are not data (Rung 1); dig into bad news — hesitation is the
most valuable signal.
```

- [ ] **Step 4: Memo `MARKET:` block** — signature gains trailing `marketCtx: string = ""`; insert `${marketBlock(marketCtx)}` directly after the `EVIDENCE` block, before `THRESHOLD CHECK`. Use the `marketBlock` helper (Task 2) — no inline conditional. Append investor lens to the `Produce:` list:

```
- investor_lens: 1-line note on the strongest of the 8 readiness signals
  (team 30 / market 25 / product 20 / business_model 10 / brand 5 /
  traction 5 / plan 3 / persuasion 2) this evidence supports
```

- [ ] **Step 5: Leads `icpSummary`** — signature `runLeadFinderSkill(startup, trace, icpSummary: string = "")`; when non-empty it shapes Apollo titles/geo, else current `target_customer` behavior. Executor passes `icpSummary`.

- [ ] **Step 6: tsc + unit suite green, then commit**

```bash
git add apps/web/src/app/api/agent/route.ts
git commit -m "feat(skills): methodology prompt injections + MARKET block + leads ICP"
```

---

### Task 6: Investor skill + gate + trace persistence rule

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` — new `runInvestorReadinessSkill` (after memo skill); executor insert between memo end (:2276) and persist (:2278); persist slice → `sliceTraceForPersist(trace)`; `done` payload gains `icp_profile` + `investor_scorecard`.

**Interfaces:**
- Consumes: `decision`, `marketCtx`, `shouldRunInvestorReadiness`, `parseInvestorScorecard`, `sliceTraceForPersist`.
- Produces: `InvestorScorecard | null` → SSE frame or skip trace; persisted trace; extended `done`.

- [ ] **Step 1: Add the skill** (schema: signals[8 fixed keys, score, note], overall_1_10, verdict_fit enum, top_gaps; prompt embeds the 8 signals with weights + the correct-market-framing rule + `MARKET:` block from `marketCtx` + decision verdict/rationale; returns `parseInvestorScorecard(rawText)`; throws on unparseable (executor treats as fail-soft), budget errors propagate via `isBudgetError`).

- [ ] **Step 2: Executor wiring** (exactly this shape — null-branch sends NO phase frame):

```ts
// ── Phase 8b: Investor Readiness (gated: go/iterate only) ───────────
let investorScorecard: InvestorScorecard | null = null;
if (shouldRunInvestorReadiness(decision.verdict)) {
  await send({ type: "phase", phase: "investor_readiness", trace: [...trace] });
  try {
    const invUsage: AiUsage[] = [];
    investorScorecard = await runInvestorReadinessSkill(startup, decision, marketCtx, trace, invUsage, companionCtx);
    toolCalls++;
    totalCost += costFromUsage(invUsage, "gemini_call");
    checkTimeout();
    assertPhaseBudget(totalCost, toolCalls);
  } catch (err) {
    if (isBudgetError(err)) throw err; // budget gate stays alive
    trace.push(makeTrace("executor", "tool_result", { investor_readiness: "failed_soft", detail: err instanceof Error ? err.message : String(err) }));
    investorScorecard = null;
  }
} else {
  trace.push(makeTrace("executor", "tool_result", { investor_readiness: "skipped", reason: `verdict=${String(decision.verdict)}` }));
}
if (investorScorecard) {
  await send({ type: "investor_scorecard", investor_scorecard: investorScorecard, trace: [...trace] });
}
```

- [ ] **Step 3: Persist rule + `done` payload** — replace `trace.slice(0, 50)` (:2377) with `sliceTraceForPersist(trace)` (import from `@/lib/skills-helpers`); add `icp_profile: icpProfile ?? null, investor_scorecard: investorScorecard` to the `done` send (:2402-2419).

- [ ] **Step 4: tsc + unit suite green, then commit**

```bash
git add apps/web/src/app/api/agent/route.ts
git commit -m "feat(skills): gated investor_readiness + trace slice-plus-append + done payload"
```

---

### Task 7: Frontend — state, cases, cards, indicator

**Files:**
- Modify: `apps/web/src/app/validate/page.tsx` — imports (`IcpProfile`, `InvestorScorecard` types), state (:497-508 area), SSE data type (:726-744), switch cases (:746-808), `done` hydration (:781-801), `PhaseIndicator` (:60-69), 2 cards beside `EvidenceCard` (:241) / `DecisionMemoPanel` (:421).

- [ ] **Step 1: State + data type**

```tsx
const [icpProfile, setIcpProfile] = useState<IcpProfile | null>(null);
const [scorecard, setScorecard] = useState<InvestorScorecard | null>(null);
```

```ts
icp_profile?: IcpProfile;
investor_scorecard?: InvestorScorecard;
```

(add both lines to the `data` type next to `decision?: Decision;`)

- [ ] **Step 2: Switch cases** (after the `"leads"` case, before `"done"`):

```tsx
case "icp_profile":
  if (data.icp_profile) setIcpProfile(data.icp_profile);
  if (data.trace) setTrace([...data.trace]);
  break;
case "investor_scorecard":
  if (data.investor_scorecard) setScorecard(data.investor_scorecard);
  if (data.trace) setTrace([...data.trace]);
  break;
```

- [ ] **Step 3: `done` hydration** (inside `case "done"`, after `setDecision`):

```tsx
if (data.icp_profile) setIcpProfile(data.icp_profile);
if (data.investor_scorecard) setScorecard(data.investor_scorecard);
```

- [ ] **Step 4: Indicator entries** (pipeline order):

```tsx
{ id: "mapping", label: "Mapping", icon: <Target className="w-3.5 h-3.5" /> },
{ id: "icp_sizing", label: "ICP & Market", icon: <Globe className="w-3.5 h-3.5" /> },
...
{ id: "memo", label: "Decision", icon: <LineChart className="w-3.5 h-3.5" /> },
{ id: "investor_readiness", label: "Investor Ready", icon: <TrendingUp className="w-3.5 h-3.5" /> },
```

- [ ] **Step 5: Cards** — `IcpProfileCard({ profile }: { profile: IcpProfile })` rendering 5 dimension rows + TAM/SAM/SOM (with `preliminary` badge when true), placed in the results flow next to `EvidenceCard`; `InvestorScorecardCard({ scorecard }: { scorecard: InvestorScorecard })` rendering 8 signal rows (key, score/10, note) + overall + `verdict_fit` + `top_gaps`, placed next to `DecisionMemoPanel`. English copy, same card/chip classes as neighbors (`cn`, `STRENGTH_COLOR`-style conventions — mirror `EvidenceCard` markup, don't invent new styles). Render each only when its state is non-null.

- [ ] **Step 6: tsc clean, then commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` from `apps/web` — must be clean (`setPhase(data.phase)` now accepts the new values).

```bash
git add apps/web/src/app/validate/page.tsx
git commit -m "feat(skills): ICP + investor SSE display (cases, cards, indicator)"
```

---

### Task 8: Playbooks, battery, commit

**Files:**
- Add: `packages/skills/{startup-methodology,icp-market-sizing,experiment-design-coach,evidence-quality-coach,investor-pitch-coach}/` (currently untracked — the methodology source).
- Test: full battery.

- [ ] **Step 1: Confirm no-migration precondition** — `supabase/migrations/` contains `20240101000011_companion_memory.sql` and `20240101000013_companion_check_discovery.sql` (loop-3 verified). Base `skill_start`/`skill_end` are in the unified-schema CHECK, so the two new `skill:*` actors persist with no migration regardless.

- [ ] **Step 2: Stage playbooks + run the battery in order, all must pass**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node eval/harness/runner.mjs
node --test eval/harness/meta.test.mjs
node eval/assistant/run.mjs
npm.cmd run build
```

then (after rebuild):

```bash
$env:ASSISTANT_OPEN_CHAT='true'
node node_modules/@playwright/test/cli.js test e2e/project-progress.spec.ts e2e/smoke.spec.ts --reporter=line
```

(`e2e/trial-paywall` stays deferred until the documented Gemini saturation clears — Task 9.)

- [ ] **Step 3: Commit the playbooks with the work**

```bash
git add packages/skills/startup-methodology packages/skills/icp-market-sizing packages/skills/experiment-design-coach packages/skills/evidence-quality-coach packages/skills/investor-pitch-coach
git commit -m "feat(skills): methodology playbooks backing pipeline integration"
```

---

### Task 9: Live spot-check, push, verify (closes the loop)

- [ ] **Step 1: Live memo spot-check** — run one `/api/agent` memo with `uploaded_data` (exercises the investor RUN path, audit I2) and one without (skip path). Assert: run path stream contains `phase: icp_sizing`, `icp_profile`, `phase: investor_readiness`, `investor_scorecard`, `done`; skip path contains the skip `tool_result` and NO `phase: investor_readiness` frame (Review Focus #5). If Gemini saturation persists, this step waits — do NOT force-merge blind; the code is complete, verification pending an external constraint.

- [ ] **Step 2: Re-run `e2e/trial-paywall`** once providers recover; journeys must show the new phases in-frame with `done` intact.

- [ ] **Step 3: Push + live verify**

```bash
git push origin main
```

then homepage 200 via webfetch + `GET /api/startups/[id]/stage` 401 as before.

---

## Self-review (run against the spec, fixed inline while writing)

1. **Spec coverage:** §2 order/gates → Tasks 3+6 (+ Task 9 assertions). §3 items 1–8 → Tasks 3/4/5/6 (item ordering preserved; leads param in Task 5 Step 5). §4 SSE/trace/frontend → Tasks 6 (send sites, null-branch) + 7 (all frontend). §5 persistence/budget → Tasks 3 (refine), 4 (producer), 6 (slice, done), 2 (constructors/caps). §6 battery → Task 8 (+ Task 9 live). §7 rejected alternatives need no tasks.
2. **Placeholders:** none — every code step ships exact code; the only documented non-unit-test (Task 3 route skill) names its covers (Task 2 + Task 9).
3. **Type consistency:** `IcpProfile`/`InvestorScorecard` field names identical across Tasks 1/2/3/4/6/7; `MarketNumbers` defined once (Task 2) and imported in Task 4; helper names identical everywhere (`buildIcpSummary`, `buildMarketCtx`, `marketBlock`, `sliceTraceForPersist`, `shouldRunInvestorReadiness`, `parseIcpProfile`, `parseInvestorScorecard`, `fallbackIcpProfile`, `normalizeVerdict`).
4. **Review Focus:** all 5 lines carry a pinned test above.
