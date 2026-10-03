# Task 2 Report — `packages/admin/` foundation + canonical escaper

- Date: 2026-09-27. Worker: Task 2 implementer (no subagents, no commits).
- Plan: `docs/superpowers/plans/2026-09-27-admin-dashboard.md` Task 2.
- Spec: `docs/superpowers/specs/2026-09-27-admin-dashboard-design.md` §§2–3.

## TDD log (kept test: `C:\Users\Marslino\AppData\Local\Temp\opencode\admin-foundation.test.ts`)

- RED (before): `ERR_MODULE_NOT_FOUND .../packages/admin/escape.ts` — modules did not exist.
- One test-authoring fix mid-course (not implementation): the "no raw specials" assertion used
  `String.includes`, which also matches the *escaped* `\,` pair. Fixed to strip `\X` escape pairs
  first, then assert none of `, ( ) % _` survive.
- GREEN (after): **7/7 PASS** via `node --experimental-strip-types` (exit 0):
  escaper exact-output ×2, pagination defaults/clamp/URLSearchParams ×3, scopedQuery 403-before-touch
  + `.in('workspace_id')` appended ×2. Test file kept in place per plan.

## Deliverables

Created `packages/admin/` (transport/auth plumbing only, zero Copilot domain concepts):

| File | Contents |
|---|---|
| `errors.ts` | `AdminError(status,code,message)`, `isAdminErrorLike()` (structural guard), `toEnvelope()` → `{ status, body: { error, code } }`. Envelope is for `/api/admin/*` only; existing routes untouched (`{ error }` shape kept). |
| `escape.ts` | Canonical `escapePostgrest` — byte-identical logic to the two deleted copies (`\ % _ , ( ) * " [ ]`, backslash first). |
| `pagination.ts` | `getPagination()` (page 1 / limit 20 default, max 100, min 1, invalid→default; accepts `URLSearchParams`, plain objects, Records) + `parseSearchQuery()` (`q` min 2 chars, spec §3) + exported constants. |
| `scopedQuery.ts` | `scopedQuery(client,table,workspaceIds,build)` — throws structural 403 on empty ids *before* touching the client; appends `.in('workspace_id', ids)` post-build/pre-execution (builders are lazy → single round-trip); 500 on query error. |
| `audit.ts` | `audit(supabase, entry)` → `audit_log` INSERT, **warn-and-continue** on failure (non-privileged path; privileged mutations must use `admin_action` RPC). |
| `requireAdmin.ts` | `requireAdmin(deps)` → `{ user:{id,email?}, tier:'platform'\|'workspace', workspaceIds }`; 401 no user; platform via `is_platform_admin` RPC (`{ p_user }` — matches Task 1 migration signature `is_platform_admin(p_user uuid)`), RPC error fails **closed** to workspace path; workspace via `workspace_members` lookup, non-viewer roles only (`member/admin/owner`), else 403. Real identity from `auth.getUser()` only — no `demo-user` anywhere. |
| `index.ts` | Re-exports the full public surface. |

Modified (import-only, behavior identical):

- `apps/web/src/app/api/history/route.ts`, `apps/web/src/app/api/search/route.ts` — local
  `escapePostgrest` duplicates deleted, replaced with
  `import { escapePostgrest } from "../../../../../../packages/admin/escape"`.
  Six-level relative path verified by resolution (`node -e path.resolve`) and tsc.

## Verification

- `node --experimental-strip-types …/admin-foundation.test.ts` → 7/7 PASS (exit 0).
- `tsc --noEmit --skipLibCheck -p tsconfig.json` in `apps/web` → **exit 0** (whole project, incl. both
  migrated routes and all 7 new modules via import graph).
- Standalone `tsc --strict` over `packages/admin/*.ts` → exit 0. No `any` type in new code
  (one `any` grep hit is the English word in a doc comment), strict-clean, `catch (err: unknown)` + guards.
- `node eval/run-eval.js` → **8 PASSED / 0 FAILED**.
- `GO_THRESHOLD`/`utils.ts` untouched; no `demo-user`; temp verifier/deleted scratch files removed
  (`__admin-task2-verify.ts`, `__admin-diagnose.ts`, `resolvexp/` was temp-only).

## Design decisions future tasks must know

1. **No runtime cross-imports inside `packages/admin/`** (only `import type`). Extensionless relative
   imports break `node --experimental-strip-types` (ERR_MODULE_NOT_FOUND); `.ts`-suffixed ones break
   tsc (TS5097, proven). Errors are therefore shared **structurally** (`name/status/code/message`) and
   `toEnvelope()`/`isAdminErrorLike()` normalize structurally — also the correct contract across JSON
   serialization boundaries. Never rely on `instanceof AdminError` for errors thrown by `scopedQuery`/
   `requireAdmin`; use `toEnvelope()` or the structural guard.
2. **`requireAdmin(deps)` takes three closures, not the Supabase client.** Matching the real client's
   *generic* builder methods (`from`/`rpc`) against a concrete structural interface triggers TS2589
   (excessively deep instantiation — reproduced and bisected; bare thenable matching alone is fine).
   Generic *inference* (closures) stays shallow. Canonical adapter for Task 3 routes (proven to
   typecheck — it was exercised in the deleted temp verifier):
   ```ts
   import { createServerSupabaseClient } from "@/lib/supabase/server";
   import { isMembershipRow, requireAdmin } from "../../../../../../packages/admin";
   import type { MembershipRow } from "../../../../../../packages/admin";

   const supabase = await createServerSupabaseClient();
   const admin = await requireAdmin({
     getUser: () => supabase.auth.getUser(),
     checkPlatformAdmin: async (userId: string): Promise<boolean> => {
       const { data, error } = await supabase.rpc("is_platform_admin", { p_user: userId });
       if (error) throw new Error(error.message);
       return data === true;
     },
     listMemberships: async (userId: string): Promise<MembershipRow[]> => {
       const { data } = await supabase
         .from("workspace_members").select("workspace_id, role").eq("user_id", userId);
       const rows: unknown = data;
       return Array.isArray(rows) ? rows.filter(isMembershipRow) : [];
     },
   });
   ```
   `audit()` and `scopedQuery()` accept the real client **directly** (their generic-inference shapes
   were proven tsc-clean with the real client — no adapter needed).
3. **Platform tier returns all *own* membership workspaceIds** (convenience scope; platform reads use
   the service-role client anyway). Workspace tier returns **non-viewer ids only** — viewer rows are
   excluded from scoping, matching the §7 matrix (viewers: no admin access).
4. `getPagination` never throws (falls back to defaults); sort-column allowlists stay per-route (Task 6).

## Concerns / risks

- **Cross-directory relative imports** (`apps/web` → `packages/admin`) compile under tsc/Next today,
  but a production `next build` was not run (not required by this task) — Task 6/8 should confirm the
  bundler accepts out-of-project relative imports or switch to a `transpilePackages`/workspace alias.
  If `allowImportingTsExtensions` is ever enabled project-wide, decision (1) can be revisited.
- `requireAdmin`'s platform check calls `rpc("is_platform_admin", …)`; on databases where the Task 1
  migration was never applied it fails closed to the workspace path (warns). Platform admins on such
  DBs get 403 rather than a loud 500 — acceptable, but Task 8's bootstrap test should pin behavior.
- `audit()` swallows write failures by design (warn-and-continue); privileged paths must NOT use it —
  they go through `admin_action` (Task 3/5 must enforce this; grep for `audit(` vs `admin_action`).
