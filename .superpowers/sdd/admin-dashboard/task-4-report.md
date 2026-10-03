# Task 4 report — Admin API workspaces + content

## Status: complete

TDD red→green; `tsc` clean; eval 8/8; migration object check passes.

Route paths follow the Task 4 worker brief (which supersedes the plan file's
older `content/route.ts` + `content/[id]/flag` layout): six routes under
`workspaces/` and `content/{startups,flag,screen,details}`.

## Files

- Modified: `packages/db/admin-migration.sql`
  - `workspaces.status` (`active`/`suspended`, default `active`) — additive
    `ADD COLUMN IF NOT EXISTS` (plans stay a separate entitlement column).
  - `admin_action`: new `flag_startup`, `screen_decision`, `update_workspace`
    branches. All insert the audit row first and all denies RETURN
    `{ok:false}` with a committed `denied` trail (no RAISE, I2 pattern).
    New deny codes documented in-file: `startup_not_found`,
    `invalid_startup_id`, `invalid_flag`, `invalid_decision`,
    `invalid_confidence`, `workspace_id_required`, `workspace_not_found`,
    `invalid_plan`, `invalid_status`, `invalid_payload`.
  - Rank rules in-RPC: flag needs member+ (rank ≥ 2, viewer denied);
    screen needs admin/owner (rank ≥ 3, members read-only); update_workspace
    is platform-tier only (spec I1 — plans read-only in v1 for workspace
    tier). NULL-workspace startups: flag platform-only, screen denied
    (`invalid_workspace_id`). Screen approve→`go` / reject→`stop` inserts a
    `decisions` row; the audit row is re-attributed to the startup's
    workspace so workspace-tier audit reads stay scoped.
- Created: `apps/web/src/app/api/admin/workspaces/route.ts` — GET with
  plan/status/q/sort(plan allowlist name/created_at/plan)/pagination filters
  plus per-workspace totals (members, startups, runs, evidence, spend
  `{value, estimated:true}`); batched metrics via service-role strictly
  filtered to the page's own ids (`.in('workspace_id', pageIds)`).
- Created: `.../workspaces/[id]/route.ts` — GET workspace + members (with
  profile emails, in-scope only) + metrics; PATCH plan/status via
  `admin_action`/`update_workspace` (platform-only, 403 fast guard +
  RPC deny trail).
- Created: `.../content/startups/route.ts` — GET flagged-first default
  ordering, flagged/verdict/confidence filters, full-text q over startup
  name/one_liner/domain + evidence claims + lead emails (canonical escaper,
  never raw interpolation), paginated with totals. Verdict/confidence =
  ANY-decision-matches semantic (documented). q+verdict combined resolves to
  an exact AND id set (extra id-resolution query, no ilike bypass).
  Workspace tier: data via user client + scopedQuery; total via
  scope-filtered service-role count (number only — Task-3 users-route
  pattern).
- Created: `.../content/flag/route.ts` — POST `{startup_id, flagged}`
  via `flag_startup` RPC; route-level ROLE_RANK member+ guard.
- Created: `.../content/screen/route.ts` — POST
  `{startup_id, decision: approve|reject, confidence?, rationale?}` via
  `screen_decision` RPC; route-level ROLE_RANK admin+ guard;
  NULL-workspace rejected at the route (400) and in the RPC.
- Created: `.../content/details/route.ts` — GET `?startup_id=` returning
  startup + assumptions + evidence + decisions + traces; both tiers via
  scopedQuery (workspace tier user client, platform service-role with
  NULL-workspace exclusion on child reads; out-of-scope → 404, no leak).

Every route starts with `requireAdminFromSupabase()` and uses the
admin-only `{error,code}` envelope via `toEnvelope()`. Privileged mutations
(flag/screen/plan/status) are RPC-only — no direct writes, no `audit()`
warn-continue on those paths. Viewers get NONE (rejected at the
requireAdmin gate; rank guards re-deny in route + RPC).

## Tests

- TDD check `task4-check.ts` (requireAdmin 401 stub + 6 route existence +
  per-route gate/envelope/scope/hygiene + 3 RPC branches + ROLE_RANK):
  18 FAILURES before (RED), ALL PASS after (GREEN).
- `tsc --noEmit --skipLibCheck -p tsconfig.json` in `apps/web`: zero errors
  (one TS7006 implicit-any on first pass from untyped service-client data;
  fixed via an `asRows` narrowing helper).
- `node eval/run-eval.js`: 8 PASSED / 0 FAILED.
- Migration object check (Task-1 objects + `flag_startup`,
  `screen_decision`, `update_workspace`, `status`): passes.
- Grep audit of new routes: no `: any`/`as any`, no `demo-user`.

## Concerns

1. Sub-query caps (v1): text-match id resolution caps at 2000 rows/table,
   decision filter at 5000, metrics batching at 5–10k rows. Large
   deployments will truncate queue results/totals — needs keyset or
   server-side FTS before scale.
2. Screen = member-read-only is an interpretation: spec §7 gives members
   flag/unflag but says nothing about approve/reject decisions, and the
   brief's matrix line reads "admin/owner + member-read". Decisions are
   privileged writes, so admin+ was chosen; easy to relax to member+ if the
   owner wants it.
3. PATCH workspaces is platform-only (spec I1). Workspace admins cannot
   change plan/status even for their own workspace — confirm this is the
   intended v1 posture.
4. Suspend-style split commit applies to screen: the decision row commits
   in the RPC; there is no second system here (unlike Auth ban), so no
   orphan risk — strictly cleaner than Task 3 suspend.
5. Lead emails are used only as id constraints for text search, never
   returned; workspace-tier lead matches are re-filtered by the scoped
   final query, so no cross-workspace PII leaks. Full `leads` table is not
   exposed in details (graph is startup/assumptions/evidence/decisions/
   traces per brief).

## Fix round 1/5 (2026-09-27) — I1 + I3 in `workspaces/[id]/route.ts`

- I1 (cross-tenant profiles read): GET no longer service-reads
  `profiles.select("user_id,email").limit(5000)` + JS-filters. Members are
  fetched first (`.eq("workspace_id", id)`), then profile emails via
  `.in("user_id", chunk)` chunked at 200 (empty-member short-circuit, no
  query). Response shape identical (`members[].email`, metrics unchanged).
- I3 (missing denied trail): PATCH workspace-tier no longer returns the
  403 fast-guard before the RPC. Body is parsed first; non-platform
  callers route through `admin_action`/`update_workspace` from the user
  client (RPC commits the `denied`/`forbidden` trail per spec §6), then
  the route returns the stable 403 envelope
  (`Workspace plan/status is platform-managed` / `FORBIDDEN`). Platform
  path unchanged (validation → user-client RPC, codes via
  `rpcDenyToStatus`).

Covering checks (all pass):

- Profiles IN-filter grep: `.in("user_id", chunk)` present; no
  `profiles … limit(5000)` full-table read remains in the file.
- PATCH RPC-trail grep: `trailClient.rpc("admin_action", …)` present in
  the non-platform branch ahead of the 403 return; platform
  `userClient.rpc("admin_action", …)` path untouched.
- `node eval/run-eval.js`: 8 PASSED / 0 FAILED.
- `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck
  -p tsconfig.json` in `apps/web`: clean (exit 0).
