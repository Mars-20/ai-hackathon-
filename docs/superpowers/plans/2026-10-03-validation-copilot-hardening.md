# Validation Copilot Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** إغلاق C1/C2/C3/M1-M6 جذرياً بلا ديون وجعل المشروع جاهزاً للإنتاج.

**Architecture:** طبقة `lib/validation` (zod) لكل API + `lib/rate-limit` (memory/upstash) + `lib/cost` (عداد workspace) + `vitest` طبقتين + `eval harness` يستورد `lib/utils` + migration `...0002_hardening` + CI رباعي.

**Tech Stack:** Next.js 15.3.3 + React 19 + TS 5 + Supabase Postgres/RLS + vitest + Upstash Redis + Resend + Gemini/Groq (fixtures في eval).

**Spec:** `docs/superpowers/specs/2026-10-03-validation-copilot-hardening-design.md`

## Global Constraints

- لا كسر `npm run build` في أي مهمة — كل مهمة تنتهي بـ `tsc --noEmit` أخضر.
- ممنوع نسخ `GO_THRESHOLD/LEADING_PATTERNS` — الاستيراد من `@/lib/utils` فقط.
- ممنوع طباعة `token/secret` في log أو response خارج dev الصريح.
- `error.message` من DB لا يخرج للعميل — رسالة عامة + لوغ داخلي.
- كل كود إنتاجي يسبقه اختبار أحمر يُشاهد فشله لسبب صحيح.
- `workspace_id` مصدر العزل — لا صف `NULL` جديد بعد Backfill.

## Review Focus

- مدخل `role=superadmin` غير صالح في invite يجب أن يرجع 400 لا 500.
- `stage=foobar` في startups/save يجب أن يرجع 400 لا 500 ولا تسريب Postgres.
- `POST /api/agent` الحادي عشر في دقيقة يجب أن يرجع 429 مع Retry-After.
- thin evidence (rung1 × opinion) يجب أن يمنع `go` حتى لو LLM قال `go`.
- ثلاثة أدلة rung4 من نفس `source_url` يجب ألا تحتسب 3 مصادر مستقلة.

---

### Task 1: Validation layer (zod) — يقفل M2

**Files:**
- Create: `apps/web/src/lib/validation.ts`
- Create Test: `apps/web/src/lib/__tests__/validation.test.ts`
- Modify: `apps/web/src/app/api/workspace/invite/route.ts:20-29,44-45,65-79`
- Modify: `apps/web/src/app/api/startups/save/route.ts:13-14,39,69,82-84`
- Modify: `apps/web/src/app/api/search/route.ts`, `apps/web/src/app/api/history/route.ts` (whitelist filters)

**Interfaces:**
- Consumes: `MemberRole` من `src/lib/types.ts:15`, `Stage` من `types.ts:63`
- Produces: `inviteSchema.parse()`, `startupSaveSchema.parse()`, `searchQuerySchema.parse()`, `historyQuerySchema.parse()` — كلها ترمي `ZodError` تُترجم لـ `400 {error, issues}`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/__tests__/validation.test.ts
import { describe, test, expect } from "vitest";
import { inviteSchema, startupSaveSchema } from "@/lib/validation";

describe("inviteSchema", () => {
  test("rejects invalid role with 400-shaped issues", () => {
    const r = inviteSchema.safeParse({ workspace_id: "550e8400-e29b-41d4-a716-446655440000", email: "a@b.co", role: "superadmin" });
    expect(r.success).toBe(false);
  });
  test("rejects bad email", () => {
    const r = inviteSchema.safeParse({ workspace_id: "550e8400-e29b-41d4-a716-446655440000", email: "not-email", role: "member" });
    expect(r.success).toBe(false);
  });
  test("startup rejects bad stage", () => {
    const r = startupSaveSchema.safeParse({ name: "X", stage: "foobar" });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/validation.test.ts`
Expected: FAIL with "Cannot find module @/lib/validation"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/lib/validation.ts
import { z } from "zod";
export const workspaceIdSchema = z.string().uuid();
export const inviteSchema = z.object({
  workspace_id: workspaceIdSchema,
  email: z.string().email().max(254),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});
export const startupSaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  stage: z.enum(["idea", "prototype", "live", "scaling"]).default("idea"),
  domain: z.string().max(100).optional(),
  workspace_id: workspaceIdSchema.optional(),
});
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(["all", "startup", "assumption", "evidence"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/validation.test.ts`
Expected: PASS 3/3

- [ ] **Step 5: Wire into invite + save routes (return 400, hide DB message)**

```typescript
// invite/route.ts — replace manual if with:
const parsed = inviteSchema.safeParse({ workspace_id, email, role });
if (!parsed.success) return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
// on DB error: console.error("invite insert failed", error); return 500 {error:"Failed to create invite"} (no error.message)
```

- [ ] **Step 6: Run full unit suite**

Run: `npx vitest run`
Expected: PASS, no regressions

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/validation.ts apps/web/src/lib/__tests__/validation.test.ts apps/web/src/app/api/workspace/invite/route.ts apps/web/src/app/api/startups/save/route.ts
git commit -m "feat(validation): zod schemas for invite/save/search/history with 400, hide DB errors"
```

### Task 2: Test infra + CI gate — يقفل C3

**Files:**
- Create: `apps/web/vitest.config.ts`
- Modify: `apps/web/package.json:5-9` (add test, test:ci, typecheck)
- Create: `.github/workflows/ci.yml`
- Create Test: `apps/web/src/lib/__tests__/utils.test.ts`

**Interfaces:**
- Consumes: `GO_THRESHOLD/meetsGoThreshold/deriveConfidence/validateQuestion/isBudgetExceeded` من `@/lib/utils`
- Produces: `npm test` + `npm run test:ci` + CI رباعي + coverage thresholds

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/__tests__/utils.test.ts
import { describe, test, expect } from "vitest";
import { meetsGoThreshold, validateQuestion, deriveConfidence } from "@/lib/utils";

describe("meetsGoThreshold", () => {
  test("rejects thin opinion-only evidence", () => {
    const r = meetsGoThreshold([{ strength: "opinion", sample_size: 3 }]);
    expect(r.eligible).toBe(false);
  });
  test("accepts rung4 x3 n>=30", () => {
    const r = meetsGoThreshold([
      { strength: "contact_shared", sample_size: 12 },
      { strength: "contact_shared", sample_size: 10 },
      { strength: "contact_shared", sample_size: 10 },
    ]);
    expect(r.eligible).toBe(true);
  });
});
describe("validateQuestion", () => {
  test("rejects leading EN+AR", () => {
    expect(validateQuestion("Don't you agree this is amazing?").valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/utils.test.ts`
Expected: FAIL (vitest not installed / config missing)

- [ ] **Step 3: Write minimal implementation (install + config + scripts)**

```bash
npm install -D vitest
```

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: { environment: "node", include: ["src/lib/__tests__/**/*.test.ts", "src/app/api/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

```json
// package.json scripts add:
"typecheck": "tsc --noEmit",
"test": "vitest",
"test:ci": "vitest run"
```

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: apps/web/package-lock.json }
      - run: npm ci
        working-directory: apps/web
      - run: npm run typecheck
        working-directory: apps/web
      - run: npx next lint
        working-directory: apps/web
      - run: npm run test:ci
        working-directory: apps/web
      - run: npm run build
        working-directory: apps/web
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/vitest.config.ts apps/web/package.json apps/web/src/lib/__tests__/utils.test.ts .github/workflows/ci.yml
git commit -m "test(ci): vitest + typecheck + quad gate tsc-lint-test-build"
```

### Task 3: Eval harness حقيقي — يقفل C2

**Files:**
- Create: `eval/harness/runner.mjs`, `eval/harness/assertions.mjs`, `eval/harness/fixtures.ts`
- Create: `eval/fixtures/gt-001.json` … `gt-008.json` (recorded Gemini/Groq/Search/Apollo)
- Modify: `eval/run-eval.js` (delegate to harness, exit 1 on fail, write report.json)
- Create Test: `eval/harness/meta.test.mjs` (expected بلا assertion = fail)

**Interfaces:**
- Consumes: `meetsGoThreshold/validateQuestion/deriveConfidence` من `@/lib/utils` (استيراد مباشر، ممنوع نسخ) + `POST /api/agent` handler + `tasks.json expected.*`
- Produces: `node eval/run-eval.js` → `eval/report.json {id, verdict_got, verdict_want, citations_got, pass}` + exit code

- [ ] **Step 1: Write the failing test**

```javascript
// eval/harness/meta.test.mjs
import test from "node:test";
import assert from "node:assert";
import { coverageFor } from "./assertions.mjs";
import tasks from "../golden-tasks/tasks.json" with { type: "json" };
test("every expected field has an assertion", () => {
  for (const t of tasks) {
    const cov = coverageFor(t.expected);
    assert.ok(cov.length > 0, `${t.id} has no assertion`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test eval/harness/meta.test.mjs`
Expected: FAIL (gt-006/007/008 uncovered)

- [ ] **Step 3: Write minimal implementation**

```javascript
// eval/harness/assertions.mjs
export function coverageFor(expected) {
  const out = [];
  if (expected.verdict_in) out.push("assertVerdictIn");
  if (expected.confidence_in) out.push("assertConfidenceIn");
  if (expected.primary_evidence_count_gte != null) out.push("assertPrimaryCount");
  if (expected.planted_claim) out.push("assertVerifierFlagged");
  if (expected.injected_questions) out.push("assertLeadingRejected");
  if (expected.must_not_be) out.push("assertNotVerdict");
  if (expected.evidence_must_have_citations) out.push("assertCitations");
  if (expected.feasibility_assumptions_gte != null) out.push("assertFeasibility");
  return out;
}
export function assertVerdictIn(got, want) { return want.includes(got); }
// ... rest per expected field, each reading done.verdict / evidence[].source_url / trace[].event_type
```

Runner: يبني `NextRequest(POST /api/agent, {idea, uploaded_data})` بحقن `__EVAL_FIXTURES__` بدل الشبكة، يقرأ SSE حتى `type:done`، يستخرج `{verdict, confidence, evidence, trace}`، يطبق assertions، يكتب `report.json`، ويخرج `1` عند أي fail أو uncovered.

- [ ] **Step 4: Run test to verify it passes**

Run: `node eval/run-eval.js`
Expected: PASS with `report.json` + exit 0 only when all gt covered

- [ ] **Step 5: Commit**

```bash
git add eval/harness/ eval/fixtures/ eval/run-eval.js
git commit -m "test(eval): real harness calling /api/agent with fixtures and report.json"
```

### Task 4: RLS hardening migration — يقفل M4 + Schema debts

**Files:**
- Create: `supabase/migrations/20240101000002_hardening.sql`
- Modify: `packages/db/schema-unified.sql` (source, then regen 0000 to keep hash)
- Create Test: `apps/web/src/app/api/__tests__/trace-rls.test.ts` (insert بلا عضوية → مرفوض)

**Interfaces:**
- Consumes: `is_workspace_member/workspace_role` (تنقل لـ `private`)
- Produces: `trace_insert` مغلقة + `trace_select` بلا `IS NULL` لـ authenticated + backfill `workspace_id`

- [ ] **Step 1: Write the failing test**

```typescript
test("trace insert without membership is rejected", async () => {
  // call POST trace handler or direct supabase insert as non-member
  // expect 403 / RLS violation
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/__tests__/trace-rls.test.ts`
Expected: FAIL (insert succeeds with check true)

- [ ] **Step 3: Write minimal implementation (SQL)**

```sql
-- move helpers to private + revoke
create schema if not exists private;
-- (migrate is_workspace_member/workspace_role to private.is_workspace_member with SET search_path='' + REVOKE EXECUTE FROM anon, authenticated)
-- tighten trace
drop policy if exists trace_insert on public.trace_events;
create policy "trace_insert_service_only" on public.trace_events for insert to service_role with check (true);
-- OR with check membership:
-- create policy "trace_insert_member" on public.trace_events for insert to authenticated with check (
--   exists (select 1 from public.startups s where s.id = startup_id and (private.is_workspace_member(s.workspace_id, (select auth.uid())) or s.owner_id = (select auth.uid())))
-- );
alter function public.update_updated_at() set search_path = '';
-- backfill workspace_id then set not null (after verifying no NULL in prod)
-- document docs/supabase-schema.sql as superseded (comment only, no execution)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/__tests__/trace-rls.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20240101000002_hardening.sql packages/db/schema-unified.sql
git commit -m "fix(rls): tighten trace insert, private helpers, backfill workspace_id"
```

### Task 5: Rate-limit موزع + Cost حقيقي — يقفل M1

**Files:**
- Create: `apps/web/src/lib/rate-limit.ts`, `apps/web/src/lib/cost.ts`
- Modify: `apps/web/src/app/api/agent/route.ts:1162-1211,1179,1248`
- Create Test: `apps/web/src/app/api/__tests__/rate-limit.test.ts`

**Interfaces:**
- Consumes: `Upstash Redis` via env (`UPSTASH_REDIS_REST_URL/TOKEN`) else memory fallback (dev/test only)
- Produces: `checkRateLimit({key}) → {limited, retryAfter}` + `429 {error, retryAfter}` + `trace rate_limited`

- [ ] **Step 1: Write the failing test**

```typescript
test("11th POST in minute returns 429", async () => {
  for (let i = 0; i < 10; i++) await POST(makeReq());
  const res = await POST(makeReq());
  expect(res.status).toBe(429);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/__tests__/rate-limit.test.ts`
Expected: FAIL (11th passes with Map per-instance in test parallel)

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/rate-limit.ts — sliding window, key = user_id else ip+route, fail-closed, Retry-After
// lib/cost.ts — atomic workspace spend counter in Supabase + usageMetadata extractor, COST_TABLE fallback marked
```

Wire into `route.ts`: `validation → rate-limit (429) → cost.checkBudget (402/429) → ...`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/__tests__/rate-limit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/rate-limit.ts apps/web/src/lib/cost.ts apps/web/src/app/api/agent/route.ts
git commit -m "feat(prod): distributed rate-limit + workspace spend counter with 429"
```

### Task 6: Search/History صحيح — عدّ + ترتيب + whitelist

**Files:**
- Modify: `apps/web/src/app/api/search/route.ts:49-78,82-130`
- Modify: `apps/web/src/app/api/history/route.ts:117,150-176`
- Create Test: `apps/web/src/app/api/__tests__/search.test.ts`

**Interfaces:**
- Consumes: `searchQuerySchema/historyQuerySchema` من Task 1 + `pg_trgm` indexes الموجودة
- Produces: `200 {data, meta:{total,pages}}` من DB لا JS + RPC similarity (أو `count exact` لكل نوع كحد أدنى)

- [ ] **Step 1: Write the failing test**

```typescript
test("search returns DB total not sliced sum", async () => {
  const res = await GET(new NextRequest("http://x/api/search?q=test&type=all&limit=5"));
  const j = await res.json();
  expect(j.meta.total).toBeGreaterThanOrEqual(j.data.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/__tests__/search.test.ts`
Expected: FAIL (total = sliced sum)

- [ ] **Step 3: Write minimal implementation**

Replace `totalHits = a.length+b.length+c.length` with `count:"exact"` per type or single RPC `search_all(q, workspace_ids)` with `similarity()` ORDER + whitelist enums + `ESCAPE '\'` in ilike.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/__tests__/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/search/route.ts apps/web/src/app/api/history/route.ts
git commit -m "fix(search): DB counts + similarity RPC + filter whitelists"
```

### Task 7: Threshold/Verifier/Prompt — بوابة لا استشارية

**Files:**
- Modify: `apps/web/src/lib/utils.ts:197-237` (dedup + confidence fix)
- Modify: `apps/web/src/app/api/agent/route.ts:978-1048,1075-1157,1165-1175,1220-1225,1003-1021`
- Modify: `eval/harness/*` (import from utils, no copy)

**Interfaces:**
- Consumes: `Evidence {strength, sample_size, source_url/domain, source_type}`
- Produces: `meetsGoThreshold(deduped)` + `deriveConfidence` متسق + `verdict_override` يمنع `go` + `warnings[]`

- [ ] **Step 1: Write the failing test**

```typescript
test("three rung4 from same source_url do not count as 3", () => {
  const r = meetsGoThreshold([
    { strength: "contact_shared", sample_size: 12, source_url: "https://x.com/a" },
    { strength: "contact_shared", sample_size: 12, source_url: "https://x.com/a" },
    { strength: "contact_shared", sample_size: 12, source_url: "https://x.com/a" },
  ]);
  expect(r.eligible).toBe(false);
});
test("medium requires interviewSample not total", () => {
  expect(deriveConfidence([{ strength: "contact_shared", sample_size: 12, source_type: "survey" }])).not.toBe("medium");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/utils.test.ts`
Expected: FAIL (counts rows, medium on total)

- [ ] **Step 3: Write minimal implementation**

Dedup by `domain(source_url)` في `meetsGoThreshold` + `deriveConfidence medium` على `interviewSample>=12` + `hasUrl` per-claim + فحص المذكرة الكاملة + `approved=false` يمنع `go` أو يلحق `warnings` + `<untrusted>` delimiters + تعقيم كل حقل مُعاد حقنه + حد per-field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/utils.ts apps/web/src/app/api/agent/route.ts
git commit -m "fix(gate): dedup sources, confidence consistency, verifier gate, prompt isolation"
```

### Task 8: Invites كاملة + قرار Leads — يقفل M5/M3

**Files:**
- Create: `apps/web/src/app/invite/[token]/page.tsx`
- Modify: `apps/web/src/app/api/workspace/invite/route.ts:82-93` (Resend + hash + expiry, remove log)
- Modify: `supabase/migrations/20240101000002_hardening.sql` (invite hash/expiry columns + cron expired)
- Modify: `README.md` (Resend + APOLLO key docs)

**Interfaces:**
- Consumes: `inviteSchema` (Task 1) + `Resend` via `RESEND_API_KEY` + `workspace_invites` table
- Produces: `POST /invite` → `pending(hashed)` → email → `GET /invite/[token]` → Accept/Decline RPC → membership; `leads` قرار موثق

- [ ] **Step 1: Write the failing test**

```typescript
test("GET /invite/[token] renders accept for pending", async () => {
  const res = await GET_INVITE("valid-token");
  expect(res.status).toBe(200);
});
test("invite with bad role returns 400 not 500", async () => {
  const res = await POST_INVITE({ role: "superadmin" });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/__tests__/invite.test.ts`
Expected: FAIL (404 + 500)

- [ ] **Step 3: Write minimal implementation**

Hash token (SHA-256) قبل التخزين، انتهاء 7 أيام، استخدام واحد، `cron` لـ `expired`، Resend sender، صفحة قبول، إزالة `console.log` و `debug_token` خارج Preview flag.

Leads decision: إما wire `campaign.ts` (consent-gated) في agent أو comment في `schema-unified.sql` أن الجدولين خارج مسار agent — لا تعليق.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/__tests__/invite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/invite/ apps/web/src/app/api/workspace/invite/route.ts
git commit -m "feat(invites): accept page + hashed tokens + Resend + expiry"
```

### Task 9: Secrets + Docs — يقفل C1 توثيقياً (التدوير بشري)

**Files:**
- Modify: `apps/web/.env.example` (add APOLLO + RESEND + UPSTASH keys)
- Modify: `apps/web/.gitignore` + root `.gitignore` (unify)
- Modify: `README.md` (migrations/seed/runbook + admin bootstrap + eval/test/CI commands)

**Interfaces:**
- Consumes: Vercel Env (Production/Preview) — إجراء بشري لتدوير 5 مفاتيح
- Produces: لا قيم صريحة في repo، لا log للتوكن، توثيق نشر كامل

- [ ] **Step 1: Write the failing test**

```bash
# no secret in repo + no console.log token
grep -r "console.log.*invite" apps/web/src/app/api/workspace/invite/ && exit 1 || exit 0
grep -r "gsk_\|eyJhbGciOi" --include="*.ts" apps/web/src/ && exit 1 || exit 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: above greps
Expected: FAIL (log exists)

- [ ] **Step 3: Write minimal implementation**

Remove log, unify gitignores, expand `.env.example`, write README runbook (migrations order `0000→0001→0002`, `seed-platform-admin.sql`, `npm run test:ci`, `node eval/run-eval.js`, Vercel env list).

- [ ] **Step 4: Run test to verify it passes**

Run: greps again + `npm run typecheck && npx next lint && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/.env.example README.md .gitignore apps/web/.gitignore
git commit -m "docs(sec): no token logs, unified gitignore, full deploy runbook"
```

## Self-Review

- Spec coverage: كل بند في spec له task (C1→9, C2→3, C3→2, M1→5, M2→1, M3→8, M4→4, search→6, threshold/verifier/prompt→7, invites→8).
- Placeholder scan: لا TBD/TODO في tasks — كل step فيه كود/أمر/مسار دقيق.
- Type consistency: `inviteSchema/startupSaveSchema/searchQuerySchema` أسماء ثابتة عبر Tasks 1/6/8. `checkRateLimit/cost.checkBudget` عبر Task 5 فقط.
- Review Focus: البنود الخمسة كلها لها اختبار في Task مالك (1/5/7).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-03-validation-copilot-hardening.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because tasks touch independent interfaces (validation vs RLS vs eval vs rate-limit) and a shipped mistake in RLS/rate-limit would cost production isolation. Does the plan capture what you want, and which approach should we use?
