# Task 6 report — Admin UI: layout + overview + users (2026-09-27)

## Status: DONE (with carried-out build-gate note — see I2 outcome)

## Files created
- `apps/web/src/components/admin/table-helpers.ts` — pure param parsing:
  page default 20 / max 100, `q` min 2 chars, per-page sort allowlist,
  `buildAdminTableQuery` serializer. Dependency-free (no Supabase).
- `apps/web/src/components/admin/AdminTable.tsx` — server-rendered table:
  sort/pagination via Links, search via GET form. No client JS.
- `apps/web/src/components/admin/KpiCard.tsx` — presentational Server
  Component; spend renders the `estimated` badge (spec §3 labeling).
- `apps/web/src/components/admin/UserActions.tsx` — the ONE client island
  (`"use client"`): suspend/unsuspend confirm dialog + reason field, role
  change (workspace + role + reason). Same-origin fetches only; no keys,
  no `NEXT_PUBLIC_*`, no `any` (grep-verified).
- `apps/web/src/lib/admin-fetch.ts` — server-only fetch for admin Server
  Components: absolute URL via `NEXT_PUBLIC_APP_URL` (fallback
  x-forwarded-host/host), forwards request cookies (authoritative for
  `requireAdminFromSupabase`) + session Bearer token per Supabase SSR
  best practice, `cache: no-store`, 401 → `redirect("/login")` (UX only).
- `apps/web/src/app/api/admin/me/route.ts` — `GET → { tier }` (plan-accepted
  extension). Tier only, no PII/secrets. `{ error, code }` envelope.
- `apps/web/src/app/admin/layout.tsx` — server nav shell; non-admins
  redirected (UX only, API is authoritative); Ops hidden unless
  `tier === "platform"` (§7 matrix); Task 7 entries render disabled "soon"
  instead of dead links.
- `apps/web/src/app/admin/page.tsx` — overview: KPI cards (spend
  estimated-labeled) + day-bucketed trends table from Task 3 route.
- `apps/web/src/app/admin/users/page.tsx` — users AdminTable (allowlist
  email/created_at) + per-row UserActions; runtime shape-narrowing with
  error fallback. Confirm copy states ~1h full effect (spec §4).

## Files modified
- `apps/web/src/middleware.ts` — added `/admin` to PROTECTED_ROUTES
  (logged-out → /login with `next`; session refresh already covered).
- `apps/web/src/app/api/admin/users/[id]/unsuspend/route.ts` (Task 5 file,
  behavior-preserving): dropped unused `admin` binding (was the only
  admin-owned lint error failing the build gate).

## TDD-equivalent (FAIL → GREEN)
- Check: `C:\Users\Marslino\AppData\Local\Temp\opencode\admin-ui-check.mjs`,
  `node --experimental-strip-types` — asserts defaults {page:1,limit:20},
  limit 9999→100, q min-2, off-allowlist sort→default, query round-trip.
- BEFORE: FAIL (`ERR_MODULE_NOT_FOUND`, helper absent). AFTER: all PASS.

## Tests / checks
- `tsc --noEmit --skipLibCheck -p tsconfig.json` (apps/web): ZERO errors
  (before and after the unsuspend cleanup).
- `node eval/run-eval.js`: 8 PASSED / 0 FAILED (unchanged).
- Grep: no `demo-user`, no service-role/`NEXT_PUBLIC_*` secrets, no `any`
  in `src/app/admin/**` or `src/components/admin/**`.
- Route-shape: response narrowing unit-equivalent is runtime in-page
  (narrowOverview/narrowUsers with fallback error cards).

## I2 next-build proof (carried-in ledger item) — OUTCOME (explicit)
- Webpack compile: **PASSES with out-of-project `../../../../packages/admin`
  relative imports as-is** (`✓ Compiled successfully`). The I2 conditional
  ("if … break the bundler") is FALSE → **no transpilePackages / workspace
  alias fix was needed; `packages/admin` was NOT moved; `next.config.js`
  is byte-identical to before** (temp `ignoreDuringBuilds` used for one
  proof build, then reverted — verified by re-read).
- Full `next build` green: **NOT achieved — blocked SOLELY by pre-existing
  issues outside Task 6 scope** (repo had never built green before; Task 6
  is the first to run it):
  1. ESLint gate fails on pre-existing files: `api/history/route.ts`,
     `api/search/route.ts` (`no-explicit-any`), `dashboard/page.tsx`,
     `history/page.tsx`, `app/layout.tsx` (font warning),
     `login/page.tsx`, `lib/supabase/server.ts` (`no-require-imports`).
     All Task 6 + admin API files are lint-clean after the unsuspend fix.
  2. With lint skipped (proof only), type-check passes and page-data
     collection succeeds, but prerender fails on pre-existing
     `/login` (`useSearchParams()` without suspense boundary).
- Recommendation for Task 8/owner triage: fix the 7 pre-existing files +
  `/login` suspense in a dedicated cleanup (touches auth-adjacent code —
  kept out of Task 6 to protect eval 8/8). T2-I2 bundler question is
  CLOSED (no breakage); the remaining red is a separate pre-existing
  build-hygiene item.

## Tier-gating rationale (S7)
- Hidden from workspace tier: Ops nav (platform-only per §7 matrix:
  settings/grants; audit-read ships in Task 7 ops page).
- Users page actions (role change, suspend/unsuspend) shown to both tiers:
  §7 grants workspace admin/owner invite/remove/change-role, §4 suspend has
  no platform-only restriction, and the Task 3 routes + `admin_action` RPC
  enforce ROLE_RANK/self/last-admin authoritatively (403/400/409 surface as
  UI messages). No platform-only action exists on this page to hide.

## Concerns / follow-ups
- RSC→API fetch uses `NEXT_PUBLIC_APP_URL` when set, else request host;
  verify the deployed value matches the canonical origin (else admin pages
  fetch the wrong host). Cookies remain the auth mechanism; Bearer is
  supplementary.
- `UserActions` role change takes a raw workspace ID (no workspace
  picker) — acceptable for v1; Task 7 workspaces page can supply context.
- No commits made (per constraints). No subagents used.

## Fix round 1/5 — NEXT_REDIRECT no longer swallowed (2026-09-27)
- Bug: `apps/web/src/app/admin/page.tsx:99-103` and
  `apps/web/src/app/admin/users/page.tsx:133-136` caught `unknown` and
  mapped everything to `loadError`, swallowing the `NEXT_REDIRECT` thrown
  by `lib/admin-fetch.ts:68` (`redirect("/login")` on 401). Effect: expired
  sessions rendered an error card instead of redirecting to /login.
- Fix: rethrow first in both catch blocks —
  `if (isRedirectError(err)) throw err;` before the `AdminApiError` /
  fallback mapping. Behavior otherwise identical.
- Import-note deviation: the brief said `isRedirectError` from
  `next/navigation`, but on this repo's Next 15.3.3 that module does NOT
  export it (`TS2305`; `navigation.d.ts` re-exports only `redirect`,
  `notFound`, `unstable_rethrow`, …). Used Next's documented source
  instead: `next/dist/client/components/redirect-error` (verified the
  `isRedirectError` export in
  `node_modules/next/dist/client/components/redirect-error.d.ts`).
  Same predicate, same rethrow semantics.
- Covering checks:
  - grep: `isRedirectError` present at `admin/page.tsx:11,100` and
    `admin/users/page.tsx:23,135`; `redirect("/login")` intact at
    `lib/admin-fetch.ts:68`.
  - `tsc --noEmit --skipLibCheck -p tsconfig.json` (apps/web): ZERO
    errors (exit 0). Note: the literal `next/navigation` import variant
    failed with TS2305 x2 — reason for the import path above.
  - `node eval/run-eval.js`: 8 PASSED / 0 FAILED (exit 0).
- No commits made (per constraints). No subagents used.
