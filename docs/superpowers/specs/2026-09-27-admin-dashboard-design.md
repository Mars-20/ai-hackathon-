# Admin Dashboard — Design Spec (Validation Copilot, reusable foundation)

- Date: 2026-09-27 (rev 3 — rev 2 fixes C1–C7/I1–I2/M2–M4 verified; re-review
  I-NEW1–3 fixed: RPC audit atomicity, workspace audit-read RLS, profiles RLS)
- Status: draft, pending user review
- Decisions: scope = all 5 modules; access = dual-tier (platform + workspace);
  location = `apps/web` `/admin/*`; pattern = server-first, best practice.
- Audit verdict on rev 1: REJECT — fixed below. Open question for owner: C1
  bootstrap email and I1 plan entitlements need your sign-off (marked TODO-OWNER).

## 1. Goal

Add a fully admin dashboard to the Validation Copilot platform that lets
platform admins manage everything cross-workspace and workspace admins manage
their own scope — built as a reusable foundation (`packages/admin/`) for
future projects. Invariants replacing "best practice": every admin route
starts with `requireAdmin()`; workspace-tier reads are RLS- or
scopedQuery-enforced with a leakage test per route; privileged mutations are
audit-atomic (Section 6).

## 2. Architecture and access model

- Location: `apps/web/src/app/admin/*` with `layout.tsx` (sidebar nav:
  Overview, Users, Workspaces, Content, Analytics, Ops). The layout redirects
  non-admins for UX only; the API route's `requireAdmin()` is authoritative
  when they disagree (M2).
- `requireAdmin()` server helper returns `{ user, tier, workspaceIds }`.
  - Platform tier: new `platform_admins` table (`user_id` PK,
    `granted_by`, `granted_at`) read via `SECURITY DEFINER`
    `is_platform_admin()` with fixed `search_path` and
    `(select auth.uid())` — same hardened pattern as `is_workspace_member`.
  - Workspace tier: existing `workspace_members` roles with the per-module
    matrix in Section 7 (I2) — NOT blanket admin for all members.
- C1 bootstrap (first platform admin): migration seeds nothing. One-time
  operator step documented in runbook:
  `INSERT INTO platform_admins(user_id, granted_by, granted_at)
   SELECT id, id, now() FROM auth.users WHERE email = '<BOOTSTRAP_EMAIL>';`
  Guardrail: the grant API refuses when the caller is not platform-tier, so
  before bootstrap every grant returns 403. TODO-OWNER: provide
  BOOTSTRAP_EMAIL. Test: "fresh DB → ops grant returns 403 for everyone
  until bootstrap row exists."
- C2 data-access rule (replaces rev-1 "service-role everywhere"):
  - Platform-tier cross-workspace reads: service-role client allowed.
  - Workspace-tier reads: MUST go through the anon/user client so RLS
    applies; where RLS cannot express the query, use `scopedQuery`
    (contract: `scopedQuery(client, table, workspaceIds)` — `workspaceIds`
    required, throws `403` when empty, always appends
    `.in('workspace_id', workspaceIds)`; never accepts an unscoped call).
  - The rev-1 "no new admin RLS policies on existing tables" non-goal is
    deleted. New tables (`platform_admins`, `audit_log`, `admin_settings`)
    get explicit policies (Section 6).
- Every mutation writes an `audit_log` row (actor, action, target, reason,
  diff, `workspace_id`, `result`, timestamp) per the atomicity rule in
  Section 6.
- Reusable core: `packages/admin/` holds ONLY transport/auth plumbing —
  `requireAdmin`, `audit`, `scopedQuery`, pagination, error envelope
  (I6). All Copilot semantics (KPIs, verdict filters, flagged) live in
  `apps/web`. Canonical PostgREST escaper lives in `packages/admin/escape.ts`
  and both existing copies (`history`, `search`) migrate to it (M3).
- Error envelope `{ error, code }` is scoped to `/api/admin/*` only;
  existing routes keep their `{ error }` shape (M4).
- Schema additions (migration on top of `schema-unified.sql`):
  `platform_admins`, `audit_log`, `admin_settings` (key/value),
  `profiles(user_id PK, email, created_at)` populated by extending
  `handle_new_user()` (C3 source decision below), `startups.flagged`
  boolean default false (flag = hides startup from content queue
  "unflagged" filter only; no effect on agent output — I3).

## 3. Pages and data per module

- `/admin` Overview: KPI cards (users, active workspaces defined as >=1
  agent run in trailing 7d, startups, runs 7d, verifier reject rate,
  spend vs cap where spend is `sum(trace_events.cost_usd)` over the window
  and LABELED "estimated — COST_TABLE metering, not provider billing" (C5)).
  Single `/api/admin/overview`. Leakage contract per endpoint: required
  `workspace_id IN (ownIds)` predicate; NULL-workspace rows EXCLUDED from
  every workspace-tier aggregation (never attributed); joins via
  `startups!inner` DB-side (never JS filtering). Leakage test per route:
  seed two workspaces, assert zero cross-rows.
- `/admin/users` (C3): rows sourced from `profiles` (email, created_at) LEFT
  JOIN `workspace_members` + live status from Auth Admin API. Email search is
  prefix match on `profiles.email` (trigram index); sortable: email,
  created_at. Status column derives from `banned_until`: banned => "suspended",
  else "active". Actions per Section 7 matrix.
- `/admin/workspaces`: plan column read-only in v1 (I1 — v2.1 defines no
  entitlements; changing plans needs a plan→entitlement table with owner
  sign-off, deferred). Per-workspace usage (runs, evidence, estimated spend),
  members, invites (reuse `invite/route.ts` validation via shared helper —
  duplicate-409 guard, role-rank anti-escalation, 7-day expiry; I3).
- `/admin/content`: decision review queue filterable by verdict/confidence;
  flag/unflag startups; evidence inspection reuses the history detail query
  (`?startup_id=` pattern; I3). Search reuses canonical escaper.
- `/admin/analytics`: signups, runs/day, verdict distribution, cost per run
  (labeled estimated), unsupported-claim rate — SQL aggregations with the
  Section-3 leakage contract.
- `/admin/ops`: audit log viewer (actor/action filters); `admin_settings`
  editor (platform-tier-write-only); platform-admin grant/revoke (platform
  tier only, never visible to workspace tier).
- Shared UI: `AdminTable` (sort/paginate/search; defaults page 20 / max 100,
  `q` min 2 chars, sort-column allowlist per route, canonical escaper) +
  `KpiCard`. A new module is one page plus one API route.

## 4. Suspend semantics (C4 — verified against installed SDK)

- SDK: `@supabase/supabase-js@^2.50.0`; `auth.admin.updateUserById(id,
  { ban_duration })`; `'none'` lifts the ban (`auth-js` types:
  `ban_duration?: string | 'none'`; `banned_until` is read-only on User).
- Suspend: `ban_duration: '8760h'` (1 year). Unsuspend: `'none'`.
- Session semantics: ban blocks token refresh and new sign-ins; already-issued
  access JWTs remain valid until natural expiry (default 1h) — documented in
  UI copy ("takes full effect within ~1 hour"). No silent immediate lockout
  is claimed.
- Guards: self-suspend blocked (400); suspending the last remaining platform
  admin blocked (409); user-not-found 404. All audit-atomic (Section 6).

## 5. admin_settings contract (C6)

- Write: platform tier only, schema-validated at write time (ranges/types;
  e.g. cap > 0, timeout 10s–300s, rate-limit 1–1000/min). Invalid => 400,
  nothing persisted.
- Read (agent route): cached with 45s TTL; read failure fails CLOSED to
  compiled `BUDGET` defaults (`$0.50/15 calls/90s`) + trace warning.
- Caps are per-agent-task (v2.1 §6.3 authority) — no per-workspace/per-day
  billing dimension is invented in v1.
- Workspace-tier admins have no write path to settings (no cross-tenant
  control plane).

## 6. Audit atomicity (C7) + new-table RLS

- Split policy: non-privileged actions (flag/unflag, read-only views) may
  warn-and-continue on audit failure. Privileged actions (role grant/revoke,
  suspend/unsuspend, plan change if ever enabled, settings change, platform
  grant/revoke) MUST execute inside a single Postgres RPC
  (`admin_action(action, target, payload, reason)`, `SECURITY DEFINER`, fixed
  `search_path`) that inserts the `audit_log` row and applies the mutation in
  one transaction — audit failure rolls back the mutation (500 + alert). The
  two-client (mutation + separate audit INSERT) approach is forbidden for
  privileged paths because PostgREST calls cannot share a transaction.
- `audit_log` RLS: SELECT allowed for platform admins (full) AND for
  workspace members restricted to rows whose `workspace_id` is in their own
  workspaces (matches the Section 7 matrix "audit read-only" for
  admin/owner); INSERT only via the `admin_action` RPC / service-role from
  admin routes (documented exception). `platform_admins`: no direct SELECT
  for non-platform (helper-only). `admin_settings`: platform-admin SELECT,
  no anon access. `profiles` (PII emails): SELECT own row
  (`user_id = (select auth.uid())`) plus platform-admin full read; the
  `/api/admin/users` route reads via service-role but returns only rows for
  in-scope workspaces (platform: all). Retention: 365 days (documented;
  purge job out of scope v1).

## 7. Workspace-tier permission matrix (I2, with anti-escalation)

| Module | member | admin/owner |
|---|---|---|
| Overview (own workspaces) | read | read |
| Users (own workspaces) | read list | invite/remove/change role, max role = own (ROLE_RANK carried over from `invite/route.ts`) |
| Content | read + flag/unflag | read + flag/unflag |
| Analytics (own workspaces) | read | read |
| Ops (audit/settings/grants) | no access | audit read-only; no settings/grants |

Viewers: no admin access at all. Self-revoke of own last-owner membership
blocked (409). Invite of existing member / duplicate pending invite reuses
the 409 guards from `invite/route.ts` (I3, I5).

## 8. Testing

- Access-matrix test per `/api/admin/*` route: anon 401, non-admin 403,
  workspace-admin scoped (two-workspace seed, zero cross-rows), platform full.
- C1 test: fresh DB grants 403 until bootstrap. C4 tests: self-suspend 400,
  last-admin 409. C5 leakage tests per aggregation route.
- `tsc` clean on touched files; `eval/run-eval.js` stays 8/8 — migration is
  additive-only and threshold constants untouched (I4 mechanism stated).
- Seed script creates a local platform admin via the C1 bootstrap SQL.

## 9. Non-goals (v1)

- No separate `apps/admin` app; no direct Supabase reads from admin pages.
- No plan changing (read-only column) until entitlements are defined (I1).
- No email notifications for admin actions; no audit purge job.
- Goal C (reusability) scoped to `packages/admin/` plumbing only (I6).

## 10. Owner decisions (resolved 2026-09-27)

1. BOOTSTRAP_EMAIL: operator provides at deploy (runbook placeholder).
2. Plans: read-only in v1 (recommended option).
3. Scope: full build, all modules (not sliced).
