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
prompt-text edits PLUS appended optional params (new optionals go LAST,
after `companionCtx`, so positional callers never break); ADDITIVE SSE
events only (2 new phase values + 2 new result frames — existing frames
untouched); no breaking change to existing frames; no DB migration.

1. `runAssumptionMappingSkill` (:922) ← `startup-methodology`: every
   assumption as a testable hypothesis (segment + problem + method +
   measurable signal + timeframe); never skip Problem Formulation.
2. `runMarketResearchSkill` (:1029) ← `icp-market-sizing`, REBUILT as
   query-shaping + synthesis:
   - NEW optional param `icpSummary: string = ""` (appended last). When
     present, the 3 grounded-search queries are ICP-shaped: market-size
     query appends ICP geography/segment + "TAM SAM SOM"; competitor
     query appends ICP workaround terms; assumption-evidence query
     unchanged. Research does NOT gain `companionCtx` (audit I4 —
     tool-loop phase, verifier-style minimalism; document if revisited).
   - NEW synthesis `callAIWithFallback` step after the search loop.
     Response schema: `{ tam: {value, source_url}, sam: {value,
     source_note}, som: {value, basis}, competitors: string[],
     note: string }` (all strings, URLs tool-grounded only).
     MERGE POINT: the synthesis does NOT return `Evidence[]` (signature
     stays `Promise<Evidence[]>`) — it emits a `MarketSizing` object via
     the `skill_end` trace payload AND a `market_sizing` tool_result
     trace; the EXECUTOR reads it from trace to build `marketCtx`
     (single-producer rule, audit C6). Evidence return unchanged.
     Anti-hallucination: every market number must cite a tool-returned
     URL; ungrounded numbers are dropped with a `verification` warning.
   - Accounting: research call-site becomes `toolCalls += 4` (3 search +
     1 synthesis). Fail-soft: search-loop errors already traced
     per-query; a synthesis failure emits a `verification` warning trace
     and the phase returns raw evidence (never aborts the run).
3. `runExperimentDesignerSkill` (:1228) ← `experiment-design-coach`:
   cheapest-first ladder (Tier 4–5 forbidden before exhausting 1–3) +
   assumption-category → experiment-type table with sample minimums.
   Prompt gains an `ICP:` line from the new optional `icpSummary` param
   (appended last).
4. `runResponseAnalyzerSkill` (:1376) ← `evidence-quality-coach`: 4 Mom
   Test rules + Bayesian rung weights (Rung 1–2 = noise; a Rung 3+
   contradiction outweighs 20 compliments).
5. `runDecisionMemoSkill` (:1483) ← `investor-pitch-coach`: 8 readiness
   signals with weights. NEW optional param `marketCtx: string = ""`
   (appended last) rendered as a `MARKET:` prompt block placed directly
   after the `EVIDENCE` block and before `THRESHOLD CHECK`
   (route.ts:1525-1528) — TAM/SAM/SOM + ICP summary.
   SINGLE-PRODUCER RULE (audit C6): `marketCtx` is built ONLY from the
   research SYNTHESIS output (grounded numbers). The icp_sizing profile's
   own TAM/SAM/SOM are labeled "preliminary (pre-research)" inside
   `icp_profile` and NEVER feed the memo. On number conflict, synthesis
   wins; the conflict is noted in a trace, not papered over. The
   investor skill takes the same `marketCtx` (required there — investor
   never runs without a memo, which never runs without research).
6. NEW `runIcpSizingSkill(startup, assumptions, trace, usageAcc?,
   companionCtx = ""): Promise<IcpProfile>` — 5-dimension ICP +
   TAM/SAM/SOM reasoning via `callAIWithFallback` (new schema).
   `companionCtx` passed through (memo-consistent, audit I4); its output
   is NOT fed back into companion context (same no-feedback rule covers
   the investor output).
   Fail-soft (audit I7): on provider/model/parse error, emit a warning
   trace and return a fallback profile built from raw `target_customer`,
   so the run continues degraded. TIMEOUT/BUDGET errors
   (`checkTimeout`, `assertPhaseBudget`) ALWAYS propagate — a run that is
   out of time or money must abort, never limp on (audit C4 carve-out).
7. NEW `runInvestorReadinessSkill(startup, decision, marketCtx, trace,
   usageAcc?, companionCtx = ""): Promise<InvestorScorecard | null>` —
   returns `null` (with explicit skip trace) unless normalized verdict
   ∈ {go, iterate}. Verdict normalized (`trim().toLowerCase()`,
   whitelisted — audit M5 forbids replicating the direct-cast pattern
   at route.ts:1553-1559); UNPARSEABLE verdict → skip, never run.
   EXECUTOR NULL-BRANCH (audit C4): on `null`, emit ONLY the skip
   `tool_result` trace — do NOT send `phase: investor_readiness`, do NOT
   send a scorecard frame — then continue to persist + `done`.
   Fail-soft: the executor wraps this call in try/catch; provider/model/
   parse errors emit a `tool_result` trace and the run continues to
   persist + `done` (the memo stands). Timeout/budget errors propagate
   per the §3.6 carve-out — the budget gate stays alive.
8. `runLeadFinderSkill` (audit C5 leads gap): gains the same optional
   `icpSummary: string = ""` (appended last); when present it shapes the
   Apollo titles/geo filters, else current `target_customer` behavior.
   §2's "grounds research and leads" holds via explicit params, not via
   mutation alone.

Token/latency guard: additions stay short; the 90s hard budget is unchanged.

## 4. SSE / trace / frontend / types contract

- New stream events: `phase: icp_sizing` (after mapping),
  `phase: investor_readiness` (after memo, when gated in — NEVER on the
  skip path), plus result events `icp_profile` and `investor_scorecard`.
  SEND SITES (audit C2): each new phase sends EXACTLY two frames —
  `send({type:"phase",...})` then `send({type:<result>,...})` — following
  the existing per-phase send pattern (singular "send" in earlier drafts
  was imprecise). Skip path sends NO phase frame.
- `SessionPhase` (`apps/web/src/lib/types.ts`) gains
  `"icp_sizing" | "investor_readiness"`; `PhaseIndicator`
  (`apps/web/src/app/validate/page.tsx:60`) gains two entries in
  pipeline order — `{id:"icp_sizing", label:"ICP & Market", icon:Globe}`
  after `mapping`, `{id:"investor_readiness", label:"Investor Ready",
  icon:TrendingUp}` after `memo` (both icons already imported,
  page.tsx:18,28; English labels match the indicator; audit M3 restored).
- NEW (audit C2): the SSE consumer `switch (data.type)`
  (validate/page.tsx:746-808) has explicit cases and NO default, so the
  two new frames would be silently dropped. Add `case "icp_profile"` +
  `case "investor_scorecard"` with dedicated state (`setIcp`,
  `setScorecard`), extend the SSE `data` type (:726-744) with
  `icp_profile?: IcpProfile; investor_scorecard?: InvestorScorecard`,
  and render two cards — `IcpProfileCard` beside `EvidenceCard`
  (:241: 5 dimensions + TAM/SAM/SOM) and `InvestorScorecardCard`
  beside `DecisionMemoPanel` (:421: 8 signals + weights + overall) —
  English to match neighboring cards. The `done` case (:781-801) MUST
  also hydrate `setIcp`/`setScorecard` from the `done` payload
  (reload/reconnect path), or the data vanishes on refresh.
- NEW (audit C3): add to `lib/types.ts` beside
  `Assumption`/`Evidence`/`Experiment`/`Decision`:
  - `IcpProfile { role_title: string; context: string; pain: string;
    workaround: string; buying_authority: string;
    tam: { value: string; source_url?: string };
    sam: { value: string; source_note?: string };
    som: { value: string; basis?: string };
    preliminary: boolean }`
    (`preliminary=true` until research synthesis confirms the numbers.)
  - `InvestorScorecard { signals: Array<{ key:
    "team"|"market"|"product"|"business_model"|"brand"|"traction"|
    "plan"|"persuasion"; score_1_10: number; note: string }>;
    overall_1_10: number; verdict_fit: "fundable"|"not_yet"|"unfit";
    top_gaps: string[] }`
  - `AgentOutput` gains `icp_profile: IcpProfile | null;
    investor_scorecard: InvestorScorecard | null`; `SessionState` gains
    the same two nullable fields; the `done` payload (route.ts:2402-2419)
    carries both (null on the skip path).
- Trace actors `skill:icp-sizing`, `skill:investor-readiness` reuse
  `skill_start`/`skill_end` → covered by the existing
  `trace_events` CHECK allow-list → **no migration**, conditional on the
  target env having `0011_companion_memory`/`0013_companion_check_discovery`
  applied (audit M2 — verify at implementation).
- NEW (audit I1): `trace.slice(0, 50)` can amputate the late-appended
  investor rows on high-trace runs. Rule: `persisted = trace.slice(0,
  50)`; `late = trace.slice(50).filter(t => t.actor ===
  "skill:investor-readiness")`; `persisted.push(...late)` truncated so
  `persisted.length <= 55`. Dedupe by row id (makeTrace ids unique —
  assert in code). Priority: investor rows always win the overflow
  slots; non-investor rows past 50 are dropped as today. Unit test
  asserts investor/skip rows survive persistence on a 60-row fixture.

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
- STRING CONSTRUCTORS (audit C5): prompt-threading strings are built
  once, in the executor, not inside skills —
  - `icpSummary` (≤300 chars): `"{role_title} in {context}; pain:
    {pain}; workaround: {workaround}; SOM: {som.value}"`, truncated.
    Distinct from the I6 `target_customer` flattening (one-line ICP
    summary ≤500 chars per `UNTRUSTED_FIELD_CHARS`, persisted to the
    `startups` row); full profile lives in trace/SSE only.
  - `marketCtx` (≤800 chars): `"TAM: {tam.value} ({tam.source_url});
    SAM: {sam.value} ({sam.source_note}); SOM: {som.value}
    ({som.basis}); ICP: {icp one-liner}"` built SOLELY from the research
    synthesis object (§3.2 single-producer rule).
- Both new calls go through `callAIWithFallback` taking `usageAcc`;
  the EXECUTOR performs the standard per-phase accounting after each
  (audit M1: `toolCalls++` per model call — research synthesis included,
  so research is `+= 4`; `totalCost += costFromUsage(...)`;
  `checkTimeout()`; `assertPhaseBudget(...)`; exactly two `send(...)`
  per new phase: phase frame + result frame) — `checkTimeout` is an
  IIFE closure, not an import.
- Time, not cost, is the constraint (audit I3): 3 extra model calls
  (icp + research-synthesis + investor) ≈ $0.012, negligible, but
  sequential latency inside the unchanged 90s global deadline
  (`BUDGET.HARD_TIMEOUT_MS`, no per-phase timeout). Tool-call budget:
  10–11 → 13–14 of `MAX_TOOL_CALLS:15` (icp +1, synthesis +1, investor
  +1) — 1–2 headroom, NOT 2–3 as earlier drafts claimed. Hence BOTH new
  phases are fail-soft (§3 items 6–7, timeout/budget carve-out), and no
  further phases may be added without a cap change; state that in code
  comments.
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
