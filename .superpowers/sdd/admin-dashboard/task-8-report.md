# Task 8 report — Seed, access-matrix tests, final verification (2026-09-27)

## Status: DONE

All Task 8 deliverables shipped; `tsc` exit 0; `node eval/run-eval.js` 8/8;
`node eval/admin-access-check.mjs` 93/93 PASS. No subagents. No commits.

## Files

- Created: `scripts/seed-platform-admin.sql` — C1 bootstrap seed (spec §2).
  `INSERT INTO public.platform_admins … SELECT id, id, now() FROM auth.users
  WHERE lower(email) = lower('<BOOTSTRAP_EMAIL>')` + `ON CONFLICT (user_id)
  DO NOTHING` (idempotent re-runs) + trailing verification SELECT (must
  return exactly 1 row; 0 rows = create the Auth user first). Case-insensitive
  by construction (`Admin@X.com` == `admin@x.com`, review-focus pin). No
  hardcoded email — placeholder only, operator substitutes BOOTSTRAP_EMAIL
  per the §10 runbook decision.
- Created: `eval/admin-access-check.mjs` — runnable via plain
  `node eval/admin-access-check.mjs` (no deps), clear PASS/FAIL per check,
  exit 0/1. Sections: [A] all 19 `/api/admin/*` route files exist + start
  with `requireAdminFromSupabase()` + normalize via `toEnvelope()`; [B]
  per-route tier matrix (platform full / workspace scoped+member-read /
  platform-only mutations with denied trails / read-only agent settings);
  [C] logged-out 401 + viewer 403 gate semantics; [D] C1 seed idempotency +
  case-insensitivity + pre-bootstrap 403 + settings no-write-path (no trail
  gap); [E] `{ error, code }` envelope, no `demo-user`, no explicit `any`,
  dead plan-form deletion pinned; [F] LIVE behavioral checks importing the
  real `packages/admin/*` TS modules via a `--experimental-strip-types`
  child process (anon→401, viewer→403, member scoped to own ids only,
  owner/admin/owner tiers, platform full, scopedQuery empty→403 + IN
  predicate, escaper, pagination defaults/clamp — 11 live assertions).
- Deleted: `apps/web/src/components/admin/WorkspacePlanForm.tsx` — unused
  since the Task 7 fix round removed its only render (plan/status UI is
  read-only in v1, spec §9); `tsc` exit 0 confirms zero dangling imports.
- Modified (ONE allowed report mutation, noted inline):
  `.superpowers/sdd/admin-dashboard/task-3-report.md` — the Files bullet and
  Known-limitation #1 that described revoke as "NOT RPC-audit-atomic /
  no RPC branch exists" now record the shipped reality
  (`revoke_membership` RPC branch + route switch from Fix round 1/5); the
  stale text is marked SUPERSEDED and kept for provenance. No other report
  was touched.

## Tests / verification

- `node eval/admin-access-check.mjs`: **93 PASSED / 0 FAILED** (57 gate +
  22 matrix + 5 gate-semantics + 6 bootstrap + 4 hygiene + 11 live, incl.
  sections; two first-pass failures were over-strict assertions in the new
  script itself — screen admin-floor string, audit "stack" comment hit —
  corrected to the shipped contract, code untouched).
- `node eval/run-eval.js`: **8 PASSED / 0 FAILED (100%)**.
- `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck -p tsconfig.json`
  (apps/web): **exit 0, zero errors project-wide** (cleaner than the
  touched-files bar; pre-existing errors cited in earlier reports are gone
  on this tree).
- Greps: no `demo-user`/`demo_user` in admin routes, `packages/admin`,
  `scripts`; no `: any`/`as any` in admin routes or `packages/admin`;
  `GO_THRESHOLD` untouched.

## Concerns / carry-overs

Truncation-flag coverage is complete everywhere EXCEPT overview (see
sign-off item 5). Everything else is owner sign-off material below.

---

## Appendix — Owner sign-off list (all open decisions + recommendations)

### 1. T4-I5 platform plan-enable API — keep platform-only vs revert to 400-per-plan
Shipped: `PATCH /api/admin/workspaces/[id]` + `update_workspace` RPC branch
are platform-only, audit-atomic, deny-trailed; the UI write path was removed
(Task 7 fix — page shows read-only + v1 note). Spec §9 says no plan changing
in v1 until entitlements exist.
**Recommendation: KEEP the platform-only API, keep the UI read-only.**
Rationale: the RPC is the safest possible plan lever (single transaction,
trail, 403 for workspace tier); reverting to a per-plan 400 removes a tested
operator escape hatch for zero spec gain since no human path exposes it.
If strict §9 literalism is required instead, say so and it reverts to
400-per-plan in one small edit.

### 2. T5-I1 S7-strict guards — 3-line member-deny on ops/audit + agent-read
Shipped: `GET ops/audit` and `GET agent` admit workspace member+; row
visibility on audit relies on the Task-1 owner/admin RLS policy (members get
200 with ~zero rows — fail-closed, no leak, but a contract deviation from
spec §7 "Ops: member no access; audit read-only for admin/owner").
**Recommendation: APPLY the 3-line member→403 guard on `GET ops/audit`;
KEEP workspace-tier read on `GET agent`.** Rationale: the audit guard makes
code match spec at zero functional cost (members saw nothing anyway); the
agent settings map is read-only, secret-free, global knobs with no
workspace_id to scope on, and the ops page's read-only settings table relies
on it — denying it buys nothing.

### 3. T7-I2 ops member read (workspace-tier direct-URL ops view)
Shipped: workspace tier visiting `/admin/ops` directly gets a scoped
read-only view; `GET /api/admin/me` returns `{ tier }` only, so the UI
cannot distinguish member from admin/owner per workspace.
**Recommendation: resolve via item 2's API-side deny (authoritative), not via
extending `/me`.** The UI hiding is then cosmetic; a role-aware `/me`
extension is optional polish, not a security need. Pairs with T5-I1 — one
decision covers both.

### 4. T4-I2 leads over-read — startup-join follow-up
Shipped: content text search uses lead emails only as id constraints and the
final queue query re-filters to scoped workspaces (no row/PII leak — lead
emails are never returned), but `leads` has no `workspace_id`, so the match
step itself is not workspace-joined (known over-read: a cross-workspace lead
email match can pull a startup id into the candidate set before scoping).
**Recommendation: ACCEPT v1 posture, schedule the startup-join follow-up**
(filter lead matches by joining `leads.startup_id → startups.workspace_id`
against the scoped id set before use). No data leak exists today; the fix is
match-precision hygiene, not a security hole.

### 5. Truncation-flag coverage status
Shipped: `truncated: true` binds on caps in analytics, experiments, limits,
ops/audit (workspace path), and ops/email. **GAP: overview (`GET
/api/admin/overview`) caps at 10k trace / 5k decision rows with NO
`truncated` flag** (Task-3 concern 3, still open).
**Recommendation: add `truncated` to the overview response in a fast
follow-up** (same one-line pattern as analytics); until then treat overview
KPIs on very large installations as potentially capped. Everything else is
covered.

### 6. `unstable_rethrow` follow-up (Task 6 deep import)
Shipped: admin pages detect redirect errors via
`next/dist/client/components/redirect-error` (deep import) because
`next/navigation` on Next 15.3.3 does not export `isRedirectError`
(TS2305, verified). Works, tsc-clean, but couples to an internal path.
**Recommendation: switch to the public `unstable_rethrow` API from
`next/navigation` in a cleanup pass** (same rethrow semantics, no deep
import). Low risk, no behavior change.

---

## Sign-off item 2 — APPLIED (2026-09-28): S7-strict guard on GET ops/audit

Owner whole-branch sign-off item 2 applied as specified. No subagents. No commits.

### Change
- `apps/web/src/app/api/admin/ops/audit/route.ts:39-44` — added
  `ROLE_RANK` map (`viewer1 member2 admin3 owner4`, mirrors
  `content/screen/route.ts:21-26` rank>=3 style).
- `apps/web/src/app/api/admin/ops/audit/route.ts:103-139` — S7-strict
  guard: workspace tier (`admin.tier !== "platform"`) loads the caller's
  `workspace_members` roles via the user client scoped to
  `admin.workspaceIds` (`.eq("user_id", admin.user.id)` +
  `.in("workspace_id", admin.workspaceIds)`, max-own rank); max rank <
  admin (3) — i.e. role viewer OR member — returns
  `403 { error: "Audit log requires an admin role or higher", code: "FORBIDDEN" }`
  (empty `workspaceIds` also 403s without a DB round-trip; DB errors
  propagate to `toEnvelope()`). Admin/owner + platform paths unchanged
  (platform still full service-role read; eligible workspace reads still
  USER client + `scopedAdminQuery` + RLS). Header comment (`:9-20`)
  rewritten to the S7-strict contract.
- `GET agent` (`apps/web/src/app/api/admin/agent/route.ts`) untouched —
  still workspace-tier member+ readable, verified: no
  `ROLE_RANK`/`FORBIDDEN`/`workspace_members` in that route.
- Envelope `{ error, code }` kept; strict TS, no `any` (guard uses
  `isRecord` + `Array.isArray`, `?? 0` / `?? 3` rank fallbacks).

### Access-check expectations — updated (required by the new 403)
- `eval/admin-access-check.mjs` — extended the EXISTING ops-audit static
  check in place (renamed to `ops audit: S7-strict admin+ only + …` with
  new asserts: `ROLE_RANK["admin"]`, `workspace_members`,
  `Audit log requires an admin role or higher`, `"FORBIDDEN"`); header
  docstring member-read line now reads `ops reads EXCEPT ops/audit which
  is admin/owner-only per spec §7 S7-strict`. Check COUNT UNCHANGED
  (93 total — asserts folded into the existing check, no new check added).

### Checks (2026-09-28, post-change)
- `tsc --noEmit --skipLibCheck -p tsconfig.json` (apps/web): exit 0.
- `node eval/run-eval.js`: 8/8 PASSED.
- `node eval/admin-access-check.mjs`: 93/93 PASSED (incl. updated
  S7-strict ops-audit check + 11 live assertions, count unchanged).

### 7. Seven pre-existing build files + `/login` suspense (left untouched)
Shipped: Task 6 proved webpack compiles with `packages/admin` relative
imports as-is (T2-I2 CLOSED, `next.config.js` byte-identical); full
`next build` stays red SOLELY on pre-existing files (ESLint in
`api/history`, `api/search`, `dashboard/page`, `history/page`,
`app/layout`, `login/page`, `lib/supabase/server`) plus `/login`
`useSearchParams()` without a suspense boundary. Deliberately untouched —
auth-adjacent, out of scope, eval-protecting.
**Recommendation: schedule a dedicated build-hygiene pass** (lint fixes +
suspense boundary). Explicitly NOT folded into this build.

### 8. I5 `settings_change` RPC deferred — no trail gap (confirm)
Shipped: settings UI is read-only — `GET /api/admin/agent` only, no
PUT/POST/PATCH/DELETE export; `admin_action` has no `settings_change`
branch (unknown actions deny as `unknown_action`); migration carries the
ruling note that any future settings write MUST ship validator +
platform-only branch + deny trail together. Pinned by access-check §D.
**Recommendation: CONFIRM accepted — there is no audit-trail gap because
there is no write path to trail.** No action until a settings write is
specced; when it is, the validator ranges (`cap > 0`, timeout 10–300s,
rate 1–1000/min) ship with it per plan Task 5.
