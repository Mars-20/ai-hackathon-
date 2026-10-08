# Skills → Agent Pipeline Integration — Design

Date: 2026-10-08. Status: approved section-by-section (5/5) by human partner.
Directive: zero deferrals, zero tech debt — Path 1 (prompt injection) AND
Path 2 (new SSE phases) ship together in one change.

## 1. Intent

Bind the 5 methodology playbooks on disk
(`packages/skills/{startup-methodology,icp-market-sizing,experiment-design-coach,evidence-quality-coach,investor-pitch-coach}/playbook.md`,
currently untracked) into the live memo pipeline
(`apps/web/src/app/api/agent/route.ts`), which today runs 8 phases on
short inline prompts:
`intake → mapping → research → experiment → leads → evidence → verifying → memo`.

Success: every memo run reasons with the full methodology (testable
hypotheses, 5-dimension ICP, cheapest-first experiments, Mom-Test
evidence grading, 8-signal investor lens), with two new observable
phases and no leftover TODOs, no untracked files, no schema drift.

## 2. Professional sequence (researched)

Sources: Lean Startup (Build-Measure-Learn, validation before building),
Lean Canvas (Problem + Customer Segments are block 1), Steve Blank
(market definition is the front end of Customer Discovery), ICP practice
(ICP sharpens before outreach scales), PMF literature (market big enough
+ solution matching needs), investor practice (traction before pitch).

Adopted order:

```
intake → mapping → icp_sizing (always) → research → experiment → leads
  → evidence → verifying → memo → investor_readiness (gated)
```

- `icp_sizing` sits right after `mapping`: its output (5-dimension ICP +
  TAM/SAM/SOM) grounds `research` and `leads` instead of the raw
  `target_customer` string. Always runs — every idea needs a defined
  customer before discovery; one model-only AI call, no mandatory web tools.
- `investor_readiness` sits after `memo`, gated on
  `verdict ∈ {go, iterate}`: scoring a `stop` verdict for investors is
  professionally incoherent and wastes a call; `test_more` is likewise
  excluded (evidence too thin to pitch — the memo already names the next
  experiment instead). Skips emit an explicit
  `tool_result` trace (`investor_readiness: skipped, reason: verdict=<v>`).

## 3. Skill changes (4 prompt injections + research rebuild + 2 new skills)

Adversarial audit 2026-10-08 proved `runMarketResearchSkill`
(route.ts:1029-1131) is a pure `groundedSearch` tool loop with NO prompt
and NO `callAIWithFallback`, and that its queries use only
`domain`/`one_liner`/assumption text — never `target_customer`. Hence
"prompt-text only, no signature change" is false. Revised contract:
prompt-text edits PLUS optional backward-compatible params
(`icpSummary?: string`, `marketCtx?: string`); no SSE shape, DB schema,
or phase-shape change.

1. `runAssumptionMappingSkill` (:922) ← `startup-methodology`: every
   assumption as a testable hypothesis (segment + problem + method +
   measurable signal + timeframe); never skip Problem Formulation.
2. `runMarketResearchSkill` (:1029) ← `icp-market-sizing`, REBUILT as
   query-shaping + synthesis:
   - NEW optional param `icpSummary: string = ""`. When present, the 3
     grounded-search queries are ICP-shaped: market-size query appends
     ICP geography/segment + "TAM SAM SOM"; competitor query appends ICP
     workaround terms; assumption-evidence query unchanged.
   - NEW synthesis `callAIWithFallback` step after the search loop
     producing TAM/SAM/SOM + competitor-landscape summary (new response
     schema, `usageAcc` accounting, `toolCalls++` at the call site).
     Anti-hallucination: every market number must cite a tool-returned URL.
   - Fail-soft: search-loop errors already traced per-query; a synthesis
     failure emits a `verification` warning trace and the phase returns
     raw evidence (never aborts the run).
3. `runExperimentDesignerSkill` (:1228) ← `experiment-design-coach`:
   cheapest-first ladder (Tier 4–5 forbidden before exhausting 1–3) +
   assumption-category → experiment-type table with sample minimums.
   Prompt gains an `ICP:` line from the new optional `icpSummary` param.
4. `runResponseAnalyzerSkill` (:1376) ← `evidence-quality-coach`: 4 Mom
   Test rules + Bayesian rung weights (Rung 1–2 = noise; a Rung 3+
   contradiction outweighs 20 compliments).
5. `runDecisionMemoSkill` (:1483) ← `investor-pitch-coach`: 8 readiness
   signals with weights. NEW optional param `marketCtx: string = ""`
   rendered as a `MARKET:` prompt block (TAM/SAM/SOM + ICP summary) —
   the memo currently has no market conduit (audit C6).
6. NEW `runIcpSizingSkill(startup, assumptions, trace, usageAcc?,
   companionCtx = ""): Promise<IcpProfile>` — 5-dimension ICP +
   TAM/SAM/SOM reasoning via `callAIWithFallback` (new schema).
   `companionCtx` passed through (memo-consistent, audit I4); its output
   is NOT fed back into companion context.
   Fail-soft (audit I7): on error, emit a warning trace and return a
   fallback profile built from raw `target_customer`, so the run
   continues with degraded grounding instead of dying.
7. NEW `runInvestorReadinessSkill(startup, decision, marketCtx, trace,
   usageAcc?, companionCtx = ""): Promise<InvestorScorecard | null>` —
   returns `null` (with explicit skip trace) unless normalized verdict
   ∈ {go, iterate}. Verdict normalized (`trim().toLowerCase()`,
   whitelisted — audit M5 forbids replicating the direct-cast pattern
   at route.ts:1553-1559).
   Fail-soft (audit C4): the executor wraps this call in try/catch; ANY
   error (timeout, 429 budget, model failure) emits a `tool_result`
   trace and the run continues to persist + `done` (the memo stands —
   a post-memo advisory phase must never convert a good memo into an
   `error` stream).

Token/latency guard: additions stay short; the 90s hard budget is unchanged.

## 4. SSE / trace / frontend / types contract

- New stream events: `phase: icp_sizing` (after mapping),
  `phase: investor_readiness` (after memo, when gated in), plus result
  events `icp_profile` and `investor_scorecard` with dedicated payloads.
- `SessionPhase` (`apps/web/src/lib/types.ts`) gains
  `"icp_sizing" | "investor_readiness"`; `PhaseIndicator`
  (`apps/web/src/app/validate/page.tsx:60`) gains two entries
  ("ICP & Market", "Investor Ready", reused lucide icons — English
  labels consistent with the existing indicator). Required — TS
  breaks without it.
- NEW (audit C2): the SSE consumer `switch (data.type)`
  (validate/page.tsx:746-808) has explicit cases and NO default, so the
  two new frames would be silently dropped. Add `case "icp_profile"` +
  `case "investor_scorecard"` with dedicated state (`setIcp`,
  `setScorecard`), extend the SSE `data` type (:726-744), and render two
  cards: ICP card (5 dimensions + TAM/SAM/SOM) and scorecard card
  (8 signals + overall), placed by the evidence/memo sections and
  following surrounding language conventions.
- NEW (audit C3): add `IcpProfile` + `InvestorScorecard` interfaces to
  `lib/types.ts` (beside `Assumption`/`Evidence`/`Experiment`/`Decision`);
  extend `AgentOutput`, `SessionState`, and the `done` payload — or the
  UI has nowhere to put the data.
- Trace actors `skill:icp-sizing`, `skill:investor-readiness` reuse
  `skill_start`/`skill_end` → covered by the existing
  `trace_events` CHECK allow-list → **no migration**, conditional on the
  target env having `0011_companion_memory`/`0013_companion_check_discovery`
  applied (audit M2 — verify at implementation).
- NEW (audit I1): `trace.slice(0, 50)` can amputate the late-appended
  investor rows on high-trace runs. Persist `trace.slice(0, 50)` PLUS
  any investor/skip rows appended after the cut (hard cap 55), with a
  unit test asserting investor rows survive persistence.

## 5. Persistence & budget (no new tables)

- `icp_sizing` output refines the in-memory `startup.target_customer`
  before the persist block → saved in the existing `startups` row; the
  FULL structured profile is passed explicitly (new optional params) to
  `research`/`experiment`/`memo`/`investor` prompts — mutating
  `target_customer` alone changes zero research behavior (audit C5).
- NEW (audit I6): `target_customer` flattening format — one-line ICP
  summary, ≤500 chars per `UNTRUSTED_FIELD_CHARS` (route.ts:114-118);
  full profile lives in trace/SSE only.
- `investor_readiness` scorecard persists via `trace_events` (with the
  §4 slice-plus-append rule) + SSE payload only. Deliberate: the score
  is a point-in-time assessment, not history — a dedicated table would
  be YAGNI until time-series comparison is requested as its own design.
- Both new calls go through `callAIWithFallback` taking `usageAcc`;
  the EXECUTOR performs the standard per-phase accounting after each
  (audit M1: `toolCalls++`, `totalCost += costFromUsage(...)`,
  `checkTimeout()`, `assertPhaseBudget(...)`, `send(...)`) —
  `checkTimeout` is an IIFE closure, not an import.
- Time, not cost, is the constraint (audit I3): 2 extra calls ≈ $0.008
  (negligible) but sequential model latency inside the unchanged 90s
  global deadline (`BUDGET.HARD_TIMEOUT_MS`, no per-phase timeout).
  Hence BOTH new phases are fail-soft (§3 items 6–7). Tool-call budget:
  10–11 → 12–13 of `MAX_TOOL_CALLS:15` — no further phases may be added
  without a cap change; state that in code comments.
- The 5 playbook directories are committed in the implementation commit
  as the methodology source. No untracked leftovers, no TODO markers.

## 6. Verification battery

1. New unit tests (route-level, following `startup-stage.test.ts` FakeDb
   precedent — note `__tests__/` currently has NO agent-route test):
   investor gate (skipped on `stop` AND `test_more`, runs on `go` /
   `iterate`, with explicit skip-trace assertion), `icp_sizing` always
   runs, SSE phase order, investor-row persistence survival (audit I1),
   icp fail-soft fallback (audit I7).
   Audit I2 warning: with no `uploaded_data`, `allowGo=false` forces
   `test_more`, so the standard no-upload run ALWAYS skips investor —
   the battery MUST include an uploaded-data fixture exercising the
   run path, not only the skip path.
2. `tsc --noEmit` (mandatory post-`SessionPhase`/new-interface change).
3. Full unit suite + golden `eval/harness/runner.mjs` + `meta.test.mjs`.
   Audit I5 correction: prompt-text changes break NOTHING in CI —
   `run.mjs` checks recorded threads, `runner.mjs` asserts recorded
   fixtures deterministically, neither imports pipeline prompts. The
   real risk is undetected live-behavior drift → require a live
   spot-check memo review instead of "snapshot refresh".
4. `next build` + `e2e/project-progress` + `e2e/smoke`. Audit M4: no
   frame-shape assertion updates needed, but extra phases add seconds
   inside the 90s stream — timeout margins shrink.
   `e2e/trial-paywall` re-run only after Gemini saturation clears
   (external constraint, documented 2026-10-08).
5. Single commit + push + live verify (homepage 200).

## 7. Rejected alternatives

- **Both phases always-on**: simpler, but investor scoring on `stop`
  verdicts wastes calls and contradicts professional practice.
- **Prompt-only, no new phases**: cheapest, but leaves Path 2 undone —
  rejected explicitly under the zero-debt directive.
