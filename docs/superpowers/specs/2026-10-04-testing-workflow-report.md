# Testing Workflow — Unified Report (6-Domain Parallel Sweep)

**Date:** 2026-10-04
**Design:** `docs/superpowers/specs/2026-10-04-testing-workflow-design.md` (approach B approved)
**Sources:** Spec v2.0/v2.1/v2.3 + hardening-design 2026-10-03 + live code + `eval/golden-tasks/tasks.json`
**Method:** 6 parallel read-only agents (no prod-code change) + coordinator integration
**Overall verdict:** **FAIL — P0-blockers present, demo-able with constraints, not shippable as P1/live-send**

## 1. Executive Verdict per Domain

| Domain | Agent verdict | One-line reason |
|---|---|---|
| 1 Runtime-Verifier-Budget | FAIL | Verifier gate holds + per-claim holds, but budget checked once, cost fiction (undefined usageMetadata), blocklist-only prompt, XFF-spoofable anon key, Router inverted, no backoff |
| 2 Skills-Logic | CONDITIONAL PASS | 35/35 vitest + 8/8 eval PASS, GO_THRESHOLD+dedup+interview-depth enforced, but `Would you pay $X?` false-negative + medium/ineligible combo + prompt-only acceptances |
| 3 Tools-Data-Continuity | FAIL (P0-blocker) | 4 tools not 6, no `prospects` table, Apollo momentary-only, base RLS open, continuity without HERMAS |
| 4 Compliance-Auth | CONDITIONAL PASS | Consent-gate+idempotency+invite/zod/RLS solid, but no send-cap, no L3 campaign gate in code, no unsubscribed check, whatsapp allowed, prospects model unbuilt, no invite page |
| 5 Integration-E2E | CONDITIONAL PASS (P0 demo-able) | Eval tautology FIXED (harness imports real utils), search/history isolation FIXED, but intake 0 questions, response_rate dead (undefined), CI no e2e/coverage/hash, no demo artifacts |
| 6 Vulns-Consistency | FAIL | 2 Critical secrets on disk, 4 High drifts (schema hash, static cost, Apollo vs prospect_search, 3 OPENs coded), metering dead-path |

**Bottom line:** P0 golden path يعمل للعرض مع فجوتين (intake 0 أسئلة، response_rate مفقود) + Verifier بوابة حقيقية. P1 live-send ممنوع قبل (send-cap + unsubscribed + L3 approval + prospects model + rotation). الـ eval الحالي سليم — الادعاء القديم بالـ tautology outdated.

## 2. Critical / P0-Blockers (fix first, TDD)

1. **Secrets on disk (C1):** `.env.local:2-14` 5 keys حية + `.agents/mcp_config.json:10,19,21` نفس Apollo + Supabase token. `.gitignore` يغطي الأول فقط. **Action:** rotation + Vercel Env + purge disk + ignore mcp_config + secret-scan in CI.
2. **6th tool + prospects table absent (v2.3 §7/§9/§11.4):** `packages/tools/index.ts` 4 فقط، لا `prospect_search.ts`، لا `prospects` DDL، لا `source_prospect_id/prospect_manual_convert`. Apollo الحالي REST in-memory بلا persist. **Action:** build-or-defer decision — إما بناء MCP + migration + icp-targeting + consent wiring، أو downgrade spec لـ v2.1 five-tool.
3. **Base RLS open:** `0000:395-406` trace_select IS NULL leak + trace_insert WITH CHECK true. Hardened في `0002` + unified فقط. **Action:** لا تنشر base وحده؛ CI hash-gate + `0000+0001+0002` إلزامي.
4. **Budget fiction + single check:** `extractUsageCost(undefined)` ×7 → totalCost ≈0.048 دائماً؛ `isBudgetExceeded` مرة واحدة بعد intake فقط. **Action:** plumb usageMetadata + enforce كل phase + per-workspace counter ذري.
5. **Intake 0 questions + response_rate dead:** `runIntakeSkill` single-shot بلا clarifying_questions؛ `response_rate: undefined:undefined` دائماً. **Action:** round-trip ≤3 Qs + wire response_rate reducer (نفس نمط sample_size).
6. **No send-cap / no unsubscribed / no L3 gate:** `campaign.ts` بلا cap، بلا `select unsubscribed`، بلا `experiments.status approved` check؛ `whatsapp` مسموح. **Action:** cap + pre-send lookup + approval gate + restrict channel=email حتى الرخصة.

## 3. Major Gaps (P0-Med / P1)

- Prompt blocklist-only + single-string fullPrompt + re-injected startup.name/one_liner + slices بلا per-field cap + لا fetch_page robots. → `<untrusted>` + system/user split + caps + sanitize re-injected + verifier full-memo (not summary+rationale slice).
- Rate-limit XFF-spoofable anon + memory fallback + Router inverted (Gemini-primary→Groq-fallback) + no 429 backoff headers + no AbortSignal (cooperative timeout فقط).
- Skills: `pay` missing في hypothetical list (High false-negative)، medium/ineligible combo (same-URL ×3 → medium + ineligible)، high padding (rung4 يرفع high)، dedup بلا query-strip، spec §8 rung-3+×1 vs code rung-4+×3 (doc stale)، playbook Medium ≥5/n≥15 vs code ≥3/n≥12، PMF/risk gates prompt-only، leading annotate-only لا block، sample<15 prompt-only.
- Tools: grounded_search downgrade (ungrounded → opinion url="" بدل drop)، fetch_page بلا robots، stats duplication، save_artifact artifact:// + null-startup incompatible مع hardened RLS.
- Compliance: PDPL license/disclosure غير code-enforced، in-memory bypass، signup checkbox UI غائب، sender/business-name غير validated، cron بلا schedule، mailer out-of-scope (صحيح)، cost.ts anon fallback.
- Integration: report.json بلا §13 metrics (coverage%, unsupported%, catch rates, latency/cost)، CI بلا e2e/coverage/eval/hash، e2e smoke unauth فقط، dashboard cards "—".
- Consistency: unified 487 vs base 439 lines (hash mismatch)، docs/supabase-schema.sql قديم بلا banner، runbook notes stale (eval mirrors, Map, EN-only)، README paths/names/plan drift، root بلا package.json، agent route بلا zod، HERMAS/hermas_events/Telegram design-only، 3 OPENs (§14) coded بدون resolution (models 3.8 vs 2.5، email provider، anon vs auth).

## 4. What PASSES (keep)

- Verifier gate-not-advisory + per-claim (not global) + memo-rescan union + stop/iterate preserved. 48/48 vitest (verifier-gate 14, rate-limit 19, utils 15) + tsc clean.
- GO_THRESHOLD canonical {4,3,30,12} + normalize+dedup core + interview-depth medium + high rung5×3. 35/35 utils + threshold RED/GREEN. gt-002/003/004/007 PASS live 8/8.
- campaign consent-gate + idempotency UNIQUE + deduped:true + leads CHECKs + RLS owner-scoped. invite hash+7d+410+single-use + PUBLIC_COLUMNS + zod 400 {issues} + service_role server-only. No scrape enum, no prospects→messages wiring, no WhatsApp sender, no mailer (correctly deferred).
- Eval harness sound: ts-bridge imports real utils, coverageFor throws, meta bans literals, runner exit 1. Search/history isolation + exact counts + pages + whitelist + ISO + escaper (backslash-first) all FIXED.
- P0/P1/P2 boundaries respected. Continuity reopen works (history?startup_id + localStorage fallback).

## 5. Coverage Matrix (Spec § → Agent)

| Spec § | Covers | Agent | Status |
|---|---|---|---|
| 5.0 HERMAS | delegation/continuity/L3/priority/health | 1,3,6 | design-only, no loop/events/channel — FAIL |
| 5.1 Runtime | Router→Planner→Executor→Verifier | 1 | gate holds, router inverted, summary-only — PARTIAL |
| 5.3 Evidence ladder | opinion→commitment + hard rule | 2 | enforced, 1 false-negative — COND PASS |
| 5.4 Continuity | reopen + history-aware + propose-not-act | 3,5 | reopen works, no HERMAS view — PARTIAL |
| 6 providers/budgets | Gemini/Groq/fallback/0.50/15/90s | 1,6 | fiction + once-check — FAIL |
| 7 tools (6) | grounded/fetch/stats/campaign/save/prospect | 3 | 4/6, 1 missing, 2 degraded — FAIL |
| 8 skills (8+3b) | intake→memo + icp-targeting | 2 | gates hold, validator gap, 3b unbuilt — COND PASS |
| 9 schema (8+prospects) | startups→trace + RLS | 3,4,6 | base open, prospects missing — FAIL |
| 10 L0-L3 | read/draft/internal/external | 4 | idempotency pass, L3+cap missing — PARTIAL |
| 11.1 PDPL | license/consent/log/grace 31Oct26 | 4 | e-log pass, license/disclosure not-coded — PARTIAL |
| 11.2 WhatsApp | opt-in + license → P2 | 4 | no sender but allowlisted — PARTIAL |
| 11.3 Email P1 | checkbox/consent/unsub/cap | 4 | pattern only, rest absent — NOT SHIPPABLE |
| 11.4 Apollo boundary | research-only, manual-convert | 3,4,6 | vacuously safe, model unbuilt — BLOCKED |
| 12 anti-hallucination | grounding/verifier/math/insufficient/confidence/injection | 1,2 | gate+math pass, injection blocklist — PARTIAL |
| 13 eval 20-30/5d + metrics | intake/research/planted/leading/thin/off-domain | 2,5 | 8 tasks, harness sound, metrics missing — PARTIAL |
| 14 stack/env | Node/Next/Supabase/email/Vercel + OPENs | 6 | 3 OPENs coded — FAIL |
| 15 repo structure | apps/packages/db/eval/docs | 5,6 | apps/agent empty by design, root runner missing — INFO |
| 16 build plan | Day1/2/3 hour budget | 5,6 | README Phase-% mismatch, freeze ambiguous — INFO |
| 17 demo script | 7 beats + fail-safe video | 5 | artifacts absent — GAP |
| 18 risks | 6 rows | 6 | 6/6 partially open — PARTIAL |
| 19 DoD | 5 criteria | 5 | search/history/compliance ok, response_rate missing — PARTIAL |

## 6. Interconnect Map (why isolated fixes fail)

- Budget fiction → ledger/trace_events fiction → workspace cap never trips → 429 surprise (1→3→6).
- Blocklist injection → tainted startups.name/one_liner persisted → threshold/confidence/memo read poison (1→2→4).
- XFF rotation + memory fallback → anon bypass → fresh budgetKey per IP → spend isolation broken (1→3).
- No Router + no backoff → every skill pays Gemini → amplifies overrun (1→6→5.0).
- Verifier summary-only → assumption hallucinations persist in DB despite memo gate (1→2→3).
- Missing prospects makes prospect_search unrecoverable — no sink for total_matched/sample (3→2→4).
- Adding prospects without cap/unsub/L3 turns safe absence into unsafe pipeline (3→4).
- Null-startup save_artifact breaks under hardened NOT NULL (3→3).
- Dead leads/messages masks missing cap — wiring P1 without gates reintroduces PDPL risk (3→4).
- response_rate dead → §13 metrics cannot report real rates (5→5).
- CI without eval gate → threshold-drift PR passes (5→2→6).
- Same Apollo key in 2 files → rotation must cover both (6→4).

## 7. Concrete Next Steps (for writing-plans + TDD)

1. Secrets: rotate 5 keys + Supabase sbp token, Vercel Env single sink, purge disk, ignore mcp_config, CI secret-scan (`git grep -n -E "sk-|AKIA|ghp_|xoxb-"`).
2. Schema: reconcile unified↔0000 (re-gen or version delta), CI sha256 gate, mark docs/supabase-schema.sql SUPERSEDED, backfill workspace_id + NOT NULL (reserved), pg_trgm/RPC decision, cron schedule.
3. v2.3 build-or-defer: prospect_search MCP + prospects migration + source_prospect_id/convert enum + icp-targeting + campaign wiring OR spec downgrade to 5-tool.
4. Runtime: usageMetadata plumbing, per-phase budget enforce, AbortSignal, system/user split + <untrusted> + per-field caps + full-memo verifier, Router classifier + 429 backoff + Retry-After, XFF trusted-proxy + user/workspace keys, Redis prod guard fail-closed.
5. Skills: add `pay` + query-strip + distinct-check in deriveConfidence (or document combo) + high-padding fix + spec §8 update (rung-4+×3) + playbook reconcile + PMF/risk gates decision + hard-reject leading + sample<15 deterministic + outreach/RACS wiring decision.
6. Compliance P1: DAILY_SEND_CAP + counter, L3 approved check, unsubscribed lookup, sender/disclosure validation, checkbox UI, channel=email-only, prospects manual-convert API, invite page + cron + Resend pick, cost.ts service-only.
7. Integration: intake ≤3 Qs round-trip, response_rate wiring, eval metrics generator (5 §13 numbers, real only), CI e2e + coverage + eval + hash, docs/demo-script.md + fail-safe video, root runner, README fix (paths/env/refs/boundary/freeze).
8. Eval: keep ts-bridge single-source, add hypothetical/normalize/confidence-padding/clarifying/category/full-build/outreach unit tests.

## 8. Self-Review

- Placeholder scan: لا TBD — الغائب prospect_search/HERMAS/cron/mailer موثق كفجوة بقرار build-or-defer، لا افتراض.
- Consistency: read-only diagnosis متوافق مع RLS (لا كتابة cross-tenant). Criticals مدعومة بـ file:line من 6 تقارير.
- Scope: تشخيص واحد — لا إصلاح كود هنا. الإصلاح عبر writing-plans + TDD لاحقاً.
- Ambiguity: leads قرار ثنائي (توصيل P1 gated أو توثيق خارج النطاق) — التقرير يوثق الوضع (dead) لا يحسم. workspace_id NULL جسر demo بلا backfill.
