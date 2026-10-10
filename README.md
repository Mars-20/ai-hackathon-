# Validation Copilot — AI-OS

> An AI co-founder that helps startup founders validate ideas **before** they spend months and money building the wrong thing.

[![Next.js 15](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BRLS-3ecf8e)](https://supabase.com/)
[![Gemini](https://img.shields.io/badge/AI-Gemini_2.5_Flash-4285f4)](https://ai.google.dev/)
[![Groq](https://img.shields.io/badge/Router-Groq-f55036)](https://groq.com/)
[![PDPL](https://img.shields.io/badge/Compliance-EG_PDPL_151%2F2020-blue)](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
[![License](https://img.shields.io/badge/License-Private-lightgrey)]()

**The problem:** founders fail on validation, not execution — building on opinions and polite lies ("great idea!") instead of evidence.
**The fix:** this product forces the two skipped steps — structured assumption testing before building, and primary evidence from real, consenting people.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why Not a Generic Chatbot?](#why-not-a-generic-chatbot)
- [Architecture](#architecture)
- [Survey Guard: Leading-Question Validator](#survey-guard-leading-question-validator)
- [Evidence Quality: Commitment Ladder](#evidence-quality-commitment-ladder)
- [Autonomy Levels L0–L3](#autonomy-levels-l0l3)
- [Stack](#stack)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Database](#database)
- [Evaluation: 8 Golden Tasks](#evaluation-8-golden-tasks)
- [Compliance (Egypt PDPL)](#compliance-egypt-pdpl)
- [Environment Variables](#environment-variables)
- [Build Plan](#build-plan)
- [Freeze Rule](#freeze-rule-day-3--75)
- [Live Demo](#live-demo)
- [References](#references)

---

## What It Does

| # | Capability | Skill | Output |
|---|------------|-------|--------|
| 1 | **Startup Intake** — extracts domain, customer, stage, business model from free text (AR/EN) | `startup-intake` | Structured startup profile |
| 2 | **Assumption Mapping** — risk-ranked map (desirability / viability / feasibility), riskiest on top | `assumption-mapping` | Ranked assumption list with reasoning |
| 3 | **Market Research** — grounded web research; every claim cited or labeled `insufficient evidence` | `market-research` + `grounded_search` | Cited claims table |
| 4 | **ICP Sizing** — counts from Apollo (research-only), match reason per contact | `icp-targeting` + `prospect_search` | Prospects table, never leads |
| 5 | **Experiment Design** — cheapest test for the riskiest assumption; never recommends full build first | `experiment-designer` | Hypothesis + pass/fail criteria + cost |
| 6 | **Survey Guard** — deterministic leading / hypothetical question rejection (EN+AR) | `survey-designer` | Approved / rejected + rewrite hint |
| 7 | **Primary Evidence Analysis** — classifies interview notes / CSV on the commitment ladder | `response-analyzer` | Rung breakdown + stats |
| 8 | **Decision Memo** — Go / Iterate / Stop / Test More with confidence tier + next cheapest experiment | `decision-memo` | Verdict + confidence + next step |
| 9 | **Full Trace** — every tool call, verifier check, cost and latency logged | `trace_events` | Auditable log panel |

---

## Why Not a Generic Chatbot?

| Generic chatbot | Validation Copilot |
|---|---|
| Answers politely, even when data is thin | Says `insufficient evidence` when sources are missing |
| Does math in prose (often wrong) | All numbers via deterministic `stats` tool in code — never by the model |
| Accepts biased questions | **Rejects** leading + hypothetical-only questions by regex + logic (`@/lib/utils:validateQuestion`) |
| Says "Go for it!" to please you | **Cannot output `Go`** without rung-4+ ×3 sources and n≥30 (or n≥12 saturated interviews) — enforced in code: `if (verdict === "go" && !allowGo) verdict = "test_more"` |
| No audit trail | Separate **Verifier** model call strips unsupported claims before they reach you; full log in `trace_events` |

---

## Architecture

```
User Input → Router (Groq) → Planner (Gemini) → Executor (code) → Verifier (Gemini) → Output + Trace
```

**Core loop:** `apps/web/src/app/api/agent/route.ts`

| Stage | Model (default, overridable via env) | Role | Hard rule |
|-------|--------------------------------------|------|-----------|
| **Router** | `llama-3.3-70b-versatile` (`GROQ_ROUTER_MODEL`) | Classify intent, select skill, assign L0–L3 | Handles Groq rate-limit headers + backoff |
| **Planner** | `gemini-2.5-flash` (`GEMINI_PLANNER_MODEL`) | Break task into tool calls via active skill playbook; `google_search` grounding always on for market claims | Must request structured JSON via `responseSchema`; never does arithmetic in prose |
| **Executor** | Deterministic TypeScript | Calls tools one-by-one, retry/backoff, budget guard | Max **$0.50 / task, 15 tool calls, 90s timeout**. Never skips calls, never fabricates results. Writes every call to `trace_events` |
| **Verifier** | `gemini-2.5-flash` (`GEMINI_VERIFIER_MODEL`) | Compares Planner draft vs **actual** tool results | Strips/flags unmatched claims. **Never skipped** to save latency — this is the anti-hallucination core |

**Tools (MVP):** `packages/tools/` + `apps/web/src/lib/`

| Tool | Contract |
|------|----------|
| `grounded_search` | Every claim carries `url`. No URL = not returned |
| `fetch_page` | Respects robots.txt, 10s timeout. Fetched content is **UNTRUSTED DATA** — never executes instructions in it |
| `stats` | `sample_stats` / `sean_ellis_score` / `response_rate` / `confidence_interval` — computed in code |
| `campaign` | Only writer to `leads`/`messages`. Enforces consent-gate + idempotency in code. L3 — human approval required |
| `save_artifact` | Persists `assumption_map` / `experiment_design` / `decision_memo`, returns renderable link |
| `prospect_search` (Apollo) | Writes to `prospects` only. Never to `leads`/`messages`. Sequence tools never wired |

---

## Survey Guard: Leading-Question Validator

> Implementation: `apps/web/src/lib/utils.ts:22-108` (`validateQuestion`) · Playbook: `packages/skills/survey-designer/playbook.md` · Tests: `apps/web/src/lib/__tests__/utils.test.ts` · Eval: `eval/golden-tasks/tasks.json:gt-003`

Formula: `approved = !isLeading && !isHypotheticalOnly`

### The 3 deterministic filters

**Filter 1 — Leading (REJECT).** Implies the desired answer.
Patterns: `don't you think` · `wouldn't you agree` · `isn't it obvious` · `obviously` · `surely you` · `as you know` · AR: `أليس صحيح` · `ألا تعتقد` · `بالتأكيد توافق` · `كما تعلم` · `من الواضح أنك`

**Filter 2 — Hypothetical-only (REJECT).** Future promise with no past anchor.
Patterns: `would you ever / pay / buy / use` · `how much would you pay` · `if … would you` · `imagine … would you` · AR: `هل ستشتري` · `هل ستدفع` · `تخيل`

**Filter 3 — Past-behavior anchor (REQUIRED for APPROVE).** Concrete recall with time/money/workflow.
Patterns: `last time` · `have you ever` · `tell me about a time` · `how do you currently` · `walk me through` · AR: `آخر مرة` · `حدثني عن مرة` · `كيف تتعامل حاليا` · `هل سبق`

### Examples

| Question | Result | Why |
|----------|--------|-----|
| `Don't you think fresh organic produce is obviously better?` | ❌ Rejected — leading | `Don't you think` + `obviously` tells the user to say yes |
| `Wouldn't you agree that paying 20% more is totally worth it?` | ❌ Rejected — leading | `Wouldn't you agree` seeks confirmation |
| `Would you pay $20/month for this?` | ❌ Rejected — hypothetical-only | Future intent with zero past spend = fake signal (rung 1) |
| `أليس صحيح أن هذا المنتج مفيد؟` | ❌ Rejected — leading (AR) | Direct AR leading pattern |
| `Tell me about the last time you bought produce — where and why?` | ✅ Approved — high signal | Anchored recall, open-ended |
| `What have you paid in the last 6 months to fix this? How much?` | ✅ Approved — gold standard | Financial baseline, validates willingness to pay |
| `How do you currently handle invoicing? Most time-consuming step?` | ✅ Approved | Current-workflow probe, no pitch |

**Rewrite rule:** talk about *their past*, not *your idea*. Never pitch during discovery. Every script must include ≥2 past-anchored questions.

---

## Evidence Quality: Commitment Ladder

> Enforced in code: `apps/web/src/lib/utils.ts:118-140` (`STRENGTH_RUNG`)

| Rung | Signal | Example | Weight |
|------|--------|---------|--------|
| 1 | `opinion` | "Looks interesting" | Weak — polite fiction |
| 2 | `intent` | "I would use it" | Weak — future promise |
| 3 | `time_given` | Joined 30-min interview, asked for demo | Medium — spent time |
| 4 | `contact_shared` | Gave email, agreed to pilot | Strong — real friction |
| 5 | `commitment` | Pre-signed, pre-paid, design partner | Strongest — money/signature |

**Go gate (hard):** `Go` requires rung-4+ ×3 independent sources **and** n≥30 quantitative **or** n≥12 saturated interviews. Thin evidence (e.g. 3× "sounds good") → forced `test_more` with `low` confidence. Sample n<15 is always flagged `insufficient sample`.

---

## Autonomy Levels L0–L3

| Level | Meaning | Examples | Approval |
|-------|---------|----------|----------|
| L0 | Read-only | search, fetch, read own data | None |
| L1 | Draft, no external effect | Draft survey, memo, outreach copy | None |
| L2 | Reversible internal change | Save assumption, update status, trace write | None |
| L3 | External / irreversible | Send message, mark campaign running | **Explicit human approval** — founder approves copy + list + cap + schedule once; system enforces daily cap + idempotency key in code |

HERMAS (platform supervisor) owns delegation, continuity, approval-gates, and health monitoring — but the loop is **deferred** while only one Skill Pack exists. The one boundary that never moves: HERMAS can never skip L3 approval or overrule a Verifier rejection.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Web Dashboard | Next.js 15 + React 19 + Tailwind + next-intl (AR/EN) + Recharts |
| Agent Runtime | Next.js API Routes + Gemini SDK + Groq classifier |
| AI: Planner / Verifier | Google Gemini 2.5 Flash (+ `gemini-3.5-flash-lite` pool fallback — see `route.ts:87-97`) |
| AI: Router | Groq `llama-3.3-70b-versatile` (override via `GROQ_ROUTER_MODEL`) |
| Database | Supabase (Postgres + Auth + RLS, `private.*` helpers, `select auth.uid()` pattern) |
| Rate-limit ledger | Upstash Redis in prod, in-memory fallback in dev |
| Hosting | Vercel |
| Tests | Vitest (unit) + Playwright (e2e) + golden-task harness (`eval/run-eval.js`) |

---

## Quick Start

### 1. Install

```bash
cd apps/web
npm install
```

### 2. Environment

```bash
cp apps/web/.env.example apps/web/.env.local
# Fill in: GEMINI_API_KEY, GROQ_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
# Full checklist: see Environment Variables below + apps/web/.env.example
```

### 3. Database

Apply `packages/db/schema-unified.sql` (source of truth), then migrations in `supabase/migrations/` in filename order `0000`–`0008` — including the `0006` workspace backfill and `0008` workspace_id NOT NULL verification — via `supabase db push` or the Supabase SQL Editor. Full order + backfill: see `docs/runbook-validation.md` §1–§2.

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → `/validate` (auth-required).

```bash
npm run typecheck  # tsc --noEmit
npm run test:ci    # vitest run
npm run test:e2e   # playwright test
```

---

## Project Structure

```
/apps
  /web                    Next.js dashboard: intake, assumption map, evidence, trace, memo
    /src/app
      page.tsx            Landing page
      /[locale]/validate  Main validation dashboard (auth-required)
      /[locale]/dashboard History + continuity · /history · /assistant · /admin
      /api/agent          Core agent loop (Router→Planner→Executor→Verifier)
    /src/lib
      types.ts            All TypeScript types
      utils.ts            Stats re-export + leading-question validator + ladder
      skills-helpers.ts   Grounding split, verdict normalize, ICP parse

/packages
  /skills                 One playbook per skill (playbook.md each)
    startup-intake/ assumption-mapping/ market-research/
    survey-designer/      ← leading-question validator lives here
    experiment-designer/ decision-memo/ icp-market-sizing/
    outreach-composer/ response-analyzer/ + coach skills
  /db                     Supabase schema (schema-unified.sql) + migrations
  /tools                  stats · fetch_page · campaign · save_artifact · prospect_search

/supabase
  /migrations             Ordered 0000–0008 (0006 backfill, 0008 NOT NULL verify)

/eval
  /golden-tasks/tasks.json  8 tasks × 6 domains (spec §13)
  run-eval.js  harness · report.json  metrics

/docs
  AI_OS_Validation_Copilot_Spec_v2_3.md  ← current build reference (v2.3)
  demo-script.md        ← 7-beat live demo (~10–12 min, spec §17)
  runbook-validation.md ← deploy + migration order + live gates
```

---

## Database

All tables RLS-enforced, owner/workspace-scoped via `private.is_workspace_member()` — never bare `auth.uid()`.

| Table | Purpose | Key constraint |
|-------|---------|----------------|
| `workspaces` / `members` / `invites` | Multi-tenancy root | Role: owner/admin/member/viewer |
| `startups` | One row per venture | `owner_id → auth.users`, `workspace_id` cascade |
| `assumptions` | Risk-ranked list | `category: desirability/viability/feasibility`, `risk: critical/high/medium/low` |
| `evidence` | All evidence, source-tagged | `type: secondary/primary`, `strength: opinion→commitment` |
| `experiments` | Validation designs | `draft → approved → running → completed` (approval required) |
| `prospects` | Apollo research ONLY | `outreach_status: not_contacted / founder_contacted_manually`. Never auto-messaged |
| `leads` | Consented contacts ONLY | `consent_given=true + timestamp + exact text` required; `source: founder_list/signup_form/community/prospect_manual_convert` |
| `messages` | Full audit trail | `idempotency_key` unique; channel locked to `email` until PDPL license (DB trigger); L3 experiment-approval trigger |
| `decisions` | Memo history | `verdict: go/iterate/stop/test_more`, `confidence: low/medium/high` |
| `trace_events` | Observability | Every tool call/result/verification/decision with `cost_usd` + `latency_ms` |

Auto-create personal workspace on signup (`handle_new_user()` trigger).

---

## Evaluation: 8 Golden Tasks

> `eval/golden-tasks/tasks.json` · Run: `node eval/run-eval.js` · Metrics: citation coverage, unsupported-claim rate, planted-error catch rate, leading-question catch rate, latency/cost per task. **Real numbers only — never placeholders.**

| ID | Domain | Tests |
|----|--------|-------|
| `gt-001` | edtech | Intake → map → research; ≥5 assumptions across 3 categories; verdict `test_more` |
| `gt-002` | B2B SaaS | Planted `$50B / 80% growth` claim — **verifier must flag** |
| `gt-003` | food-tech | 2 leading questions **rejected**, 1 past-anchored **approved** |
| `gt-004` | health | 3× "sounds good" (rung-1, n<15) → must be `test_more/low`, never `go` |
| `gt-005` | general | Off-domain (`How do I cook koshari?`) — graceful handling, no crash |
| `gt-006` | e-commerce | Domain generalization — same methodology, different vertical |
| `gt-007` | fintech | 30 drivers, 12 contacts, 5 pre-signs → eligible `go/iterate` with `medium/high` |
| `gt-008` | logistics | Feasibility-heavy map (≥2 feasibility + regulatory/ops mention) |

---

## Compliance (Egypt PDPL)

- Law 151/2020 + Executive Regulations (grace period ends **31 Oct 2026**): direct e-marketing needs a separate license + prior explicit consent + electronic consent log (`leads.consent_text`, `leads.consent_timestamp`).
- **§11.4 prospect boundary (hard):** Apollo `prospect_search` is research-only — writes to `prospects`, never to `leads`/`messages`. Apollo sequences never wired. Only sanctioned path: founder contacts person **outside** the platform → gets explicit consent → manually converts with full consent fields (`prospect_manual_convert`).
- No WhatsApp outreach (P2 — needs marketing license). DB trigger locks `messages.channel` to `email`.
- Acceptable demo/P1 sources: founder-owned lists, sign-up forms with consent checkbox, communities the founder personally participates in.

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GEMINI_API_KEY` | ✅ P0 | Planner, Verifier, grounded search |
| `GROQ_API_KEY` | ✅ P0 | Router/classifier |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ P0 | Database (browser-safe; `NEXT_PUBLIC_*` intentionally public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ P0 | Client DB access (anon only — never service-role) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ P0 | Server DB access — server-only, NEVER `NEXT_PUBLIC_`-prefixed |
| `APOLLO_API_KEY` | Optional | `prospect_search` counts (search/enrich only — never outreach) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Prod only | Shared rate-limit ledger; unset ⇒ in-memory fallback (dev/test) |
| `GEMINI_PLANNER_MODEL` / `GEMINI_VERIFIER_MODEL` / `GROQ_ROUTER_MODEL` (+ `GEMINI_GROUNDING_MODEL`) | Optional | Model overrides (defaults: `gemini-2.5-flash` / `llama-3.3-70b-versatile`; re-verify IDs day-of) |
| `RESEND_API_KEY` | P1 only | Email campaigns (Resend; delivery wiring out-of-scope v1) |

> ⚠️ Use a **paid** Gemini key for the demo. Free tier will 429 mid-demo (5k searches/mo shared across Gemini 3.x; helper falls back to ungrounded on free-tier failure).

---

## Build Plan (spec §16)

| Phase | Status | Description |
|-------|--------|-------------|
| A — Skeleton | ✅ Done | Router/Planner/Executor/Verifier loop |
| B — Core skills | ✅ Done | All skills + leading-question validator |
| C1 — Primary evidence | ✅ Done | Upload notes/CSV → analysis + memo |
| C2 — Email outreach | 🔲 P1 | Live campaign with consent capture |
| D — Evaluation | 🔲 In progress | 8 golden tasks, metrics report |

**P0 must work:** runtime loop, grounded search, assumption mapping, leading-question validator, primary evidence upload, decision memo, full trace, dashboard.
**P1 if time:** live email with consent + cap + unsubscribe + reply classification.
**P2 roadmap only:** WhatsApp/SMS, MCP/A2A, Brand & Identity, Customer Communication, Business Health packs, self-improvement pipeline.

---

## Freeze Rule (Day-3 / 75%)

Freeze new features at ~75% of build time; last quarter is evaluation, demo rehearsal, and recorded fallback only — never new capability (spec §16). Cut order: golden-task count (never below 6) → domain coverage (2 domains) → dashboard polish. **Never cut:** Verifier, leading-question validator, evidence-strength distinction.

---

## Live Demo

> Full script: `docs/demo-script.md` (spec §17 — 7 beats, ~10–12 min + Q&A). Rehearse twice on presentation hardware.

1. **Problem** (1 min) — no slides, product is the pitch.
2. **Golden path live** (4 min) — paste real idea into `/validate`: intake → assumption map → grounded research → memo.
3. **Trace** (1.5 min) — point at one Verifier check + one cost line under cap.
4. **Planted error** (1.5 min) — feed a leading question, watch it reject; cite verifier catch rate. Thesis: a generic chatbot would have answered; this system refuses.
5. **Second domain** (1 min) — intake + map only, no new code.
6. **Continuity** (1 min) — reopen first idea: *"a co-founder that remembers you."*
7. **Metrics + roadmap** (1.5 min) — real §13 numbers; "Skill Pack #1 works — next packs plug into the same runtime."

Fail-safe: record one full golden-path run in advance. If live stalls, say verbatim: *"The live run hit a snag — here is one full successful golden-path run I recorded earlier…"* — never fake a live run.

---

## References

- [Spec v2.3](./AI_OS_Validation_Copilot_Spec_v2_3.md) ← current build reference
- [Demo script](./docs/demo-script.md) ← 7-beat live demo (spec §17)
- [Runbook](./docs/runbook-validation.md) ← deploy + migrations + live gates
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Gemini grounding docs](https://ai.google.dev/gemini-api/docs/google-search)
- [The Mom Test](https://momtestbook.com)
- [Egypt PDPL compliance](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
