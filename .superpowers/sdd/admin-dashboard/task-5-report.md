# Task 5 report — Admin API analytics + ops (agent, limits, audit, email)

## Status: complete

TDD red→green; `tsc` clean; eval 8/8; migration object check passes.
Window behavior + CSV shape executed against shipped source (not just grep).

Route paths follow the Task 5 worker brief (which supersedes the plan
file's older `ops/settings` + `ops/admins` layout): six routes under
`analytics/`, `agent/`, `ops/{limits,audit,email}`. No settings write
path and no grants path ship in v1 — see concerns 1–2.

## Files

- Modified: `apps/web/src/lib/admin.ts`
  - Added `parseAdminWindow()` + `AdminWindow`/`AdminWindowPreset` +
    `ADMIN_WINDOW_PRESETS` (`7d`/`30d`/`90d`) + `ADMIN_WINDOW_MAX_DAYS`
    (90). `?window=7d|30d|90d` (default `7d`) or
    `?window=custom&from=ISO&to=ISO` (span capped at 90d); invalid input
    throws structural AdminError(400, BAD_REQUEST) normalized by
    `toEnvelope()`. Executed: default 7d, 30d, custom 9d, five invalid
    shapes → all 400 (harness runs the shipped source via
    `--experimental-strip-types`).
- Created: `apps/web/src/app/api/admin/analytics/route.ts` — GET
  `{ window, distribution, trends, costPerRun, signups, unsupportedClaimRate,
  truncated }`. Verdict distribution (go/iterate/stop/test_more + total);
  zero-filled day trends across the whole window; costPerRun
  `{value, estimated:true}` (null when zero runs); signups = new profiles
  (platform) / new in-scope memberships (workspace); unsupportedClaimRate
  = share of verifier `verification` trace events with unsupported claims
  (null when none). Caps traces 10000 / decisions 5000 / signups 5000 →
  `truncated: true` when bound (T3-I2 + T4-I4 follow-up).
- Created: `.../analytics/experiments/route.ts` — GET sortable table
  (allowlist `name`/`status`/`sample_size`, `order=asc|desc`, invalid →
  400) + `?format=csv` returning the full sorted set as `text/csv` with
  header row + RFC 4180 quoting (executed: header + embedded
  comma/quote escaping verified). name = parent startup name (fallback
  design.title); sample_size = design.target_sample_size (recruitment
  target — observed sample lives on evidence rows; documented in-file).
  Sort/paginate post-fetch within EXPERIMENT_CAP 2000 (+ startup lookup
  cap 2000) → `truncated: true` when bound.
- Created: `.../agent/route.ts` — GET settings READ view: full
  `admin_settings` key/value map + per-key updated_at + readOnly meta.
  No secret materialization (only key/value/updated_at selected; no
  `process.env`, no tokens/keys in code or response). Both tiers read the
  identical global map via service-role (documented global-knobs
  exception: no workspace_id to scope on, RLS permits platform-only
  selects — user-client would return nothing for workspace tier).
- Created: `.../ops/limits/route.ts` — GET `{ window, severity,
  errorsByActor, rateLimited429, configured, truncated }`. Severity from
  trace event_type (error / warning-verification / info); 429s =
  payload-mentions-429/rate-limit heuristic (documented — the agent route
  enforces its 10 req/min cap in-memory without persisting rows);
  `configured` echoes BUDGET (read-only import from `@/lib/utils`,
  untouched) + agent per-IP cap as reference.
- Created: `.../ops/audit/route.ts` — GET `{ entries, total, pages, page,
  limit }` with actor/action exact-match filters (parameterized, no
  interpolation), newest-first. Only safe columns selected; no stacks
  anywhere (failures via `toEnvelope()`). Platform: service-role + exact
  count. Workspace: USER client (RLS) + scopedQuery — members get 200
  with only RLS-permitted rows (spec §7 owner/admin rule enforced by the
  Task-1 RLS policy, not re-implemented in the route).
- Created: `.../ops/email/route.ts` — GET `{ pending, total, truncated }`
  over `workspace_invites` status='pending' (invite token NEVER selected
  — credential-equivalent); POST `{ invite_id, reason? }` resend =
  PLATFORM-ONLY via `admin_action`/`email_resend` (audit-atomic).
  Workspace-tier POST gets the Task-4 PATCH deny-trail pattern:
  user-client RPC call first (commits denied/forbidden trail), then
  stable 403. v1 wires no mailer (spec §9 non-goal) — success means
  "resend recorded" (see response `note`).
- Modified: `packages/db/admin-migration.sql` — new `email_resend`
  branch (platform-only; validates invite exists + still pending; denies
  `forbidden` / `invite_not_found` / `invalid_invite_id` /
  `invite_not_pending` with committed trails; re-attributes the audit row
  to the invite's workspace). Lenient invite_id UUID parsing (I2
  pattern). Header docs updated; settings_change stays deferred with a
  Task-5 ruling note (any future settings_* write MUST be platform-only
  with the same deny-trail pattern).
- Modified: `.../users/[id]/suspend/route.ts`,
  `.../users/[id]/unsuspend/route.ts` — added `reconcile_note` (T3-I1
  follow-up): post-commit Auth re-read reports `ban_applied_verified` /
  `ban_pending_retry_safe` (suspend) and `ban_lifted_verified` /
  `ban_lift_pending_retry_safe` (unsuspend), `*_unverified` when the
  re-read itself fails. Retry-safe (already-in-state reconciles to ok).
  Failures still throw above the note — atomicity UNCHANGED.

Every route starts with `requireAdminFromSupabase()` and uses the
admin-only `{error,code}` envelope via `toEnvelope()`. Platform tier
reads all rows via service-role; workspace tier reads via user client
(RLS) + scopedQuery (`.in('workspace_id', ...)` — NULL rows never
match). Viewers get NONE (rejected at the requireAdmin gate; no viewer
allowlist anywhere).

## Tests

- TDD check `task5-check.mjs` (401 stub + 6 route existence + window
  presets/custom/90d-cap/400 + distribution/trends/truncated + sort
  allowlist/CSV + agent read/no-secrets + severity/429 + audit
  columns/scoping/filters/no-stacks + pending/resend/403/trail +
  reconcile_note x2 + per-route gate/envelope/strict-TS/no-demo-user +
  scoping): 47 FAILURES before (RED), ALL PASS after (GREEN).
- Window behavior executed vs shipped source: default 7d, 30d, custom
  9d, 5 invalid shapes → 400 BAD_REQUEST (all pass).
- CSV executed vs shipped source: header row + `Acme, "Inc"` quoting
  (pass).
- `tsc --noEmit --skipLibCheck -p tsconfig.json` in `apps/web`: zero
  errors (exit 0).
- `node eval/run-eval.js`: 8 PASSED / 0 FAILED.
- Migration object check (Task-1 objects + `email_resend`,
  `invite_not_found`, `invite_not_pending`, `invalid_invite_id`):
  passes.
- Grep audit of new/modified routes: no `: any`/`as any`, no
  `demo-user`, no `process.env` in the agent READ view.

## Concerns

1. No settings write path ships in v1 (brief lists the agent READ view
   only). `admin_settings` validation ranges (`cap>0`, timeout 10–300s,
   rate 1–1000/min per plan Task 5) therefore have no write-time
   enforcement point yet — whoever adds PUT settings must add the
   validator + platform-only RPC branch + deny trail together. The
   migration carries an explicit ruling note.
2. No grants path ships in v1 either (plan Task 5 listed
   `ops/admins`, brief does not). C1 bootstrap 403-until-seeded behavior
   is unchanged (RPC still denies non-platform `grant_platform`).
3. Member-read on ops GETs is API-level: the routes admit workspace
   member+ (brief matrix) while row visibility on audit relies on the
   Task-1 owner/admin RLS policy (members typically see zero rows). If
   the owner wants spec-§7-strict 403-for-members on ops, it is a
   three-line route guard — say so.
4. `rateLimited429` is a payload-mention heuristic, not metered
   counting — the agent's in-memory limiter persists nothing. A real
   429 counter needs a persisted rate-limit event (out of scope v1).
5. Experiments sort/paginate post-fetch within the 2000-row cap
   (same v1 posture as Task 4's documented caps); `truncated: true`
   signals cap bind. Keyset/FTS before scale (carries Task 4 concern 1).
6. Suspend/unsuspend split-commit (audit-ok + ban-unapplied on Auth
   failure) is inherent to Auth-after-commit and UNCHANGED by design;
   `reconcile_note` only makes the outcome observable and retries safe.
