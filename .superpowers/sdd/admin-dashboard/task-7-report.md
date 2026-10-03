# Task 7 Report — Admin UI: workspaces + content + analytics + ops

Date: 2026-09-27 · Implementer: Task 7 worker (no subagents, no commits)

## Status: DONE

All Task 7 deliverables implemented; `tsc --noEmit --skipLibCheck -p tsconfig.json`
in `apps/web` exits 0; `node eval/run-eval.js` is 8/8 PASSED.

## Files changed

**New pages (server-first, Server Components calling `/api/admin/*` via `adminApiFetch`):**

- `apps/web/src/app/admin/workspaces/page.tsx` — directory with plan
  (read-only + "v1 read-only" note, spec I1), status, usage
  (members/startups/runs/evidence/estimated spend), plan+status GET filters,
  `AdminTable` q/sort/paginate (allowlist name/created_at/plan), row links to
  detail, `WorkspaceSwitcher` island in the toolbar.
- `apps/web/src/app/admin/workspaces/[id]/page.tsx` — facts (plan shown
  read-only), metric `KpiCard`s (spend `estimated`), member roster,
  `WorkspacePlanForm` rendered **only when `/api/admin/me` reports the
  platform tier** (workspace tier sees a read-only note; PATCH would 403
  anyway), sibling `WorkspaceSwitcher` (auxiliary fetch, never fails page).
- `apps/web/src/app/admin/content/page.tsx` — review queue over
  `GET /api/admin/content/startups` (flagged/verdict/confidence/q filters,
  sort allowlist created_at/name/flagged, bespoke header sort links +
  pagination preserving filters), `ContentActions` per row (flag/unflag +
  screen approve→go / reject→stop with confidence + rationale),
  `?startup_id=` evidence-inspection panel
  (`GET /api/admin/content/details`: decisions + first-10 evidence claims;
  same panel linked as run-detail from the ops audit table).
- `apps/web/src/app/admin/analytics/page.tsx` — `?window=7d|30d|90d` presets,
  KPI cards (runs, signups, cost/run `estimated`, unsupported-claim rate,
  truncation warning), inline SVG runs/day bars + verdict distribution bars
  (no chart lib), experiments table + full-CSV anchor,
  `AnalyticsAutoRefresh` + `ReportGenerator` islands.
- `apps/web/src/app/admin/ops/page.tsx` — severity cards from
  `GET /api/admin/ops/limits` (error/warning/info, 429 heuristic, configured
  caps, top error actors, truncation note); audit-log table from
  `GET /api/admin/ops/audit` (actor/action exact-match GET form, pagination)
  with derived severity badges + run-detail links
  (`target.startup_id` → `/admin/content?startup_id=…`,
  `target.workspace_id`/row `workspace_id` → workspace detail); agent
  settings read-only table (`GET /api/admin/agent`, key/value/updated_at —
  **no write path exists in v1, labeled as such**); pending-invite queue
  (`GET /api/admin/ops/email`, tokens never selected) with
  `EmailResendButton` rendered **platform-tier only**.

**New client islands (justified: need browser state / timers / downloads):**

- `components/admin/WorkspaceSwitcher.tsx` — select → `router.push` to
  workspace detail; options arrive as server props (already tier-scoped).
- `components/admin/WorkspacePlanForm.tsx` — platform-only PATCH plan/status
  + reason; denials surface as messages.
- `components/admin/ContentActions.tsx` — flag toggle + screen
  approve/reject + confidence/rationale; API denials surface as messages.
- `components/admin/AnalyticsAutoRefresh.tsx` — `router.refresh()` every 60s,
  paused while `document.hidden` (visibilitychange), last-updated label.
- `components/admin/ReportGenerator.tsx` — composes same-origin experiments
  CSV download URL from sort/order (CSV rendered server-side, RFC 4180).
- `components/admin/EmailResendButton.tsx` — platform-only POST resend.

**Carried-over Task 6 items (all done):**

- `app/admin/layout.tsx` — all six nav entries live (no `ready`/`soon`
  states); tier now comes from `GET /api/admin/me` via `adminApiFetch`
  (redirect-rethrow on redirect errors, `redirect("/login")` otherwise);
  Ops stays `platformOnly`.
- `app/admin/users/page.tsx` — Created column is now sortable (`created_at`
  key, matching the API allowlist); page also fetches the workspace list
  (limit 100, auxiliary — 401 redirects rethrown, other failures degrade)
  and passes it to `UserActions`.
- `components/admin/UserActions.tsx` — role editor uses a workspace
  `<select>` picker when the list is non-empty, raw-ID textbox only as
  fallback.

## Role-based visibility (spec §7)

- Ops nav hidden for workspace tier (layout); direct-URL workspace-tier
  visitors get a scoped read-only ops view (own-workspace audit/severity,
  settings read-only, queue visible, resend withheld) with an explanatory
  subtitle. Platform grants UI omitted — **no `/api/admin/ops/admins`
  route exists in the built Task 4–5 API** (workspace role grant/revoke
  lives on the Users page via PATCH/DELETE `/api/admin/users/[id]`).
- Workspace detail plan/status form + invite resend: platform-only.
- Content screen (approve/reject): rendered for all admin tiers;
  admin/owner enforcement is API-side (denials surface + audit-logged).

## Tests / verification

- `tsc --noEmit --skipLibCheck -p tsconfig.json` (apps/web): exit 0, zero errors.
- `node eval/run-eval.js`: **8 PASSED / 0 FAILED**.
- No `any`, no client-side Supabase reads, no secrets in browser code;
  every `adminApiFetch` catch rethrows redirect errors
  (`isRedirectError` from `next/dist/client/components/redirect-error`,
  accepted Task 6 ruling).

## Concerns / follow-ups for the controller

1. **Screen-button visibility is API-enforced, not role-hidden** for the
   workspace tier (member vs admin/owner per-workspace role isn't exposed
   by `GET /api/admin/me`, which returns `{ tier }` only; extending it is
   Task 6/8 territory — not touched to avoid cross-task API drift).
2. **No platform-admin grant/revoke UI**: backend route doesn't exist
   (plan Task 5 named `/api/admin/ops/admins`, but the built API has only
   `ops/audit`, `ops/limits`, `ops/email`). If grants UI is required, it
   needs a Task 5 API addendum first.
3. **Settings editor is read-only**: no PUT route exists in the built API
   (`GET /api/admin/agent` only), so the ops page labels settings
   "read-only in v1" per the actual contract rather than the plan's
   write-time-validation sketch.
4. `AdminTable`'s search form drops bespoke extra filters on submit, so
   workspaces/content/ops use their own GET filter forms (preserving
   q/sort/order/limit as hidden inputs where applicable) — intended.
5. `WorkspaceSwitcher` options cap at 100 (page `limit=100`); platform
   installations with more workspaces will need a searchable switcher
   (noted, not built — YAGNI for v1).

## Fix round 1/5 (Task 7 review C1 + I1) — 2026-09-27

**C1 — platform-grant management (Task-5 addendum), all three parts done:**

1. `packages/db/admin-migration.sql` — VERIFIED, no edit needed: the
   `grant_platform` branch (line 345: platform-only `forbidden` deny,
   `user_id_required` shape deny, `on conflict do nothing` insert) and
   the `revoke_platform` branch (line 360: platform-only deny,
   `FOR UPDATE` row lock + membership check → `membership_not_found`,
   count guard + post-delete restore guard → `last_platform_admin`)
   already match the required contract — denied trails commit via
   `UPDATE audit_log SET result='denied'` + `RETURN {ok:false}` with NO
   RAISE, following the existing branch style. Grant needs no lock
   (insert-only, conflict-safe); revoke carries the TOCTOU locks.
2. NEW `apps/web/src/app/api/admin/ops/admins/route.ts` — GET platform
   list (service-role `platform_admins` + `profiles` emails, never a
   cross-tenant unfiltered read) + POST grant (`{user_id, reason?}`,
   target existence checked via `auth.admin.getUserById` → 404 before
   the RPC) + DELETE revoke (body `{user_id}` or `?user_id=`).
   All three start with `requireAdminFromSupabase()` and are
   platform-only: workspace-tier callers run the RPC deny trail via the
   user client FIRST (GET trails `grant_platform/{}` → `forbidden`;
   POST/DELETE trail with the real target), then get the stable 403
   `{error, code: "FORBIDDEN"}` envelope (Task-4 PATCH pattern).
   RPC denies map via `rpcDenyToStatus`: `forbidden`→403,
   `membership_not_found`→404 (`NOT_FOUND`), `last_platform_admin`→409
   (`CONFLICT`), shape/`unknown_action`→400. Success: `{ok:true,
   granted|revoked}`.
3. `apps/web/src/app/admin/ops/page.tsx` — platform-only "Platform
   admins" section (list + grant/revoke): server fetches
   `GET /api/admin/ops/admins` ONLY when `tier === "platform"` and the
   whole section renders inside `{tier === "platform" && (...)}`, so it
   is never visible (nor fetched) for the workspace tier. New client
   islands `components/admin/PlatformAdminGrantForm.tsx` (user-ID +
   reason → POST) and
   `components/admin/PlatformAdminRevokeButton.tsx` (per-row DELETE
   behind `window.confirm`; 409 last-admin surfaces as a message).
   Platform subtitle now lists grants.

**I1 — plans read-only in v1 (spec §9 non-goal), UI only:**

- `apps/web/src/app/admin/workspaces/[id]/page.tsx` — `WorkspacePlanForm`
  import + platform-tier conditional REMOVED; plan/status now render as
  a read-only block with the v1 note ("spec §9: no plan changing until
  entitlements are defined"). The now-unused `/api/admin/me` tier fetch
  was removed from this page. API/RPC untouched: `PATCH
  /api/admin/workspaces/[id]` + the `update_workspace` RPC branch stay
  (platform API stays; UI only). `WorkspacePlanForm.tsx` file kept
  (unused, not deleted).
- **T4-I5 sign-off question stays OPEN** (platform plan-enable vs spec
  §9 non-goal) — carried to Task 8 as routed; this round only removes
  the UI write path.

**Covering checks (this round):**

- RPC branches: `when 'grant_platform'` (l.345) + `when
  'revoke_platform'` (l.360) + `last_platform_admin` denies (l.382,
  l.393, l.416) present in `packages/db/admin-migration.sql`.
- Route: `apps/web/src/app/api/admin/ops/admins/route.ts` exports
  GET+POST+DELETE, all gated on `requireAdminFromSupabase()` +
  `admin.tier !== "platform"` deny-trail → 403, `{error, code}`
  envelope throughout.
- UI gating: grants fetch gated on `tier === "platform"` (ops/page
  l.346) + section inside `{tier === "platform" && (...)}` (l.677);
  `[id]/page.tsx` has zero `WorkspacePlanForm` references, carries the
  "read-only in v1" note (l.194).
- `tsc --noEmit --skipLibCheck -p tsconfig.json` (apps/web): exit 0,
  zero errors.
- `node eval/run-eval.js`: **8 PASSED / 0 FAILED**.
