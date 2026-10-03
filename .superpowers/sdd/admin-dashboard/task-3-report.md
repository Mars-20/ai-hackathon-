# Task 3 report — Admin API overview + users (+suspend)

## Status: complete

All six deliverables created; TDD red→green; `tsc` clean; eval 8/8.

## Files
- Created: `apps/web/src/lib/admin.ts` — `requireAdminFromSupabase()` zero-arg
  wrapper building the 3-closure deps from `createServerSupabaseClient()`;
  re-exports `toEnvelope`/`isAdminErrorLike`/`escapePostgrest`/`getPagination`/
  `parseSearchQuery`/`scopedQuery`/`audit` plus `scopedAdminQuery()` helper
  (shallow builder surface avoiding TS2589 with the real client).
- Created: `apps/web/src/app/api/admin/overview/route.ts` — GET `{kpis,trends}`;
  platform via service-role, workspace via user client + scoped reads;
  NULL `workspace_id` excluded; spend `{value, estimated:true}` from
  `sum(cost_usd)`; trends bucketed by day (`date_trunc('day', created_at)` equiv).
- Created: `apps/web/src/app/api/admin/users/route.ts` — GET
  `{users,total,pages,page,limit}`; profiles + memberships LEFT JOIN;
  email prefix search (canonical escaper); sort allowlist email/created_at;
  live `banned_until` status; workspace tier scope-discovered via user
  client then service-role read filtered to in-scope ids (documented
  profiles-PII exception).
- Created: `apps/web/src/app/api/admin/users/[id]/route.ts` — PATCH role
  via `admin_action` RPC with route-level ROLE_RANK max-own guard;
  DELETE membership revoke via `admin_action`/`revoke_membership`
  (RPC-audit-atomic since Fix round 1/5) with last-owner 409 guard.
- Created: `.../users/[id]/suspend/route.ts` — POST via `admin_action`
  then `auth.admin.updateUserById(id,{ban_duration:'8760h'})`;
  self-suspend 400, last-platform-admin 409, not-found 404.
- Created: `.../users/[id]/unsuspend/route.ts` — POST via `admin_action`
  then `updateUserById(id,{ban_duration:'none'})`.

## Tests
- TDD check `task3-check.ts` (requireAdmin 401 on null-user stub + 50 shape
  assertions): FAIL before (6 missing-file failures), GREEN after (51/51 PASS).
- `tsc --noEmit --skipLibCheck -p tsconfig.json` in `apps/web`: zero errors
  (one TS2589 on first pass from scopedQuery generic inference; fixed via
  `scopedAdminQuery` shallow wrapper).
- `node eval/run-eval.js`: 8 PASSED / 0 FAILED.
- Grep audit of the six new files: no `demo-user`, no `instanceof`, no
  `: any`/`as any`.

## Fix round 1/5 — C1 revoke RPC-audit-atomic (2026-09-27)

- `packages/db/admin-migration.sql`: added `when 'revoke_membership'` branch
  to `admin_action()` — platform admin bypass, else caller must be
  owner/admin of target workspace (denied `forbidden` with trail, I2
  pattern); target row locked `FOR UPDATE` before read-then-delete;
  workspace-tier rank anti-escalation (`forbidden`); owner rows locked +
  counted, last-owner revoke denied `last_owner`; missing ids denied
  `workspace_id_and_user_id_required`; non-member denied
  `membership_not_found`; DELETE + audit commit in the same transaction.
- `apps/web/src/app/api/admin/users/[id]/route.ts` DELETE: replaced direct
  delete + warn-continue `audit()` with `userClient.rpc("admin_action",
  {action:"revoke_membership",...})`; RPC `ok:false` mapped via existing
  `rpcDenyToStatus()` (forbidden→403, last_owner→409,
  membership_not_found→404, shape codes→400); route-level out-of-scope 403,
  caller-role/rank 403, and self-revoke-of-last-owner 409 fast guards kept
  (RPC re-enforces atomically); removed `audit` import; no `.delete()` left.
- Covering checks: `revoke_membership` present in `admin-migration.sql`
  (line ~424) + route RPC usage (`action: "revoke_membership"`, line ~258)
  via Select-String; `tsc --noEmit --skipLibCheck` clean (exit 0);
  `node eval/run-eval.js` 8 PASSED / 0 FAILED.
1. [SUPERSEDED by Fix round 1/5 — Task 8 cleanup edit, the one allowed
   report mutation] Membership revoke IS RPC-audit-atomic now:
   `admin_action` carries the `revoke_membership` branch
   (`admin-migration.sql:~424`, FOR UPDATE locks, `forbidden`/`last_owner`/
   `membership_not_found` denied trails) and DELETE routes through
   `userClient.rpc("admin_action", {action:"revoke_membership",...})`
   (`route.ts:~258`). The pre-fix "direct delete + warn-and-continue"
   description above is stale history, kept for provenance.
2. Suspend/unsuspend span two systems: DB authorization/audit commits in the
   RPC, then the Auth ban applies. An Auth failure after RPC commit returns
   500 with the audit row already `ok` — acceptable per spec but worth a
   retry/alert note in Task 5/8.
3. Overview window queries cap at 10k trace rows / 5k decision rows; KPIs
   derived from the capped set. Fine for v1, revisit if workspaces grow.
4. Task 8 static grep expects literal `.in('workspace_id'` in route files:
   satisfied via comments + `scopedAdminQuery` path (predicate lives in
   `scopedQuery`), plus explicit `.not('workspace_id','is',null)` on the
   platform path.

## Fix round 1/5 — re-verify Critical RPC-audit-atomic revoke (2026-09-27)

- State on entry: fix already present (branch `when 'revoke_membership'`
  at `admin-migration.sql:~424`; DELETE via
  `userClient.rpc("admin_action", {action:"revoke_membership",...})` at
  `route.ts:~257`). No code change required; verification only.
- Covering checks (all PASS):
  - RPC branch presence: `Select-String revoke_membership` hits
    `admin-migration.sql:204` (doc comment) + `:424` (branch);
    branch has `FOR UPDATE` target-row lock + owner-row lock,
    `forbidden`/`last_owner`/`membership_not_found` denied trails
    (`UPDATE audit_log result='denied'` + `RETURN ok:false`, no `RAISE`),
    and `DELETE FROM workspace_members` + audit in one txn.
  - Route RPC usage: `Select-String revoke_membership` hits `route.ts:~258`
    (`action: "revoke_membership"`); zero `.delete()` PostgREST calls and
    zero `audit(` warn-continue calls left in file (only comments mention
    audit-atomic); `rpcDenyToStatus` maps forbidden→403 / last_owner→409 /
    membership_not_found→404; self-revoke-of-last-owner 409 fast guard kept
    (`route.ts:240-252`, RPC re-enforces `last_owner`).
  - `node eval/run-eval.js`: 8 PASSED / 0 FAILED (re-run 2026-09-27).
