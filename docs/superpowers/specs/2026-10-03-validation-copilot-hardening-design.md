# Validation Copilot Hardening — Design Spec

**Date:** 2026-10-03
**Status:** Proposed — awaiting user review before plan execution
**Scope:** Architectural (multi-subsystem hardening, zero future debt)
**Spec path:** `docs/superpowers/specs/2026-10-03-validation-copilot-hardening-design.md`

## 1. Shared Understanding

**Intended outcome (what user said):** بحث وتعلم عن المشاكل الموجودة + أفضل الممارسات + خطة إصلاح احترافية كاملة دون ديون مستقبلية تمنع المشروع من العمل + تنفيذها.

**Who for:** فريق Validation Copilot + مالك النشر على Vercel/Supabase (`Ai_Hackathon` ref `qgolznxdfokbggsdmxlu`).

**Success criteria (from memory + audit):**
- جميع العيوب الحرجة مصلحة ومثبتة باختبارات وتقرير تحقق.
- `tsc` نظيف + `lint` نظيف + `build` ناجح + `vitest` أخضر + `eval` حقيقي يفشل عند انحراف verdict/citations.
- لا أسرار على القرص/اللوغ، RLS مغلقة، rate-limit موزع، verifier بوابة لا استشاري.
- لا `TODO` يمنع التشغيل، لا جدول ميت بلا قرار، لا مصدران للحقيقة بلا CI.

**Constraints:**
- Stack ثابت: Next.js 15.3.3 + React 19 + Supabase Postgres/Auth/RLS + Gemini 2.5-flash + Groq llama-3.3-70b + Apollo.
- `apps/agent` فارغ — لا Go/Docker — النشر Vercel/Supabase فقط.
- لا كسر البناء الحالي أثناء الإصلاح.

## 2. Root Causes (Evidence, no fixes yet)

### C1 Secrets
- `.env.local:2-14` قيم صريحة على القرص (تحقق fresh `Test-Path True`). `.gitignore` يتجاهلها فلا تسريب Git، لكن الخطر تشغيلي.
- `client.ts`/`server.ts`/`middleware.ts` فصل صحيح (anon فقط في client، service_role server-only في admin routes).
- `invite/route.ts:86-87` `console.log([Invite Link] /invite/token)` غير مشروط → Log Drains = تسريب credential. `debug_token` مقيد بـ dev (سليم ظاهرياً).

### M2 Validation
- `zod@3.25.76` مثبت لكن صفر استيراد في `src`.
- `invite/route.ts:20-29` يفحص وجود فقط. دور خاطئ → `ROLE_RANK[undefined]` → تجاوز → `CHECK` في DB → `500` بدل `400`. نفس الشيء لبريد/UUID.
- `startups/save/route.ts:13-74` نمط جيد جزئياً (UUID_RE، JSON try/catch، membership 403) لكن `stage:69` أي string → `CHECK` violation → `500` مع `error.message` خام.

### M5 Invites
- لا `app/invite/[token]/page.tsx` (`Test-Path False`) → الرابط المطبوع `404`.
- `invite/route.ts:82-84` `TODO send email` + `package.json` بلا `resend`. `admin/ops/email` يؤكد `delivery out of scope`.
- Token يُطبع بينما نفس المشروع يستبعده من SELECT كـ credential.

### C2 Eval
- `eval/run-eval.js:1-127` لا `fetch` ولا import من `apps/web`. يعيد تعريف `validateQuestion/meetsGoThreshold` محلياً.
- `mockEvidence` ثابت + `claimHasCitations=false` دائماً → tautology.
- gt-006/007/008 بلا أي فرع assertion → `8 PASSED` مضمونة. `tasks.json` حقول `verdict_in/confidence_in/primary_evidence_count_gte/feasibility_assumptions_gte` يتيمة.
- لا `fixtures/`، لا runner يستدعي `POST /api/agent` ويقرأ SSE حتى `done`، لا `report.json` ولا `exit 1`.

### C3 Tests/CI
- `package.json:5-9` بلا `test`. `glob *.test.*` صفر. `glob .github/workflows/*` صفر.
- `meetsGoThreshold/validateQuestion/BUDGET/verdict_override` بلا حماية انحدار.

### M1 Prod limits
- `route.ts:1162-1211` `Map<ip>` per-instance + تعليق `use Redis in prod`. لا يتوسع (N_instances × 10/min)، يفقد عند restart، نمو مفاتيح بلا إخلاء، مفتاح `x-forwarded-for` قابل للتدوير، لا `Retry-After`، حد IP فقط لا user/workspace.
- `COST_TABLE:1179` تقديرات ثابتة (`replace with provider metering`) + `BUDGET:243-247` ثابت مُجمّع بلا عداد لكل workspace. الأدمن نفسه يسميه `estimated`.

### M4 Trace RLS
- `schema-unified.sql:404-406` `trace_insert ... WITH CHECK (true)` → أي authenticated يكتب أي `startup_id/workspace_id/cost_usd/payload`.
- `trace_select:395-403` يسمح `startup_id IS NULL` لأي authenticated → تسرب cross-tenant.
- `startups.workspace_id` nullable كجسر demo بلا backfill/`NOT NULL` لاحق.

### Schema/RLS
- الموحد (`439` سطر) ≡ migration `20240101000000` byte-identical (SHA256 متطابق) — لا drift اليوم، الخطر مستقبلي بلا CI hash-check.
- يطبق 3/4 من ممارسات Supabase: `(select auth.uid())` + `SECURITY DEFINER SET search_path=''` + indexes + `TO authenticated` + split policies. الناقص: helpers في `public` لا `private` + بلا `REVOKE EXECUTE` + `update_updated_at` بلا `search_path` + `docs/supabase-schema.sql:157-183` قديم بلا `search_path`.
- `leads/messages` ميتان من agent: `agent/route.ts:1326-1406` يحفظ 6 جداول فقط، `runLeadFinderSkill:690-729` Apollo لحظي بلا persist، `campaign.ts:79-238` consent+idempotency جاهز لكن غير مستدعى. `leads` بلا `workspace_id` مباشر.

### Search/History
- العزل داخل DB صحيح (`search:84-119` `in workspaceIds + startups!inner`، `history:97-113` `in + decisions!inner + count exact + range`). `workspaceIds` قائمة من استعلام منفصل (TOCTOU، حد حجم) — RLS طبقة ثانية.
- `escapePostgrest` (`packages/admin/escape.ts:8-19`) minimal (يهرب `\ % _ , ( ) * " [ ]` فقط، بلا `ESCAPE '\'` صريح). فلاتر history `.in()` بلا whitelist → فراغ بصمت بدل `400`.
- History عدّ من DB ✅. Search `totalHits = len1+len2+len3` بعد `limit 5..20` ❌ (عدّ JS مبتور، لا pages). ترتيب `bigramDice` JS بعد `ilike` (مقبول ≤20 لكن يكسر الترتيب العام؛ `pg_trgm+GIN` موجود لكن بلا RPC `similarity()`).

### Verifier/Threshold/Prompt
- Canonical `GO_THRESHOLD {4,3,30,12}` (`utils.ts:190-195`) يطابق playbook. `eval` يطابقه منطقياً لكن بنسخة محلية (drift مستقبلي).
- انحراف 1: `meetsGoThreshold` يعدّ الصفوف كمصادر مستقلة بلا dedup `domain/source_url`.
- انحراف 2: `deriveConfidence medium` يستخدم `totalSample>=12` بدل `interviewSample>=12` → `medium` مع `Go` مرفوض (رسالة مربكة).
- انحراف 3: `eval LEADING_PATTERNS` إنجليزية فقط vs `utils.ts:72-100` عربية + hypothetical/past-behavior.
- Verifier ثلاثي (`allowGo` يقيد enum + `verdict_override:1038-1048` + `runVerifier:1075-1157` شبكة حتمية) جيد البنية لكن: الشبكة تُعطَّل بأي `source_url` واحد (`hasUrl` global)، تفحص `plannerSummary` المختصر لا المذكرة، و `approved=false` إحصائية فقط (`1428-1429`) — استشاري لا بوابة.
- Prompt: `MAX_IDEA 2000 / MAX_DATA 8000 + sanitize strip ```/role:/ignore previous/jailbreak` (`1165-1175,1220-1225`) blocklist هش، لا `<untrusted>` delimiters، لا فصل `system/user`، حقول مولدة (`startup.name/one_liner:1003-1021`) تُعاد حقنها بلا تعقيم، `evidenceSummary.slice(0,10)` بلا حد per-field.

## 3. Approaches (2-3 + recommendation)

### A. Minimal patch (سريع، مرفوض)
إصلاح M2 بـ `if` يدوية + حذف `console.log` + نسخ `eval` assertions بسيطة. التكلفة أيام. العيب: يبقي drift (نسخ threshold)، يبقي Map rate-limit، يبقي `CHECK true`، يبقي `totalHits` JS، يبقي verifier استشاري. ديون تبقى.

### B. Hardening كامل بلا ديون (موصى به)
- `zod` مشترك `lib/validation` + `400 {issues}` + إخفاء `error.message` DB.
- `vitest` طبقتان (وحدة `lib/` + تكامل handlers بـ `NextRequest` مزيف) + `ci.yml` رباعي (`tsc→lint→vitest→build`) + hash-check للـ schema.
- `eval harness` يستورد من `@/lib/utils` مباشرة (ممنوع نسخ) + fixtures مسجلة + runner يستدعي handler ويقرأ SSE + `report.json` + `exit 1` عند بلا تغطية + meta-check `expected بلا assertion = fail`.
- RLS: helpers → `private` + `REVOKE` + `SET search_path` لكل functions + `trace_insert` → `service_role` فقط (أو `WITH CHECK` عضوية) + إسقاط `startup_id IS NULL` من authenticated + backfill ثم `NOT NULL` لـ `workspace_id` + توثيق `docs/supabase-schema.sql` متجاوز.
- Prod: Upstash Redis sliding-window بمفتاح `user_id` else `ip+route` + `429 + Retry-After` + حدث `rate_limited` في trace + عداد إنفاق لكل `workspace_id/period` ذري + تكلفة حقيقية من `usageMetadata` (COST_TABLE fallback مُعلَّم).
- Search: `count exact` لكل نوع أو RPC واحد + RPC `similarity()` فوق `trgm` + whitelist للفلاتر + `ESCAPE '\'` صريح.
- Threshold: dedup على `domain/source_url` + توحيد `deriveConfidence medium` على `interviewSample` + مزامنة `eval` patterns مع `utils` (استيراد مباشر).
- Verifier: بوابة (يمنع `done go` عند `unsupported>0` أو يلحق `warnings`) + `hasUrl` per-claim لا global + فحص المذكرة الكاملة.
- Prompt: `<untrusted>` لكل مدخل + فصل `system/user` + تعقيم كل حقل مُعاد حقنه + حد per-field.
- Invites: `invite/[token]` قبول (Accept/Decline عبر RPC) + Resend عبر Vercel Env + hash للـ token + انتهاء 7 أيام + استخدام واحد + cron `expired` + إيقاف طباعة التوكن.
- Leads: قرار صريح — إما توصيل `campaign.ts` (consent-gated) أو توثيق الجدولين خارج مسار agent وإسقاطهما من الموحد. لا تعليق.
- Secrets: تدوير المفاتيح الخمسة (إجراء بشري) + Vercel Env + توحيد `.gitignore` + عدم طباعة tokens أبداً.

**لماذا B:** يغلق C1/C2/C3/M1-M6 جذرياً، يمنع drift (استيراد لا نسخ، hash-check، coverage thresholds)، ويحول verifier/eval من شكلي إلى بوابة. التكلفة أسابيع لكن بلا ديون.

### C. Rebuild جزئي (مرفوض)
إعادة كتابة agent كخدمة منفصلة (Go/Python) أو نقل rate-limit/DB إلى Edge Functions. يكسر البناء الحالي، يتطلب `apps/agent` جديد + Docker، ويؤجل القيمة. لا حاجة — Next.js الحالي يكفي مع Redis و RLS صحيحة.

**التوصية:** B.

## 4. Design Sections

### 4.1 Architecture
Next.js App Router يبقى المضيف الوحيد. `lib/validation` (zod) طبقة دخول لكل `api/*`. `lib/rate-limit` واجهة (`checkRateLimit({key, limit, window})`) بتطبيقين: `memory` (dev/test) و `upstash` (prod) عبر env switch، مع `fail-closed`. `lib/cost` عداد Supabase ذري + `usageMetadata` extractor. `eval/harness` يستورد `lib/utils` مباشرة ويحقن fixtures لمزودي AI/Search. DB: migration جديدة `20240101000002_hardening.sql` (private helpers + trace tighten + backfill + search RPC + invite hash/expiry) + CI hash-check. CI: `ci.yml` واحد رباعي المراحل.

### 4.2 Components (files touched)
- Create: `apps/web/src/lib/validation.ts`, `apps/web/src/lib/rate-limit.ts`, `apps/web/src/lib/cost.ts`, `apps/web/vitest.config.ts`, `apps/web/src/lib/__tests__/utils.test.ts`, `.../validation.test.ts`, `.../api/*.test.ts`, `eval/harness/*`, `eval/fixtures/*`, `eval/report.json` (generated), `supabase/migrations/20240101000002_hardening.sql`, `.github/workflows/ci.yml`, `apps/web/src/app/invite/[token]/page.tsx`.
- Modify: `api/workspace/invite/route.ts`, `api/startups/save/route.ts`, `api/search/route.ts`, `api/history/route.ts`, `api/agent/route.ts` (prompt delimiters + verifier gate + dedup + per-field limits + remove log), `lib/utils.ts` (dedup + confidence fix + no behavior break), `packages/db/schema-unified.sql` (source) + regen migration `...0000`, `README.md` (migrations/seed/runbook + APOLLO key + Resend).
- Docs: هذا الـ spec + plan لاحق.

### 4.3 Data flow
`POST /api/agent` → `validation.parse` (400) → `checkRateLimit(user_id||ip)` (429+Retry-After) → `cost.checkBudget(workspace)` (402/429) → `sanitize+delimit<untrusted>` → skills → `meetsGoThreshold(deduped)` → `allowGo` يقيد schema → `runVerifier(full memo, per-claim hasUrl)` → `verdict_override` بوابة → `persist via service_role (trace)` + `authenticated (domain)` → SSE `done {verdict,confidence,evidence,trace,stats,warnings}`. `search/history` → `validation` → `count exact / RPC similarity` → `200 {data,meta:{total,pages}}`. `invite` → `validation` → `hash(token)` → `pending` → Resend → `invite/[token]` → Accept RPC → membership.

### 4.4 Error handling
- `400 {error, issues}` لكل تحقق zod (role/email/UUID/stage/verdict/stage/confidence).
- `401` غير مصادق، `403` غير عضو، `409` دعوة pending مكررة، `429 {error, retryAfter}` للحد، `402/429` للميزانية.
- إخفاء `error.message` DB (لوغ داخلي فقط). لا `500` لمدخل خاطئ — `500` للأعطال الداخلية فقط.
- Verifier `unsupported>0` → `test_more` + `warnings[]` في المذكرة، لا `go` صامت.

### 4.5 Testing
- وحدة: `meetsGoThreshold` (dedup، n=30، n=12 interviews، thin→false)، `deriveConfidence` (high/medium/low بعد الإصلاح)، `validateQuestion` (EN+AR + hypothetical/past)، `BUDGET/isBudgetExceeded`، `escape`، `validation` (role/email/UUID/stage → 400).
- تكامل: كل handler بـ `NextRequest` مزيف + Supabase/AI مزيفين: `401/403/409/429` + `verdict_override` يمنع `go` على thin + `trace` لا يكتب عند بلا عضوية.
- ذهبية: harness يغطي `gt-001..008` كل `expected.*` له assertion + meta-check (بلا تغطية = fail) + `report.json` + `exit 1`.
- بوابة: `tsc --noEmit` → `eslint` → `vitest run` → `next build` + `schema hash-check`. أي فشل يمنع الدمج. Coverage thresholds على `lib/utils.ts`.

## 5. Spec Self-Review
- Placeholder scan: لا TBD/TODO في هذا الـ spec (TODO البريد مذكور كفجوة بمالك Resend، لا كمواصفة مفتوحة).
- Consistency: `private helpers + REVOKE` متوافق مع `TO authenticated` + split policies. `service_role` لـ trace متوافق مع `authenticated` لباقي الكتابة (observability server-only).
- Scope: مركز واحد (hardening) — لا ميزات جديدة (outreach يُؤجَّل بقرار صريح).
- Ambiguity: `leads` القرار ثنائي (توصيل أو توثيق خارج النطاق) — لا حل وسط معلق. `workspace_id NULL` يُحسم بـ backfill ثم `NOT NULL`.

## 6. User Review Gate
> Spec مكتوب هنا (وسيُحفظ في `docs/superpowers/specs/2026-10-03-validation-copilot-hardening-design.md`). فضلاً راجعه وأخبرني بأي تعديل قبل كتابة خطة التنفيذ التفصيلية. التنفيذ (TDD) يبدأ بعد اعتماد الـ spec + اختيار طريقة التنفيذ (subagent-driven أم native).
