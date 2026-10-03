# Task 1 Report — DB migration (tables, helpers, RLS, profiles trigger)

- Date: 2026-09-27
- Plan: `docs/superpowers/plans/2026-09-27-admin-dashboard.md` Task 1
- Spec authority: `docs/superpowers/specs/2026-09-27-admin-dashboard-design.md` Sections 2 and 6
- Status: DONE

## Files changed

- Created: `packages/db/admin-migration.sql` (additive-only, idempotent, runs after `packages/db/schema-unified.sql`)
  - pg_trgm guard note + `create extension if not exists` (pg_trgm, pgcrypto)
  - `platform_admins(user_id PK refs auth.users, granted_by, granted_at default now())`
  - `audit_log(id PK default gen_random_uuid(), actor, action, target jsonb, reason, diff jsonb, workspace_id, result, created_at default now())`
  - `admin_settings(key PK, value jsonb, updated_by, updated_at)`
  - `profiles(user_id PK refs auth.users, email, created_at default now())` + GIN trigram index `idx_profiles_email_trgm`
  - `alter table startups add column if not exists flagged boolean not null default false`
  - `handle_new_user()` extended (profiles upsert first, workspace-creation body unchanged) + trigger re-created
  - `is_platform_admin(p_user uuid)` — `SECURITY DEFINER`, `set search_path = ''`, `exists(...)` (same hardened pattern as `is_workspace_member`)
  - RLS enabled on all four new tables + drop-if-exists policies: `platform_admins` select platform-only (no write policies); `audit_log` select platform-full + workspace members on own-`workspace_id` rows (no write policies — RPC/service-role only); `admin_settings` select platform-only (no write policies); `profiles` own-row + platform-full
  - `admin_action(action text, target jsonb, payload jsonb, reason text) RETURNS jsonb` — `SECURITY DEFINER`, `set search_path = ''`; inserts `audit_log` first then dispatches `grant_platform` / `revoke_platform` / `suspend` / `unsuspend` / `role_change` / `plan_note` in one transaction; guards: anon rejected, grant/revoke platform-tier-only (C1 bootstrap: pre-bootstrap grants 403), self-suspend rejected, last-platform-admin rejected on revoke and platform-target suspend, unknown action rejected; `EXECUTE` revoked from `public`, granted to `authenticated, service_role`
- Modified: none (no files touched besides the new migration; `GO_THRESHOLD` untouched, `eval/run-eval.js` untouched, no `demo-user` strings)

## Test commands + outputs

1. Object-presence node check (plan Step 2 + `demo-user` absence guard):
   - `node <temp>/admin-migration-check.cjs` (asserts file contains `platform_admins`, `audit_log`, `admin_settings`, `profiles`, `is_platform_admin`, `admin_action`, `flagged`; asserts no `demo-user`)
   - Output: `migration contains all objects` — PASS
   - Note: the inline `node -e` form from the plan was not usable verbatim (PowerShell stripped the inner quotes → SyntaxError); the identical assertion ran from a temp `.cjs` file instead, then the temp file was deleted.
2. Eval regression (plan Step 3):
   - `node eval/run-eval.js`
   - Output: `SUMMARY: 8 PASSED / 0 FAILED (100% Pass Rate)` — PASS

## Concerns

- SQL was verified by presence/structure review only — no live Postgres/Supabase instance was available, so the migration was NOT executed against a real database. Recommend Task 8 (or the operator) run it in the Supabase SQL Editor and confirm the access-matrix checks there.
- `admin_action` runs `SECURITY DEFINER`: it bypasses RLS only if the defining role owns the tables (true for the standard Supabase-SQL-Editor flow); confirm owner consistency at deploy.
- Suspend/unsuspend in the RPC records the authorized action audit-atomically and returns the `ban_duration` contract (`8760h` / `none`); the actual Auth ban (`auth.admin.updateUserById`) must still be applied by the route (Task 3), per spec Section 4.
- `admin_action` has no `settings_change` branch (privileged settings writes per spec Section 6); Task 5 will either extend the RPC or document the service-role path — flagged for the Task 5 implementer.

## Fix report — Round 1/5 (2026-09-27)

Scope: `packages/db/admin-migration.sql` only. No other files touched. No commits.

- C1 (suspend/unsuspend caller-tier): `suspend` and `unsuspend` branches now require `public.is_platform_admin(v_caller)` first; non-platform callers get `RETURN {ok:false, error:'forbidden'}` with denied audit trail (no RAISE). Grant/revoke platform-tier checks kept and converted to the same denied-RETURN pattern.
- C2 (role_change guards): caller must be `owner`/`admin` of target `workspace_id` (lookup in `public.workspace_members` for `auth.uid()`, else `forbidden`); ROLE_RANK anti-escalation (`viewer1/member2/admin3/owner4`, new rank must be `<=` caller rank, else `forbidden`); target must already be a member (else `membership_not_found`); changing a sole `owner` to a non-owner role is denied (`last_owner`, count owners, deny if it would leave zero).
- I1 (plan_note): now requires platform admin OR `owner`/`admin` of the effective workspace (`coalesce(target.workspace_id, payload.workspace_id)`), else `forbidden` denied-RETURN. Still audit-note only, no write.
- I2 (denied trail): removed ALL `RAISE EXCEPTION` denies from `admin_action` (zero remain); every deny does `UPDATE audit_log SET result='denied' WHERE id=v_audit_id` then `RETURN jsonb_build_object('ok', false, 'error', <code>, 'audit_id', v_audit_id)` so the txn commits with a trail. UUID parse errors are lenient flags (`v_bad_ws/v_bad_uid/v_bad_payload_ws`) that deny as `invalid_workspace_id`/`invalid_user_id` after the audit insert. Codes preserved: `forbidden`, `last_platform_admin`, `cannot_suspend_self`, `invalid_role`, `membership_not_found` (plus `not_authenticated`, `invalid_workspace_id`, `invalid_user_id`, `user_id_required`, `workspace_id_and_user_id_required`, `last_owner`, `unknown_action`).
- I3 (revoke TOCTOU): `PERFORM 1 FROM public.platform_admins FOR UPDATE` locks rows before count+delete; post-delete `SELECT count(*)` guard restores the deleted row and returns denied `last_platform_admin` if the count would hit zero (trail kept). Suspend-of-platform-admin path takes the same lock before its last-admin count.
- I4 (audit RLS): workspace-side `audit_log` SELECT now requires `EXISTS (workspace_members WHERE role IN ('owner','admin'))` on the row's `workspace_id` (plain `member`/`viewer` get no audit read), matching spec Section 7 matrix.
- I5 (settings_change): NOT implemented; SQL comment added (`I5: no settings_change branch here — DEFERRED to Task 5` + header note). Unknown actions deny as `unknown_action`.
- M1: NULL-role guard `if v_role is null or v_role not in (...)` → `invalid_role`.
- M2: helper names qualified `public.` — `public.is_platform_admin`, `public.workspace_members`, `public.update_updated_at()` in trigger; `is_platform_admin()` itself defined as `public.is_platform_admin`.
- M3: one-time backfill `INSERT INTO public.profiles SELECT id,email FROM auth.users LEFT JOIN profiles WHERE missing ON CONFLICT DO NOTHING` + fixed `handle_new_user` comment (upsert covers new users/email changes; backfill covers pre-existing users).
- M4: revoke checks target-is-admin first; non-member revoke returns `{ok:false, error:'membership_not_found'}` (last-admin check only when target IS an admin).
- M5: `startups.flagged boolean NOT NULL DEFAULT false` unchanged.

Covering checks (outputs):

1. Object-presence + fix-marker node check (`C:\Users\Marslino\AppData\Local\Temp\opencode\admin-migration-check.cjs`, temp file deleted after run):
   - Output: `PASS` on all 25 lines — `platform_admins`, `audit_log`, `admin_settings`, `profiles`, `is_platform_admin`, `admin_action`, `flagged`, `no demo-user`, `C1 suspend platform check`, `C1 suspend denied forbidden`, `C2 caller owner/admin`, `C2 rank anti-escalation`, `C2 last owner`, `I1 plan_note gate`, `I2 denied trail no RAISE`, `I2 codes`, `I3 FOR UPDATE lock`, `I3 post-delete guard`, `I4 audit owner/admin only`, `I5 settings_change deferred`, `M1 null-role guard`, `M2 qualified helpers`, `M3 backfill`, `M4 revoke non-member`, `M5 flagged NOT NULL` — final `migration contains all objects + round-1 fixes`.
2. Eval regression: `node eval/run-eval.js` — output `SUMMARY: 8 PASSED / 0 FAILED (100% Pass Rate)` — PASS.

Residual: SQL still verified by structure review only — no live Postgres/Supabase instance available, migration NOT executed against a real DB. Task 8/operator should run it in Supabase SQL Editor and confirm the matrix.
