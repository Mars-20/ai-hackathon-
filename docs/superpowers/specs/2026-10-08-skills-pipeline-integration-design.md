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

## 3. Prompt injections (5 functions, prompt-text only)

Extend the inline prompt of each existing skill function by ~15–30 lines
(English, matching current style). No signature, schema, or phase change:

1. `runAssumptionMappingSkill` (:922) ← `startup-methodology`: every
   assumption as a testable hypothesis (segment + problem + method +
   measurable signal + timeframe); never skip Problem Formulation.
2. `runMarketResearchSkill` (:1029) ← `icp-market-sizing`: 5-dimension
   ICP; always anchor on SOM, never present TAM as the relevant market;
   cite a source for every market number (anti-hallucination).
3. `runExperimentDesignerSkill` (:1228) ← `experiment-design-coach`:
   cheapest-first ladder (Tier 4–5 forbidden before exhausting 1–3) +
   assumption-category → experiment-type table with sample minimums.
4. `runResponseAnalyzerSkill` (:1376) ← `evidence-quality-coach`: 4 Mom
   Test rules + Bayesian rung weights (Rung 1–2 = noise; a Rung 3+
   contradiction outweighs 20 compliments).
5. `runDecisionMemoSkill` (:1483) ← `investor-pitch-coach`: 8 readiness
   signals with weights + correct market framing (Apollo SAM + capacity SOM).

Token/latency guard: additions stay short; the 90s hard budget is unchanged.

## 4. SSE / trace / frontend contract

- New stream events: `phase: icp_sizing` (after mapping),
  `phase: investor_readiness` (after memo, when gated in), plus result
  events `icp_profile` and `investor_scorecard` following the
  `primary_evidence` pattern.
- `SessionPhase` (`apps/web/src/lib/types.ts`) gains
  `"icp_sizing" | "investor_readiness"`; `PhaseIndicator`
  (`apps/web/src/app/validate/page.tsx:60`) gains two entries
  ("ICP & Market", "Investor Ready", existing icon set). Required — TS
  breaks without it.
- Trace actors `skill:icp-sizing`, `skill:investor-readiness` reuse
  `skill_start`/`skill_end` → covered by the existing
  `trace_events` CHECK allow-list → **no migration**. Rows persist inside
  the current first-50 trace slice.

## 5. Persistence & budget (no new tables)

- `icp_sizing` output refines the in-memory `startup.target_customer`
  before the persist block → saved in the existing `startups` row; the
  refined ICP text is also passed to `research`/`leads` in-memory.
- `investor_readiness` scorecard persists via `trace_events` + SSE
  payload only. Deliberate: the score is a point-in-time assessment, not
  history — a dedicated table would be YAGNI until time-series comparison
  is requested as its own design.
- Both new calls go through `callAIWithFallback` with `checkTimeout`,
  `assertPhaseBudget`, `costFromUsage` — identical failure semantics to
  current phases, no special paths.
- The 5 playbook directories are committed in the implementation commit
  as the methodology source. No untracked leftovers, no TODO markers.

## 6. Verification battery

1. New unit tests: investor gate (skipped on `stop`, runs on
   `go`/`iterate`), `icp_sizing` always runs, SSE phase order.
2. `tsc --noEmit` (mandatory post-`SessionPhase` change).
3. Full unit suite + golden `eval/assistant/run.mjs` (refresh snapshots
   if prompt drift breaks exact matches) + `meta.test.mjs`.
4. `next build` + `e2e/project-progress` + `e2e/smoke`.
   `e2e/trial-paywall` re-run only after Gemini saturation clears
   (external constraint, documented 2026-10-08).
5. Single commit + push + live verify (homepage 200).

## 7. Rejected alternatives

- **Both phases always-on**: simpler, but investor scoring on `stop`
  verdicts wastes calls and contradicts professional practice.
- **Prompt-only, no new phases**: cheapest, but leaves Path 2 undone —
  rejected explicitly under the zero-debt directive.
