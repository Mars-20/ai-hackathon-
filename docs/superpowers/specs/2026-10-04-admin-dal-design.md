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
6. INVIOLABLE two-client pattern: routes that read cross-user data use
   the cookie-scoped user client (RLS) to discover scope FIRST, then the
   service-role client FILTERED to in-scope ids only (e.g. profiles PII
   in the users route). Extraction must preserve this order and the
   filter. A service-role-only "simplification" is forbidden: it would
   silently widen workspace-tier reads to all users' PII.
7. Validation moves WITH the query: sort allowlists, `escapePostgrest`,
   search parsing, pagination caps, and window parsing are part of the
   extracted helper, not left behind in the route. Shared helpers
   validate their inputs independently (defense in depth — the routes
   stay exposed and keep working).
8. DAL error contract (reproduces `adminApiFetch` + layout semantics
   exactly):

   | Situation | DAL behavior | Page/layout behavior |
   |---|---|---|
   | Gate 401 (no user) | throw, then caller redirects | `redirect("/login")` |
   | Gate 403 in layout | throw | `redirect("/login")` (layout redirects on ANY gate error today) |
   | Gate 403 in a page DAL call | throw AdminError(403) | error panel (unreachable in practice: layout gates first) |
   | Data 404 (e.g. unknown workspace id) | throw AdminError(404) | same "not found" panel as today |
   | Data other failure | throw AdminError(status, code, message) | same error panel as today's `AdminApiError` mapping |

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

Deliberate contract addition (blessed in review, pinned by
`admin-queries-ops.test.ts` route↔DAL parity): `GET
/api/admin/ops/limits` returns `meta: { source, readOnly, tier,
fetched_at }` alongside the original body, for parity with the agent
route. Additive only — existing fields are byte-identical.

Expected result: one gate (~3 Supabase roundtrips, parallelized where
independent) plus parallel reads per page — about 1s instead of 3-5s,
with zero self-HTTP.

## 6. Tests (approved, hardened in review round 2)

0. No dead auth plumbing: once the last page stops using them,
   `lib/admin-fetch.ts` (self-HTTP + Bearer forwarding) and
   `lib/admin-page-data.ts` (fetch-based loaders) are DELETED along
   with the loader tests they own. Rationale: dead modules that know
   how to reach admin APIs invite future misuse and confuse readers.
   `tsc` + the suite prove nothing references them. (The dashboard
   Admin link uses a plain client `fetch` to the kept `/api/admin/me`
   route and is unaffected.)
1. Parity tests per DAL function: same inputs produce the same DTO
   body the route returns today (parity is at the DTO-body level for
   success paths, and at the (status, code) level for failure paths per
   the §4 error table — not at the HTTP-response level). Parity holds
   BY CONSTRUCTION wherever route and DAL delegate to the same
   extracted helper; tests then target the helper directly per tier
   plus the DAL wrapper for gate/DTO mapping, with at least one
   delegation test per domain proving route and DAL call the same
   helper with the same arguments. Any deviation fails.
2. Authorization tests per function: workspace tier sees only its scope,
   unauthenticated callers are rejected, gate errors fail closed — the
   same cases the route tests cover today. Mandatory negative PII test:
   a workspace-tier caller must NOT receive out-of-scope users' emails
   (guards the §4 two-client pattern).
3. Cached-gate test: two DAL calls in one request execute the gate once
   (spy counter), and contexts never cross users.
4. DTO minimization snapshot: returned fields are pinned; any new
   sensitive field (especially agent settings) fails.
5. Existing guards stay green: full suite (currently 113 tests) + `tsc`
   + `eslint` + `next build` (the build itself proves `server-only`:
   any client leak fails compilation).
6. Test seams reuse the established pattern: DAL unit tests mock
   `@/lib/supabase/server` (`createServerSupabaseClient`,
   `createServiceRoleClient`) with fake in-memory state, exactly as the
   route tests do today. No live Supabase and no `next/headers`
   `cookies()` inside unit tests — request-scoped dependencies stop at
   the mocked seam.

## 7. Live verification and rollout (approved)

1. Smoke: login, then render all six pages and compare rows/figures with
   pre-change screenshots.
2. Performance (pass/fail, not vibes): repeat the endpoint/page timing
   table against the pre-change baselines (users ~3.3s DOM, ops ~5.1s
   DOM, endpoint floor ~0.9-1.3s). PASS = every admin page renders at
   most 50% of its pre-change DOM time AND no page regresses. If any
   page misses, the task is not done — diagnose before deploying.
3. Security: logged-out `/admin/users` redirects to `/login`; a
   workspace-tier user never sees platform sections.
4. Rollback: the work ships as stacked per-domain commits (one domain
   per commit: users, ops, content, analytics, workspaces, layout),
   each independently green under the §6 guards; a single deploy at
   the end. Rollback reverts the range in reverse order. (This
   supersedes the earlier "one clean commit": same deploy atomicity,
   but reviewable units — reviewability is a security property for a
   change of this sensitivity.)

## 8. Non-goals

- Deleting or restructuring any `/api/admin/*` route.
- Changing the tier matrix, RLS migrations, rate limits, or pricing.
- Fixing Hobby cold starts or Vercel/Supabase region colocation (tracked
  separately; still recommended afterward).

## 9. Advisory notes (do not block planning)

- Freshness equivalence: pages fetch today with `cache: "no-store"`;
  DAL functions use direct Supabase reads (no `fetch`, no cache), and
  cookie usage keeps every admin render dynamic. No caching behavior
  changes.
- Commit sizing: one clean commit preserves single-`revert` rollback.
  If reviewability suffers, stacked per-domain commits under one deploy
  are acceptable as long as every intermediate state passes the §6
  guards.
