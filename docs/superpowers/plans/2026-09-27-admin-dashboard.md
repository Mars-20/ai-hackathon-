# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full admin dashboard (`/admin/*` in `apps/web` + `packages/admin/` + DB migration) per the spec, all five modules, dual-tier access.

**Architecture:** Server-first: admin pages are server components calling `/api/admin/*` routes; every route starts with `requireAdmin()`; workspace-tier reads go through the user client (RLS) or `scopedQuery`; privileged mutations run inside the `admin_action` RPC so audit is atomic.

**Tech Stack:** Next.js 15 (App Router), React 19, Tailwind, Supabase (Postgres + Auth + SSR), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-27-admin-dashboard-design.md`

## Global Constraints

- No `demo-user` strings in production code — real identity from `auth.getUser()` only.
- `GO_THRESHOLD` in `apps/web/src/lib/utils.ts` (`MIN_RUNG 4, MIN_SOURCES 3, MIN_QUANT 30, MIN_INTERVIEWS 12`) is untouched.
- `eval/run-eval.js` must stay 8/8 after every task.
- `tsc --noEmit --skipLibCheck -p tsconfig.json` in `apps/web` must report zero errors in touched files.
- PostgREST user input uses the canonical escaper (no raw `q` interpolation).
- Service-role key never leaves the server; browser code uses `NEXT_PUBLIC_*` vars only.
- No git commits by workers (no repo) — edit files in place.

## Review Focus

- Bootstrap email with different case (`Admin@X.com` vs `admin@x.com`) must still match the seeded platform admin — test pins case-insensitive lookup in the task that owns bootstrap.
- `workspace_id = NULL` legacy rows must never appear in any workspace-tier aggregation — test seeds a NULL row and asserts exclusion in the task that owns overview.
- Settings write with `cap: -5` or `timeout: 99999` must 400 with nothing persisted — test pins validation in the task that owns ops.
- Suspending yourself or the last platform admin must 400/409 with the account unchanged — tests pin both in the task that owns users.
- Audit INSERT failure on a privileged action must fail the mutation (no orphan privileged change) — test pins rollback in the task that owns the RPC.

---

### Task 1: DB migration (tables, helpers, RLS, profiles trigger)

**Files:**
- Create: `packages/db/admin-migration.sql`
- Modify: none (additive-only on top of `packages/db/schema-unified.sql`)

**Interfaces:**
- Consumes: `schema-unified.sql` tables (`workspaces`, `workspace_members`, `startups`, `trace_events`, `decisions`), `handle_new_user()` trigger.
- Produces: `is_platform_admin(uuid) → boolean`, `admin_action(action text, target jsonb, payload jsonb, reason text) → jsonb`, tables `platform_admins`, `audit_log`, `admin_settings`, `profiles`, `startups.flagged`.

**Steps:**

- [ ] **Step 1: Write the migration file** with: `create extension if not exists "pg_trgm"` guard note; `platform_admins(user_id uuid PK references auth.users, granted_by uuid, granted_at timestamptz default now())`; `audit_log(id uuid PK default gen_random_uuid(), actor uuid, action text, target jsonb, reason text, diff jsonb, workspace_id uuid, result text, created_at timestamptz default now())`; `admin_settings(key text PK, value jsonb, updated_by uuid, updated_at timestamptz)`; `profiles(user_id uuid PK references auth.users, email text, created_at timestamptz default now())` + `pg_trgm` index on `profiles(email)`; `alter table startups add column if not exists flagged boolean default false`; extend `handle_new_user()` to also insert `profiles`; `is_platform_admin(p_user uuid)` as `SECURITY DEFINER ... set search_path = ''` returning `exists(select 1 from public.platform_admins where user_id = p_user)`; RLS enable + policies: `platform_admins` select via `is_platform_admin((select auth.uid()))`, no insert/update/delete policies (writes via RPC/service-role only); `audit_log` select for platform full + workspace members on own `workspace_id` rows (`workspace_id in (select workspace_id from workspace_members where user_id = (select auth.uid()))`), insert via RPC only; `admin_settings` select platform-only; `profiles` select own row + platform full; `admin_action` RPC performing `insert into audit_log` then dispatching on `action` (`grant_platform`, `revoke_platform`, `suspend`, `unsuspend`, `role_change`, `plan_note`) and returning the result as jsonb — all in one transaction.

- [ ] **Step 2: Verify SQL parses** — run `node -e "const s=require('fs').readFileSync('packages/db/admin-migration.sql','utf8'); for (const t of ['platform_admins','audit_log','admin_settings','profiles','is_platform_admin','admin_action','flagged']) { if(!s.includes(t)) throw new Error('missing '+t); } console.log('migration contains all objects');"`.
- Expected: prints confirmation.

- [ ] **Step 3: Run eval to prove nothing broke** — run `node eval/run-eval.js`.
- Expected: 8 PASSED / 0 FAILED.

### Task 2: `packages/admin/` foundation + canonical escaper

**Files:**
- Create: `packages/admin/requireAdmin.ts`, `packages/admin/audit.ts`, `packages/admin/scopedQuery.ts`, `packages/admin/escape.ts`, `packages/admin/pagination.ts`, `packages/admin/errors.ts`, `packages/admin/index.ts`
- Modify: `apps/web/src/app/api/history/route.ts`, `apps/web/src/app/api/search/route.ts` (import canonical escaper)

**Interfaces:**
- Consumes: `createServerSupabaseClient`, `createServiceRoleClient` from `@/lib/supabase/server`; `workspace_members`, `platform_admins` tables.
- Produces: `requireAdmin() → Promise<{ user: { id: string; email?: string }; tier: 'platform' | 'workspace'; workspaceIds: string[] }>` (throws `AdminError(401|403)`); `audit(supabase, entry) → Promise<void>`; `scopedQuery<T>(client, table: string, workspaceIds: string[], build: (q) => q) → Promise<T>` (throws 403 on empty `workspaceIds`); `escapePostgrest(s: string) → string`; `getPagination(searchParams) → { page, limit, offset }` (defaults 20/max 100); `AdminError(status, code, message)`; error envelope `{ error, code }` for `/api/admin/*` only.

**Steps:**

- [ ] **Step 1: Write failing check** — create `C:\Users\Marslino\AppData\Local\Temp\opencode\admin-foundation.test.ts`: imports `escapePostgrest` and `getPagination` via `file://` URLs with `--experimental-strip-types`; asserts `escapePostgrest('a,b(c)%_')` contains no raw `,()\%_`; asserts `getPagination({})` gives `{page:1,limit:20}` and `limit:9999` clamps to 100; asserts `scopedQuery` with `[]` throws 403 (pass a stub client — test must FAIL on missing exports).
- Run: `node --experimental-strip-types <file>`.
- Expected: FAIL (modules do not exist).

- [ ] **Step 2: Implement the six modules minimally** — `requireAdmin`: `auth.getUser()` (401 if none) → `is_platform_admin` RPC/select (platform tier, all workspaceIds) else `workspace_members` lookup (workspace tier, own ids; viewers 403; none 403). `audit`: insert into `audit_log` (non-privileged path only; privileged goes through RPC). `scopedQuery`: throw 403 on empty ids, else `.in('workspace_id', ids)`. `escapePostgrest`: escape `\ % _ , ( ) * " [ ]`. `pagination`: page/limit/offset with caps. `errors`: `AdminError` + `toEnvelope()`.

- [ ] **Step 3: Re-run the check** — same command.
- Expected: all PASS.

- [ ] **Step 4: Migrate history/search imports** — replace local `escapePostgrest` definitions with the canonical import; delete duplicates.

- [ ] **Step 5: Verify no regressions** — `node eval/run-eval.js` (8/8) + `tsc` on touched files clean.

### Task 3: Admin API — overview + users (+suspend)

**Files:**
- Create: `apps/web/src/app/api/admin/overview/route.ts`, `apps/web/src/app/api/admin/users/route.ts`, `apps/web/src/app/api/admin/users/[id]/route.ts` (role change, revoke, suspend/unsuspend)
- Test: extend bootstrap check into `eval/admin-access-check.mjs` later (Task 8); here use inline node checks.

**Interfaces:**
- Consumes: `requireAdmin`, `scopedQuery`, `escapePostgrest`, `getPagination` (Task 2); `profiles`, `startups`, `trace_events`, `decisions` tables.
- Produces: `GET /api/admin/overview → { kpis, trends }` (NULL-workspace rows excluded, spend labeled estimated); `GET /api/admin/users → { users, total, pages }` (profiles + memberships, prefix email search, sortable email/created_at); `PATCH /api/admin/users/[id]` (role change with ROLE_RANK anti-escalation, max role = own); `POST /api/admin/users/[id]/suspend` (`ban_duration '8760h'`), `/unsuspend` (`'none'`); self-suspend 400, last-platform-admin 409, all via `admin_action` RPC (audit-atomic).

**Steps:**

- [ ] **Step 1: Write failing access test** — node script asserting `GET /api/admin/overview` without session returns 401-shaped `{ error, code }` (test against route handler with stubbed supabase is complex; instead assert `requireAdmin` throws 401 when `getUser()` returns null — import it and call with a stub). Run, expect FAIL (routes missing).

- [ ] **Step 2: Implement overview route** — `requireAdmin()`; platform: service-role aggregations; workspace: user-client queries + `scopedQuery`; exclude NULL `workspace_id`; `spend` = `sum(cost_usd)` labeled `{ value, estimated: true }`; trends by day (SQL `date_trunc`).

- [ ] **Step 3: Implement users routes** — list from `profiles` + memberships + live `banned_until` status; role change enforces `ROLE_RANK[role] <= ROLE_RANK[caller]`; suspend/unsuspend call `auth.admin.updateUserById` with exact shapes from spec §4; privileged paths via `admin_action` RPC.

- [ ] **Step 4: Run checks** — stub-based 401/403 assertions + `eval/run-eval.js` 8/8 + `tsc` clean.

### Task 4: Admin API — workspaces + content

**Files:**
- Create: `apps/web/src/app/api/admin/workspaces/route.ts`, `apps/web/src/app/api/admin/workspaces/[id]/route.ts`, `apps/web/src/app/api/admin/content/route.ts`, `apps/web/src/app/api/admin/content/[id]/flag/route.ts`

**Interfaces:**
- Consumes: Task 2 helpers; `workspaces`, `workspace_members`, `workspace_invites`, `startups`, `decisions`, `evidence` tables; invite validation shared with `invite/route.ts`.
- Produces: `GET /api/admin/workspaces` (plan read-only, usage: runs/evidence/estimated spend, members, invites); `PATCH` workspaces (no plan change in v1 — 400 if `plan` present); `GET /api/admin/content` (decision queue filterable verdict/confidence, `flagged` filter, evidence included via history-detail pattern); `POST .../flag` (flag/unflag, non-privileged audit warn-and-continue).

**Steps:**

- [ ] **Step 1: Failing test** — node script asserting `PATCH /api/admin/workspaces/x` with `{plan:'pro'}` shape is rejected (import route module? simpler: assert a `PLAN_WRITABLE = false` export exists and route code contains the 400 branch — test must FAIL before implementation).

- [ ] **Step 2: Implement routes** — reuse invite guards (duplicate-409, rank check, 7-day expiry) via extracted shared helper `apps/web/src/lib/invites.ts` (move validation there, keep `invite/route.ts` behavior identical); content queue uses `startups!inner` + DB-side counts; `escapePostgrest` on all `q`.

- [ ] **Step 3: Verify** — node checks + eval 8/8 + tsc clean.

### Task 5: Admin API — analytics + ops (settings, grants, audit)

**Files:**
- Create: `apps/web/src/app/api/admin/analytics/route.ts`, `apps/web/src/app/api/admin/ops/audit/route.ts`, `apps/web/src/app/api/admin/ops/settings/route.ts`, `apps/web/src/app/api/admin/ops/admins/route.ts`

**Interfaces:**
- Consumes: Task 2 helpers; `admin_action` RPC; `admin_settings`, `audit_log`, `platform_admins` tables.
- Produces: `GET /api/admin/analytics` (signups, runs/day, verdict distribution, cost/run estimated, unsupported-claim rate); `GET /api/admin/ops/audit` (actor/action filters, workspace-tier sees own `workspace_id` rows); `GET/PUT /api/admin/ops/settings` (platform-write-only, write-time validation ranges, 400 nothing persisted); `POST/DELETE /api/admin/ops/admins` (grant/revoke via RPC, 403 until bootstrap row exists).

**Steps:**

- [ ] **Step 1: Failing tests** — node script asserting settings validator rejects `{cap:-5}` and `{timeout:99999}` (import validator from route module — FAIL before it exists); asserting grant without bootstrap rejects (documented stub).

- [ ] **Step 2: Implement routes** — settings validation (`cap>0`, `timeout 10–300s`, `rate 1–1000/min`); audit viewer with filters; grants via RPC; all privileged paths audit-atomic.

- [ ] **Step 3: Wire agent runtime read** — modify `apps/web/src/app/api/agent/route.ts` to read settings with 45s TTL cache, fail closed to `BUDGET` + trace warning (minimal diff, cached module-level `{ value, fetchedAt }`).

- [ ] **Step 4: Verify** — node checks + eval 8/8 + tsc clean.

### Task 6: Admin UI — layout + overview + users

**Files:**
- Create: `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/users/page.tsx`, `apps/web/src/components/admin/AdminTable.tsx`, `apps/web/src/components/admin/KpiCard.tsx`

**Interfaces:**
- Consumes: `/api/admin/overview`, `/api/admin/users` (Tasks 3).
- Produces: server-component pages; layout redirects non-admins (UX only); `AdminTable` (sort/paginate/search wiring, defaults page 20/max 100, allowlist per page); suspend/unsuspend confirm dialog + reason field.

**Steps:**

- [ ] **Step 1: Implement layout + shared components** — sidebar nav (Overview, Users, Workspaces, Content, Analytics, Ops; Ops hidden unless platform tier — tier comes from a lightweight `/api/admin/me` route added in this task returning `{ tier }`).

- [ ] **Step 2: Implement overview + users pages** — KPI cards with "estimated" label on spend; users table with actions calling Task 3 routes.

- [ ] **Step 3: Verify** — `tsc` clean; manual route-shape check (fetch shape assertions in node).

### Task 7: Admin UI — workspaces + content + analytics + ops

**Files:**
- Create: `apps/web/src/app/admin/workspaces/page.tsx`, `apps/web/src/app/admin/content/page.tsx`, `apps/web/src/app/admin/analytics/page.tsx`, `apps/web/src/app/admin/ops/page.tsx`

**Interfaces:**
- Consumes: Task 4–5 routes; `AdminTable`, `KpiCard` (Task 6).

**Steps:**

- [ ] **Step 1: Implement the four pages** — workspaces (plan shown read-only with "v1 read-only" note); content (verdict/confidence filters, flag toggle); analytics (charts via simple SVG bars — no new chart lib, YAGNI); ops (audit viewer, settings form with validation messages, grants UI platform-only).

- [ ] **Step 2: Verify** — `tsc` clean on all new files.

### Task 8: Seed, access-matrix tests, final verification

**Files:**
- Create: `eval/admin-access-check.mjs`, `scripts/seed-platform-admin.sql` (the C1 bootstrap SQL with `<BOOTSTRAP_EMAIL>` placeholder)

**Interfaces:**
- Consumes: all Tasks 1–7 routes.

**Steps:**

- [ ] **Step 1: Write the access-matrix script** — for each `/api/admin/*` route path, assert via handler-level stubs: anon 401, viewer 403, workspace-admin scoped (two-workspace seed concept asserted in SQL predicates: every workspace-tier query string contains `.in('workspace_id'` — grep-based static check), platform full. Also: NULL-workspace exclusion check on overview query text; settings validator rejects documented in Task 5.

- [ ] **Step 2: Run everything** — `node eval/admin-access-check.mjs` (all PASS), `node eval/run-eval.js` (8/8), `tsc` clean.

- [ ] **Step 3: Write final report** — append `Admin Dashboard build report` to the plan file region? No — workers report back; controller verifies.
