# Trial Paywall + Manual Subscription Approval — Design Spec

- Status: `PROPOSED` (awaiting owner re-review after audit amendments)
- Date: `2026-10-05` · Version `0.2.0` (amended — see §11 adversarial audit)
- Scope: one full free trial per new user → paywall → manual plan approval by owner.
- Non-goals: Stripe/online payment (deferred behind the same interfaces), team workspaces, usage metering beyond trial state.

## 1. Agreed understanding (approved in chat 2026-10-05)

1. Every new user gets **exactly one full free trial**: unlimited agent runs on their **first** startup until the **first completed validation** (decision memo persisted).
2. After the trial is consumed: paywall everywhere for writes — no new agent runs/conversations, no new startups, no workspace invites — until subscribed.
3. The free project **stays fully visible with all details but frozen**: no adding, no editing, no new runs on it.
4. Choosing any plan opens a **form** (name, phone, company, plan, notes); the request is sent to the owner, who **approves (activates), pauses, or rejects** from the admin panel. No instant self-Grant.
5. Existing users (accounts created before launch, e.g. the owner's 17-startup account) are `legacy` and unaffected. Admins always bypass.

## 2. State machine (per user)

`trial_active` → (first completed memo persisted OR second-startup attempt) → `trial_consumed`
→ (owner approves request) → `subscribed`
`subscribed` → (owner pauses) → `paused` → (owner re-approves) → `subscribed`
Any state → (owner rejects pending request) → previous state (request marked `rejected`; user may submit a new request whenever no request is pending — sequential re-applies allowed, parallel pending never).
(`paused`, not `suspended`: the name `suspend` is taken — `POST /api/admin/users/[id]/suspend` issues an Auth ban that blocks login entirely. Entitlement pause = billing pause: writes 402, reads stay open. Hard-ban remains the abuse tool — see §11 F5.)

## 3. Data model (new tables; existing `workspaces.plan` untouched)

```sql
-- One row per user. trial_startup_id = the frozen-able first project.
create table user_entitlements (
  user_id uuid primary key references auth.users (id),
  status text not null default 'trial_active'
    check (status in ('trial_active','trial_consumed','subscribed','paused','legacy')),
  plan text not null default 'free'
    check (plan in ('free','pro','team')),
  trial_startup_id uuid null references startups (id),
  trial_consumed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Subscription requests; at most ONE pending per user (partial unique index).
create table subscription_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  plan text not null check (plan in ('pro','team')),
  full_name text not null,
  phone text not null,
  company text null,
  notes text null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by uuid null references auth.users (id),
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index one_pending_request on subscription_requests (user_id)
  where status = 'pending';
```

- RLS: users read/insert own rows only; all writes to `status`/`plan` via service-role server code (owner actions are platform-tier, same rule as workspace plan changes today).
- Entitlement rows are created by the DB, not app code: extend `handle_new_user()` (trigger on `auth.users`, already creates workspace + members + profiles) to also insert `user_entitlements(user_id, 'trial_active')`. Legacy backfill is a one-time migration (`insert … select id from auth.users` for pre-launch users — migrations run as superuser and can read `auth.users`).
- `startups.is_frozen boolean not null default false`. Consumption freezes **ALL** of the user's startup rows (`update startups set is_frozen=true where owner_id=…`), not just the validating one — origin-agnostic (agent runs and `/save` snapshots alike) and immune to ordering edges (manual snapshot saved before the first run, concurrent double-completes). `trial_startup_id` = the validating run's startup (display: "your free project"); `subscribed` unfreezes all rows.
- Trial consumption is NOT inline PostgREST (no multi-statement transactions exist in the JS client): a `consume_trial(p_user_id, p_startup_id)` SECURITY DEFINER RPC (precedent: `admin_action`, spend-ledger RPC) row-locks `user_entitlements`, flips `trial_active → trial_consumed`, freezes the user's startups, returns `already_consumed` on races. Called immediately after the `decisions` insert succeeds. Concurrent double-complete: loser gets `already_consumed` but its memo stands (documented generosity, costs one extra run).
- Auth prerequisite (config, no code): Supabase email confirmation **required** before the trial activates — unverified users get reads only. Raises multi-account cost to one real inbox per trial.
- Trial-claim fingerprinting (anti-abuse, §8 — NOT deferred):
```sql
-- One row per user, written at first trial activity (first agent run).
-- IPs stored truncated (/24 IPv4, /48 IPv6): enough for grouping, not PII-grade.
create table trial_claims (
  user_id uuid primary key references auth.users (id),
  ip_trunc text not null,
  fp_hash text not null,
  email_domain text not null,
  is_temp_mail boolean not null default false,
  suspected_duplicate boolean not null default false,
  created_at timestamptz not null default now()
);
create index trial_claims_ip on trial_claims (ip_trunc, created_at);
create index trial_claims_fp on trial_claims (fp_hash);
```
- Auth prerequisite (config, no code): Supabase email confirmation **required** before the trial activates — unverified users get reads only. Raises multi-account cost to one real inbox per trial.
- Backfill migration: every existing user → `user_entitlements(status='legacy', plan='free')`. Owner/admin accounts bypass via existing admin check regardless.

## 4. Enforcement matrix (server-side ONLY; client is display)

| Action | anon | trial_active | trial_consumed | subscribed | paused | legacy |
|---|---|---|---|---|---|---|
| `POST /api/agent` | ❌ 401 (new: auth mandatory — anon runs exist today and would bypass per-user trials) | ✅ | ❌ 402 | ✅ | ❌ 402 | ✅ |
| Create 2nd startup (`/api/startups/save`, count-based: unseen id + ≥1 existing row) | ❌ 401 (route already 401s) | ❌ 402 + consumes trial | ❌ 402 | ✅ | ❌ 402 | ✅ |
| Create invite (`POST /api/workspace/invite`) | ❌ 401 | ❌ 402 (invites are paid) | ❌ 402 | ✅ | ❌ 402 | ✅ |
| Accept invite (`PATCH …/invite` accept) | ❌ 401 | ❌ 402 (trial users cannot join paid workspaces — closes the sharing bypass) | ❌ 402 | ✅ | ❌ 402 | ✅ |
| Read history/memo/export (authenticated; RLS unchanged) | ❌ 401 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Submit plan request form | — | — (upsell hidden) | ✅ | ✅ (upgrade) | ✅ (appeal) | — |

- Error shape reuses the existing 402 pattern: `{ error, code: "TRIAL_CONSUMED" | "SUBSCRIPTION_REQUIRED" | "ACCOUNT_PAUSED" | "TRIAL_NOT_ALLOWED", plans_url: "/plans" }`.
- Touchpoints: `POST /api/agent` pre-flight (auth gate FIRST, then entitlement gate next to the existing 402 budget check), `POST /api/startups/save` (count-based creation detection — the route is upsert, so "second startup" = unseen id + existing row count ≥ 1), `POST` + `PATCH accept` on `/api/workspace/invite`. New: `POST /api/subscription-requests` (create, rate-limited, one-pending enforced), `GET /api/entitlements/me` (client banner logic).
- Gate order in `/api/agent` pre-flight: 401 anon → 429 rate-limit (unchanged) → 402 budget (unchanged) → 402 entitlement. The validate page already surfaces non-OK pre-flights generically (`validate/page.tsx:633`), so new 402s render without client changes; the frozen banner + paywall CTA are additive.
- Trial-start gate (runs BEFORE the first trial agent run, in `/api/agent` pre-flight):
  1. Email verified (`user.email_confirmed_at != null` from `getUser()` — robust regardless of the dashboard Confirm-email switch; enabling the switch in the dashboard is still recommended)? No → 402 `TRIAL_NOT_ALLOWED` ("فعّل بريدك أولًا").
  2. Email domain in temp-mail blocklist (curated list in code + `TEMP_MAIL_EXTRA_DOMAINS` env)? Yes → 402 + row flagged `is_temp_mail`.
  3. Trial starts from this `ip_trunc` in sliding window (`TRIAL_MAX_PER_IP` default 3 per `TRIAL_IP_WINDOW_DAYS` default 30)? Over → 402 `TRIAL_NOT_ALLOWED` ("الحد الأقصى للتجارب من هذه الشبكة"). Enforced by **SQL COUNT on `trial_claims`** (the table is the ledger) — NOT `lib/rate-limit`: Redis fail-closed would 402 every legitimate trial during an outage, and the memory fallback loses counters on restart.
  4. `fp_hash` (non-invasive client fingerprint: UA + screen + tz + language, hashed server-side) already claimed a consumed trial? Yes → trial ALLOWED but row flagged `suspected_duplicate` (soft-flag — shared devices/campuses must not hard-fail).
  5. Otherwise write `trial_claims` + activate.
- Trial consumption point: `consume_trial` RPC immediately after the `decisions` insert succeeds (see §3 — no inline "same transaction" exists in PostgREST). Second-startup attempt consumes the trial even without a memo (prevents trial-hopping).

## 5. Freeze UX

- `/validate` on a frozen startup: banner "انتهت تجربتك المجانية — مشروعك محفوظ كاملًا" + disabled composer + primary CTA "عرض الباقات" (`id=paywall-cta`). History list badges frozen projects with lock icon.
- `/dashboard`: "New validation" → paywall modal for consumed users (not a silent redirect).
- All copy Arabic-first (RTL already in app), English fallback.

## 6. Plans page + request form (`/plans`)

- Cards: Free ("مشروع واحد — للمستخدمين الجدد"), Pro, Team. Prices/quotas from env (`NEXT_PUBLIC_PLAN_*`) so the owner edits without code.
- CTA per paid plan → form (prefilled email, required: full name, phone; optional: company, notes) → `POST /api/subscription-requests` → success state "طلبك وصل — سنراجعه قريبًا". Duplicate pending → 409 with "لديك طلب قيد المراجعة".
- Abandoned-request nudge is out of scope (no cron yet).

## 7. Owner review queue (admin)

- New `/admin/requests` page, **platform-tier only** (`requireAdminFromSupabase()` + `tier === "platform"` via `is_platform_admin` RPC — workspace-tier admins must NOT approve subscriptions).
- Table pending-first (user, plan, name, phone, company, notes, abuse badges, date) with actions **تفعيل / إيقاف مؤقت / رفض** + optional note.
- Approve → `subscription_requests.status='approved'`, entitlement `subscribed` + `plan`, **all the user's startups unfreeze** (they become paid projects — §9 decision D1). Privileged writes go through the audit-atomic `admin_action` RPC pattern (precedent: suspend/email-resend), extended with an `approve_subscription` branch — no orphan Grant without a trail.
- Pause → entitlement `paused` (all writes 402, reads stay). Re-approve lifts it. Distinct from the existing Auth-ban suspend (hard lockout, login blocked) — pause is billing, ban is abuse.
- Reject → request `rejected`; user stays `trial_consumed`, may submit a new request whenever none is pending.
- Every action writes to the existing ops audit log (`audit_log` via `admin_action` RPC).
- Owner notification: there is NO generic email queue (`/api/admin/ops/email` only lists pending invites and v1 wires no mailer — delivery is out of scope everywhere). So: new `owner_alerts(kind, ref_id, created_at, seen_at)` table + pending-count badge on `/admin` + alert row on each new request. Real email/SMS to the owner explicitly deferred.

## 8. Abuse & edge cases (IN SCOPE — not deferred)

Abuse surface is bounded by design: paid plans need manual owner approval with name + phone, so multi-accounting can only ever yield repeated **free** trials, never paid access. Layers (cheapest effective first, no new infra):

1. **Verified email required** (`email_confirmed_at` gate): one real inbox per trial.
2. **Temp-mail blocklist**: curated throwaway domains in code + env-extensible; blocked at trial start, flagged on the claim row.
3. **Per-network cap**: `TRIAL_MAX_PER_IP` (default 3) trial starts per `ip_trunc` per sliding `TRIAL_IP_WINDOW_DAYS` (default 30), enforced by **SQL COUNT on `trial_claims`** — not the Redis limiter (§11 F3).
4. **Soft fingerprint flag**: same `fp_hash` with a consumed trial → allowed but `suspected_duplicate = true` (never hard-block: shared devices, universities, families).
5. **Owner visibility**: `/admin/requests` + entitlements show badges (بريد مؤقت / نفس الشبكة: N تجارب / بصمة مكررة مشتبهة) so approval decisions use evidence.
6. Remaining edges: trial project deleted mid-trial → next startup creation consumes trial immediately (no second free project). Invited-to-workspace while consumed → accept blocked (invites are paid). Concurrent double form submit → partial unique index. First-memo race → `consume_trial` RPC, loser gets `already_consumed` but its memo stands (documented generosity).
- Explicitly accepted residual risk: determined abuser with fresh inbox + fresh network per trial. Cost per abuse ≈ new identity + new network; detection via badges. Full device attestation (App Attest / Play Integrity) deferred to a later hardening wave.

## 9. Open decisions (default chosen; owner may override at review)

- **D1 — Unfreeze on subscribe:** ALL the user's startups unfreeze on approval (chosen: freeze-all on consume ⇒ unfreeze-all on subscribe, symmetric and order-proof; alternative: only the validating project unfreezes).
- **D2 — Re-apply after reject:** new request allowed whenever none is pending (chosen) vs. single appeal only.
- **D3 — Paused reads:** reads stay open (chosen) vs. full lockout (full lockout already exists via Auth-ban suspend — no need to duplicate it).
- **D4 — Plan prices/quotas:** env-driven, owner-supplied before launch (no hardcode).
- **D5 — Fingerprint hard vs. soft:** hard-block temp-mail + IP cap, soft-flag fingerprint duplicates (chosen: false positives on shared networks are worse than one extra free trial; alternative: hard-block everything).
- **D6 — Anon `/api/agent`:** require auth = 401 for anonymous POSTs (chosen: nothing in-app calls it anonymously — `/validate` is middleware-protected and the client already sends the session; alternative: keep anon runs but cap them at zero AI work, i.e. anon gets an instant paywall message — pointless, so 401).

## 10. Testing & rollout gates

- Vitest (red→green): state transitions, one-pending index, 401 anon / 402 codes, legacy backfill, freeze-all-on-consume, `consume_trial` race (already-consumed), temp-mail block, SQL IP-cap enforcement, duplicate-fp flags-but-allows, unverified-email gate, platform-tier-only review actions.
- Playwright + 390px: new user → full trial → paywall blocks 2nd startup + frozen composer → form submit → alert row + admin badge → admin approve → everything unlocks + projects unfrozen → pause → writes blocked, reads open.
- Gates: `tsc --noEmit`, `eslint`, clean `next build` (stop dev → delete `.next` → build rule), no secrets in repo, RLS on new tables verified, migration reversible, no e2e depends on anon `/api/agent` (add explicit anon-401 test).
- Rollout: migration backfills `legacy` + extends `handle_new_user()` first; feature ships dark (no UI links) → owner smoke-tests with a fresh test account → links enabled.

## 11. Adversarial audit (v0.1.0 → v0.2.0 — verified against repo 2026-10-05)

Method: every spec claim checked against the actual code. Verdict: direction sound; 2 critical + 5 material flaws found and fixed above. Nothing below is assumed — each cites its witness.

- **F1 CRITICAL — anon `/api/agent` bypassed all trials.** `route.ts:1897` continues full AI runs for `!ownerId` ("persistence will be skipped") and middleware excludes `/api/*` (`middleware.ts:74`). A logged-out `curl` gets free validations forever. Fix: 401 anon on `POST /api/agent` (§4, D6). Verified no in-app anon caller (`validate/page.tsx:624` sends the session; `/validate` is middleware-protected).
- **F2 CRITICAL — "same transaction" consumption impossible.** The JS client has no multi-statement transactions; persistence is 6 sequential PostgREST inserts (`route.ts:2039-2094`). Fix: `consume_trial` SECURITY DEFINER RPC after the `decisions` insert (§3–§4); precedent `admin_action` + spend-ledger RPC.
- **F3 HIGH — IP-cap via `lib/rate-limit` would DoS legit trials.** Fail-closed returns `limited:true` on any Redis outage (`rate-limit.ts:187-190`), and the memory fallback loses counters on restart. Fix: SQL COUNT on `trial_claims` — the table is the ledger (§4.3).
- **F4 HIGH — no email queue exists.** `/api/admin/ops/email` only lists pending invites and "v1 wires no mailer" (header comment). Fix: `owner_alerts` table + admin badge; owner email explicitly deferred (§7).
- **F5 MEDIUM — `suspended` collided with Auth-ban suspend.** `users/[id]/suspend` bans login for a year (hard lockout). Fix: renamed to `paused` (billing pause, reads open); ban stays the abuse tool (§2, §7, D3).
- **F6 MEDIUM — review queue tier unstated.** `requireAdminFromSupabase` has platform/workspace tiers (`lib/admin.ts:70`, `is_platform_admin` RPC). Fix: platform-tier-only gate (§7, tests).
- **F7 MEDIUM — single-project freeze was order-fragile.** `/api/startups/save` is upsert (`save/route.ts:118-122`) and agent runs mint a fresh startup id per run (client never sends `startup_id`: `validate/page.tsx:627`, type allows it `types.ts:197` but unused). Fix: freeze-ALL on consume, count-based second-startup detection, gate on entitlement status not per-startup id (§3–§4).
- **Confirmed sound (no change):** `workspaces.plan` free/pro/team + `plan:"free"` defaults (`dashboard:179`, `callback:40`, `agent-workspace:66`); 402 budget pre-flight pattern reusable (`route.ts:1810-1828`); `profiles` + workspace auto-created by `handle_new_user()` trigger (extensible hook for entitlement rows); `decisions` row = detectable "completed memo"; validate page surfaces non-OK pre-flights generically (`validate/page.tsx:633-647`); invite POST/PATCH already 401-gated with service-role accept path intact.
