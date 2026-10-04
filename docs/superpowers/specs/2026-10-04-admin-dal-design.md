# Admin Data Access Layer (DAL) — Design

Date: 2026-10-04
Status: approved sections 1-3 in chat, pending written-spec review
Scope: all six `/admin/*` pages + admin layout (single change, single deploy)

## 1. Objective

Cut `/admin/*` page loads from ~3-5s to ~1s by eliminating self-HTTP hops:
each page render performs ONE admin gate plus parallel direct Supabase
reads, instead of 2-6 sequential gated self-HTTP roundtrips.

Success is measured with the same protocol used for the earlier
parallelization fixes (live endpoint table + per-page DOMContentLoaded),
with zero behavior change.

## 2. Background and evidence

- Every `/api/admin/*` endpoint costs ~0.9-1.3s measured live, including
  the trivial `/api/admin/me` (860ms). Query complexity barely matters;
  the cost is the fixed per-request floor: `requireAdmin` gate (Auth
  `getUser` + `is_platform_admin` RPC + memberships) plus self-HTTP.
- Three parallelization fixes shipped (`fb04737`, `8984b98`, `1455a6d`)
  and improved pages ~20-25% (users 4.1s to 3.3s), but cannot break the
  ~1s-per-endpoint floor. Parallelism is exhausted; the remaining fix is
  architectural.
- Client islands use mutations only (POST/DELETE/PATCH), except the
  `ReportGenerator` CSV download link (`GET
  /api/admin/analytics/experiments?format=csv`), which must keep working.

## 3. Approach (selected)

Approach A — server-side Data Access Layer, per the official Next.js
data-security guidance (DAL + `server-only` + React `cache` + minimal
DTOs). Rejected: B (duplicated authorization logic in pages, drift
risk) and C (deleting read routes — wide churn with no threat-model
justification; routes stay secured by the same gate).

## 4. Security core (approved)

1. `apps/web/src/lib/admin-dal.ts` starts with `import "server-only"`.
   Any accidental client import fails the build instead of leaking the
   service-role client. The `server-only` package is added if missing.
2. The gate is wrapped in React `cache()`: `getCachedAdminContext()`
   executes `requireAdminFromSupabase` at most once per request, however
   many DAL functions the layout and page call. `cache()` is scoped to
   the current request only (per React docs); no cross-user leakage.
3. Every DAL function returns minimized DTOs identical in shape to the
   current API JSON (same fields, e.g. agent settings expose
   `key/value/updated_at` only, no secrets).
4. Queries are EXTRACTED, not rewritten: `select` statements, filters,
   and platform-vs-workspace scoping move verbatim from the routes into
   shared helpers imported by both routes and DAL functions. Same lines
   means authorization cannot drift.
5. Fail-closed is preserved: any gate error denies, exactly as today.

## 5. Function map (approved)

| Page | Today (self-HTTP) | DAL |
|---|---|---|
| `admin/layout` | `GET /api/admin/me` | `getCachedAdminContext()` directly (removes one hop from every page) |
| Overview | `GET /api/admin/overview` | `getOverviewDTO()` |
| Users | users list + workspaces picker | `getUsersDTO()` + `getWorkspacesDTO()` concurrently |
| Ops | me + limits + audit + agent + email, then admins (platform only) | `getOpsLimitsDTO()`, `getOpsAuditDTO()`, `getAgentSettingsDTO()`, `getOpsEmailDTO()` concurrently + `getOpsAdminsDTO()` for platform tier only |
| Content | startups list + details (when `?startup_id=`) | `getContentStartupsDTO()` + `getContentDetailsDTO()` concurrently |
| Analytics | analytics snapshot + experiments | `getAnalyticsDTO()` + `getExperimentsDTO()` concurrently |
| Workspaces | list | `getWorkspacesDTO()` (same function feeds the users picker — one source) |
| Workspaces `[id]` | detail + siblings list | `getWorkspaceDetailDTO()` + `getWorkspacesDTO()` concurrently |

Extraction rules: move, don't rewrite; no route is deleted in this
task (routes keep serving islands and the CSV download); page-side
`narrow*` functions stay untouched — if the shape matches, behavior is
preserved, which is the mechanical no-break check.

Expected result: one gate (~3 Supabase roundtrips, parallelized where
independent) plus parallel reads per page — about 1s instead of 3-5s,
with zero self-HTTP.

## 6. Tests (approved)

1. Parity tests per DAL function: same inputs produce byte-identical
   output shape to the current API responses. Any deviation fails.
2. Authorization tests per function: workspace tier sees only its scope,
   unauthenticated callers are rejected, gate errors fail closed — the
   same cases the route tests cover today.
3. Cached-gate test: two DAL calls in one request execute the gate once
   (spy counter), and contexts never cross users.
4. DTO minimization snapshot: returned fields are pinned; any new
   sensitive field (especially agent settings) fails.
5. Existing guards stay green: full suite (currently 113 tests) + `tsc`
   + `eslint` + `next build` (the build itself proves `server-only`:
   any client leak fails compilation).

## 7. Live verification and rollout (approved)

1. Smoke: login, then render all six pages and compare rows/figures with
   pre-change screenshots.
2. Performance: repeat the endpoint/page timing table; target ~1s pages.
3. Security: logged-out `/admin/users` redirects to `/login`; a
   workspace-tier user never sees platform sections.
4. Rollback: the work ships as one clean commit; any defect reverts with
   a single `revert`.

## 8. Non-goals

- Deleting or restructuring any `/api/admin/*` route.
- Changing the tier matrix, RLS migrations, rate limits, or pricing.
- Fixing Hobby cold starts or Vercel/Supabase region colocation (tracked
  separately; still recommended afterward).
