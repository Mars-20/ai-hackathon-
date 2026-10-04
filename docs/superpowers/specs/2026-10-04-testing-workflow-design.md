# Testing Workflow — Full Platform Logic, Safety & Consistency Design

**Date:** 2026-10-04
**Status:** Approved approach B — ready for parallel execution
**Scope:** Architectural (read-only diagnosis, zero prod-code change in this phase)
**Sources:** `AI_OS_Validation_Copilot_Spec_v2_0.md`, `v2_1.md`, `v2_3.md` (canonical), `docs/superpowers/specs/2026-10-03-validation-copilot-hardening-design.md`, live code in `apps/web`, `packages/`, `eval/`, `supabase/`
**Spec path:** `docs/superpowers/specs/2026-10-04-testing-workflow-design.md`

## 1. Shared Understanding (approved)

**Intended outcome:** testing workflow كامل يغطي كل منطق عمل المنصة والمشروع: سلامة كل شيء، المشاكل والعيوب والنواقص والأجزاء التالفة والثغرات والترابط والاتساق.

**Who for:** مالك المشروع + فريق Validation Copilot (Vercel/Supabase project `Ai_Hackathon` ref `qgolznxdfokbggsdmxlu`).

**Success criteria:**
- كل Spec Sections 5–13 مغطى بوكيل واحد على الأقل مع مصفوفة تغطية.
- كل golden-task gt-001..008 له assertion متوقع ومخرج فعلي.
- كل ادعاء حرج مربوط بسطر كود أو سطر spec (file:line).
- لا تقرير بدون repro steps + severity (Critical/Major/Minor).
- صفر تغيير production code في هذه المرحلة — قراءة + `vitest run` + `tsc --noEmit` + فحص نظري فقط.

**Constraints:**
- Stack ثابت: Next.js 15.5.27 + React 19 + Supabase Postgres/Auth/RLS + Gemini 2.5-flash + Groq llama-3.3-70b + Apollo.
- `apps/agent` فارغ — لا Go/Docker — النشر Vercel/Supabase فقط.
- `packages/tools` فيه 5 أدوات فقط — السادسة `prospect_search` (v2.3 §7) غائبة كودياً — توثق كفجوة لا تفترض موجودة.

## 2. Architecture

منسق واحد (الجلسة الحالية) + 6 وكلاء `general` متوازيين عبر `task` tool، كل وكيل:
- **Scope ضيق:** domain واحد فقط.
- **Self-contained prompt:** كل السياق اللازم داخل الرسالة (مسارات ملفات + أسئلة + مخرج متوقع) — لا يرث سياق الجلسة.
- **Read-only:** ممنوع `edit/write/bash` يغير prod code. المسموح: `read/glob/grep`, `vitest run`, `tsc --noEmit`.
- **Output contract:** ملخص + findings منظمة (Defect/Gap/Vuln/Broken/Interconnect/Inconsistency) كل واحد: severity + evidence (file:line أو spec §) + repro + expected vs actual.

التكامل عند المنسق: إزالة التكرار، حل التضارب (الدليل الأقوى يكسب)، جدول أولويات C/M، خريطة ترابط بين domains.

```
Spec v2.3 + hardening-design + code + tasks.json
  ├─ Agent1 runtime-verifier-budget
  ├─ Agent2 skills-logic
  ├─ Agent3 tools-data-continuity
  ├─ Agent4 compliance-auth
  ├─ Agent5 integration-e2e
  └─ Agent6 vulns-consistency
       → testing-workflow-report (unified) + coverage matrix → writing-plans (fix plan, TDD)
```

## 3. Components (files touched per agent — read only)

- **Agent1 runtime-verifier-budget:** `apps/web/src/app/api/agent/route.ts` (الملف ~1400 سطر: prompt sanitize 1165-1175/1220-1225، verifier 1038-1048/1075-1157/1428-1429، budget 243-247، rate-limit 1162-1211، cost table 1179)، `src/lib/utils.ts` (BUDGET, applyVerifierGate, combineVerifierWithMemoScan)، `src/lib/cost.ts`, `src/lib/rate-limit.ts`.
- **Agent2 skills-logic:** `packages/skills/*` (8 مجلدات)، `src/lib/utils.ts` (GO_THRESHOLD 190-195، meetsGoThreshold، deriveConfidence، validateQuestion 72-155، claimHasUrlSupport/findUnsupported)، `eval/golden-tasks/tasks.json` gt-002/003/004/007.
- **Agent3 tools-data-continuity:** `packages/tools/*` (campaign, fetch_page, stats, save_artifact + الغائب prospect_search)، `packages/db/schema.sql` + `schema-unified.sql` (439 سطر) + `supabase/migrations/*` (hash-check drift)، `src/lib/apollo.ts`, `api/agent/route.ts:690-729/1326-1406` (leadFinder لحظي، persist 6 جداول فقط).
- **Agent4 compliance-auth:** Spec §11.1-11.4، `api/workspace/invite/route.ts` (86-87 console.log token، TODO email)، `app/invite/[token]/page.tsx` (غائب — Test-Path False)، `packages/tools/campaign.ts:79-238`، `src/lib/validation.ts` (inviteSchema، startupSaveSchema)، `src/middleware.ts`, `src/lib/supabase/*`.
- **Agent5 integration-e2e:** `app/validate/*`, `app/dashboard/*`, `app/history/*`, `api/search/route.ts` (84-119، totalHits JS)، `api/history/route.ts` (97-113)، `eval/run-eval.js:1-127` + `harness/*` + `fixtures/*`، `vitest.config.ts`، `src/app/api/__tests__/*` (6 ملفات)، `e2e/*`, `playwright.config.ts`.
- **Agent6 vulns-consistency:** `.env.local:2-14`, `.gitignore`, `COST_TABLE` التقديرية، Map rate-limit، `trace_insert WITH CHECK (true)` 404-406، `trace_select startup_id IS NULL` 395-403، `docs/supabase-schema.sql:157-183` القديم، OPEN items (§14)، P0/P1/P2 حدود، تناقضات v2.0→v2.3.

## 4. Data Flow

1. `POST /api/agent` → `validation.parse` (400) → `checkRateLimit(user||ip)` (429+Retry-After) → `cost.checkBudget(workspace)` → `sanitize+<untrusted>` → skills → `meetsGoThreshold(deduped)` → `allowGo` → `runVerifier(full memo, per-claim)` → `verdict_override` gate → persist (`service_role` للـ trace، `authenticated` للدومين) → SSE `done {verdict,confidence,evidence,trace,stats,warnings}`.
2. `search/history` → `validation` → `count exact / RPC similarity` → `200 {data,meta:{total,pages}}`.
3. `invite` → `validation` → `hash(token)` → `pending` → Resend → `invite/[token]` → Accept RPC → membership.
4. `prospect_search` (نظري) → `prospects` فقط — أي مسار `prospects → messages` يوثق كخرق حرج §11.4.

## 5. Error Handling

- `400 {error, issues}` لكل تحقق zod. `401` غير مصادق، `403` غير عضو، `409` دعوة مكررة، `429 {retryAfter}` للحد، `402/429` للميزانية. إخفاء `error.message` DB.
- Verifier `unsupported>0` → `test_more + warnings[]` — لا `go` صامت. `stop/iterate/test_more` تحفظ مع warnings.
- فشل وكيل → تقرير جزئي + سبب، لا يمنع البقية. تضارب → الدليل (file:line) يكسب.

## 6. Testing (this workflow IS the test plan)

- **وحدة:** `meetsGoThreshold` (dedup، n=30، n=12 interviews، thin→false)، `deriveConfidence` (high/medium/low)، `validateQuestion` (EN+AR+hypothetical/past)، `BUDGET/isBudgetExceeded`، `escape`، `validation` schemas.
- **تكامل:** كل handler بـ `NextRequest` مزيف: `401/403/409/429` + `verdict_override` يمنع `go` على thin + `trace` لا يكتب بلا عضوية.
- **ذهبية:** harness يغطي gt-001..008 كل `expected.*` له assertion + meta-check (بلا تغطية = fail) + `report.json` + `exit 1`.
- **بوابة:** `tsc --noEmit` → `eslint` → `vitest run` → `next build` + `schema hash-check`. Coverage thresholds على `lib/utils.ts`.
- **أمان:** secrets scan، RLS probe (cross-tenant read/write)، prompt-injection probes (`ignore previous`, `role:`, backticks)، Apollo boundary probe.

## 7. Parallel Dispatch Contract

- 6 prompts self-contained في رد واحد (توازي حقيقي). كل prompt: scope + ملفات + أسئلة + output schema + قيد read-only.
- المخرج لكل وكيل: `## Domain — Verdict` + جدول findings (Severity/Type/Location/Evidence/Repro/Expected/Actual) + `### Interconnect` + `### Missing`.
- المنسق يدمج في `docs/superpowers/specs/2026-10-04-testing-workflow-report.md` (لاحق) + مصفوفة تغطية Spec §.

## 8. Spec Self-Review

- Placeholder scan: لا TBD/TODO — الغائب `prospect_search` موثق كفجوة C وليس افتراضاً. Resend مالكه مفتوح لكن خارج نطاق التشخيص.
- Consistency: read-only متوافق مع `TO authenticated` + RLS (لا كتابة cross-tenant). `service_role` للـ trace قراءة نظرية فقط.
- Scope: تشخيص واحد — لا إصلاح كود، لا ميزات جديدة. الإصلاح عبر `writing-plans` + TDD لاحقاً.
- Ambiguity: `leads` القرار ثنائي (توصيل أو توثيق خارج النطاق) — التشخيص يوثق الوضع الحالي فقط. `workspace_id NULL` يوثق كجسر demo.
