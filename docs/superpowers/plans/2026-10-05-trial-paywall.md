# Trial Paywall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one full free trial per new user, then paywall with owner-approved manual subscriptions, reusing the existing 402 pattern and admin RPC conventions.

**Architecture:** DB-first: migration 0010 creates entitlement/claim/request/alert tables + `consume_trial` RPC + trigger extension; pure gate logic lives in `lib/entitlements.ts` (unit-tested); API routes only wire gates in pre-flight; UI is additive (plans page, banners, admin queue).

**Tech Stack:** Next.js 15.5.27 + React 19, Supabase Postgres + RLS + SECURITY DEFINER RPCs, zod, vitest 5, Playwright 1.63 (msedge channel).

**Spec:** `docs/superpowers/specs/2026-10-05-trial-paywall-design.md` (v0.2.0 — plan argues from it; executors read both).

## Global Constraints

- Workdir for all app commands is `apps/web`; use `npm.cmd` / `npx.cmd` (never bare `npm`/`npx`).
- Never `next build` while `next dev` runs on the same `.next` (Windows lock → Franken-build): stop dev → delete `.next` → build.
- Vitest files that transitively import server code must start with `vi.mock("server-only", () => ({}))`.
- DAL/server code: `service-role` client server-only, never expose keys; no `token`/`secret` strings in code, tests, or commits.
- UI: `min-h-dvh` (never `h-screen`), `safe-area-inset` on sticky headers, `16px` base padding / `24px` `sm:`, icon-only buttons get `aria-label`, Arabic-first copy with English fallback.
- TDD red→green per task; gates per task: `npx.cmd tsc --noEmit`, `npx.cmd next lint`, `npx.cmd vitest run <touched>`.
- RLS enabled on every new table; user clients read own rows only; privileged writes via service-role or `admin_action` RPC.

## Review Focus

1. IPv6-mapped IPv4 (`::ffff:1.2.3.4`) must truncate as IPv4 /24, not as IPv6 — else one user gets many buckets. Pinned in Task 2 (`truncateIp` tests).
2. Phone numbers are PII in `subscription_requests` — user SELECT own-only, never returned in list payloads beyond the owner's admin view; tests assert the public shape. Pinned in Task 6.
3. `consume_trial` double-complete race must never double-charge state — second caller gets `already_consumed`, memo stands. Pinned in Task 1 (RPC logic) + Task 4 (call site).
4. `/plans` Arabic RTL: form labels/inputs `dir="rtl"`, error text inline under fields, paste never blocked in phone field. Pinned in Task 7 (e2e asserts).
5. Stale entitlement cache: client must refetch `GET /api/entitlements/me` after consume/approve events, never trust a cached `trial_active`. Pinned in Task 7 (banner logic reads fresh response per navigation).

---

## File Map

- Create: `supabase/migrations/20240101000010_trial_paywall.sql` (tables + RLS + trigger extension + backfill + `consume_trial` RPC + `admin_action` approve branch)
- Create: `apps/web/src/lib/entitlements.ts` (status type, `resolveAgentGate`, `resolveSaveGate`, `resolveInviteGate`, `truncateIp`, `hashFingerprint`)
- Create: `apps/web/src/lib/temp-mail-domains.ts` (curated blocklist + `isTempMailDomain`)
- Create: `apps/web/src/lib/trial-claims.ts` (`evaluateTrialStart` — verified-email, temp-mail, SQL IP cap, fp duplicate)
- Create tests: `apps/web/src/lib/__tests__/entitlements.test.ts`, `apps/web/src/lib/__tests__/trial-claims.test.ts`, `apps/web/src/app/api/__tests__/subscription-requests.test.ts`
- Modify: `apps/web/src/lib/validation.ts` (add `subscriptionRequestSchema`, `fpSignalsSchema`)
- Modify: `apps/web/src/app/api/agent/route.ts` (401 anon + entitlement pre-flight + trial-start gate + `consume_trial` call after decisions insert)
- Modify: `apps/web/src/app/api/startups/save/route.ts` (frozen check + count-based second-startup gate)
- Modify: `apps/web/src/app/api/workspace/invite/route.ts` (create: subscribed/legacy only; accept: subscribed/legacy only)
- Create: `apps/web/src/app/api/subscription-requests/route.ts` (POST create; GET own list)
- Create: `apps/web/src/app/api/entitlements/me/route.ts` (GET own entitlement + frozen startup ids)
- Create: `apps/web/src/app/plans/page.tsx` (cards + request form)
- Modify: `apps/web/src/app/validate/page.tsx` (frozen banner + disabled composer + paywall CTA `id=paywall-cta`)
- Modify: `apps/web/src/app/dashboard/page.tsx` (paywall modal for consumed users on "New validation")
- Create: `apps/web/src/app/admin/requests/page.tsx` (platform-tier review queue + abuse badges)
- Modify: `apps/web/src/app/admin/layout.tsx` (nav item + pending-count badge)
- Create: `apps/web/e2e/trial-paywall.spec.ts` (full journey + 390px + anon-401)

---

### Task 1: Migration 0010 — tables, RLS, trigger, backfill, RPCs

**Files:**
- Create: `supabase/migrations/20240101000010_trial_paywall.sql`

**Interfaces:**
- Consumes: existing `handle_new_user()` body (`supabase/migrations/20240101000001_admin.sql:115-141` — read it first, preserve verbatim); existing `admin_action(action text, target jsonb, payload jsonb, reason text)` chain (`20240101000001_admin.sql:240+` — read the `suspend` branch to copy the audit pattern).
- Produces: tables `user_entitlements`, `subscription_requests`, `trial_claims`, `owner_alerts`; `startups.is_frozen`; RPC `consume_trial(p_user_id uuid, p_startup_id uuid) returns text`; extended trigger + `admin_action` `approve_subscription` branch. Later tasks call `supabase.rpc("consume_trial", { p_user_id, p_startup_id })` and `supabase.rpc("admin_action", { action: "approve_subscription", target: { user_id }, payload: { plan }, reason })`.

- [ ] **Step 1: Write the migration file** at `supabase/migrations/20240101000010_trial_paywall.sql` with exactly this content (after reading the two referenced bodies to splice the trigger + RPC branch correctly):

```sql
-- 0010 trial paywall: one full free trial per user, manual subscription approval.
-- Tables
create table if not exists public.user_entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'trial_active'
    check (status in ('trial_active','trial_consumed','subscribed','paused','legacy')),
  plan text not null default 'free' check (plan in ('free','pro','team')),
  trial_startup_id uuid null,
  trial_consumed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.subscription_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null check (plan in ('pro','team')),
  full_name text not null check (char_length(full_name) between 2 and 120),
  phone text not null check (char_length(phone) between 6 and 32),
  company text null check (company is null or char_length(company) <= 160),
  notes text null check (notes is null or char_length(notes) <= 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid null references auth.users (id),
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index if not exists one_pending_request on public.subscription_requests (user_id)
  where status = 'pending';
create table if not exists public.trial_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ip_trunc text not null,
  fp_hash text not null,
  email_domain text not null,
  is_temp_mail boolean not null default false,
  suspected_duplicate boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists trial_claims_ip on public.trial_claims (ip_trunc, created_at);
create index if not exists trial_claims_fp on public.trial_claims (fp_hash);
create table if not exists public.owner_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('subscription_request')),
  ref_id uuid not null,
  created_at timestamptz not null default now(),
  seen_at timestamptz null
);
create index if not exists owner_alerts_unseen on public.owner_alerts (created_at) where seen_at is null;
alter table public.startups add column if not exists is_frozen boolean not null default false;

-- RLS: users read own entitlement/requests only; claims + alerts are service-role only (no policies = deny).
alter table public.user_entitlements enable row level security;
drop policy if exists "entitlements_select_own" on public.user_entitlements;
create policy "entitlements_select_own" on public.user_entitlements for select to authenticated
  using (auth.uid() = user_id);
alter table public.subscription_requests enable row level security;
drop policy if exists "subreq_select_own" on public.subscription_requests;
create policy "subreq_select_own" on public.subscription_requests for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists "subreq_insert_own" on public.subscription_requests;
create policy "subreq_insert_own" on public.subscription_requests for insert to authenticated
  with check (auth.uid() = user_id);
alter table public.trial_claims enable row level security;
alter table public.owner_alerts enable row level security;

-- consume_trial RPC: row-locked, idempotent consumption + freeze-all.
create or replace function public.consume_trial(p_user_id uuid, p_startup_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.user_entitlements
    where user_id = p_user_id for update;
  if not found then return 'no_entitlement'; end if;
  if v_status <> 'trial_active' then return 'already_consumed'; end if;
  update public.user_entitlements set status = 'trial_consumed',
    trial_startup_id = p_startup_id, trial_consumed_at = now(), updated_at = now()
    where user_id = p_user_id;
  update public.startups set is_frozen = true
    where owner_id = p_user_id and is_frozen = false;
  return 'consumed';
end; $$;
revoke all on function public.consume_trial(uuid, uuid) from public;
grant execute on function public.consume_trial(uuid, uuid) to authenticated, service_role;

-- Legacy backfill: everyone existing at migration time is untouched forever.
insert into public.user_entitlements (user_id, status, plan)
  select u.id, 'legacy', 'free' from auth.users u
  left join public.user_entitlements e on e.user_id = u.id
  where e.user_id is null
  on conflict (user_id) do nothing;
```

Then append: (a) `handle_new_user()` rewrite = existing body from `20240101000001_admin.sql:115-141` PLUS this line before `return new;`: `insert into public.user_entitlements (user_id, status, plan) values (new.id, 'trial_active', 'free') on conflict (user_id) do nothing;` (b) `admin_action` `approve_subscription` branch = copy of the `suspend` branch structure with: deny unless `is_platform_admin`, on approve update `subscription_requests` to approved + `user_entitlements` to subscribed/plan + unfreeze startups (`update startups set is_frozen=false where owner_id=target`) + insert `owner_alerts`-seen-safe audit via the function's existing audit insert; return jsonb `{ok:true}`.

- [ ] **Step 2: Apply the migration** with the `supabase_apply_migration` tool (`name: "trial_paywall"`, `project_id` of app ref `qgolznxdfokbggsdmxlu`).
- [ ] **Step 3: Verify with queries** via `supabase_execute_sql`: (1) new tables exist; (2) `select * from pg_policies where tablename in ('user_entitlements','subscription_requests','trial_claims','owner_alerts')`; (3) `select proname from pg_proc where proname='consume_trial'`; (4) legacy row count equals auth user count.
- [ ] **Step 4: Commit** `git add supabase/migrations/20240101000010_trial_paywall.sql` + `git commit -m "feat: trial paywall schema, consume_trial RPC, legacy backfill"`.

### Task 2: Pure gate logic — `lib/entitlements.ts` + temp-mail list

**Files:**
- Create: `apps/web/src/lib/entitlements.ts`
- Create: `apps/web/src/lib/temp-mail-domains.ts`
- Test: `apps/web/src/lib/__tests__/entitlements.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 3–6, exact names): `type EntitlementStatus = "trial_active" | "trial_consumed" | "subscribed" | "paused" | "legacy"`; `resolveAgentGate(status: EntitlementStatus | null): { allowed: boolean; code: "OK" | "TRIAL_CONSUMED" | "SUBSCRIPTION_REQUIRED" | "ACCOUNT_PAUSED" }`; `resolveSaveGate(status, isNewStartup: boolean, existingCount: number): { allowed: boolean; code: string; consumeTrial: boolean }`; `resolveInviteGate(status, action: "create" | "accept"): { allowed: boolean; code: string }`; `truncateIp(ip: string): string`; `hashFingerprint(signals: { ua: string; screen: string; tz: string; lang: string }): string`; `isTempMailDomain(domain: string, extra?: string): boolean`.

- [ ] **Step 1: Write the failing test** `apps/web/src/lib/__tests__/entitlements.test.ts` (first line MUST be `vi.mock("server-only", () => ({}))` only if importing server code — these are pure, so no mock needed; import from `@/lib/entitlements`):

```ts
import { describe, expect, test } from "vitest";
import { hashFingerprint, resolveAgentGate, resolveInviteGate, resolveSaveGate, truncateIp } from "@/lib/entitlements";

describe("resolveAgentGate", () => {
  test("trial_active and subscribed and legacy allowed; consumed/paused blocked with codes", () => {
    expect(resolveAgentGate("trial_active")).toEqual({ allowed: true, code: "OK" });
    expect(resolveAgentGate("subscribed").allowed).toBe(true);
    expect(resolveAgentGate("legacy").allowed).toBe(true);
    expect(resolveAgentGate("trial_consumed")).toEqual({ allowed: false, code: "TRIAL_CONSUMED" });
    expect(resolveAgentGate("paused")).toEqual({ allowed: false, code: "ACCOUNT_PAUSED" });
    expect(resolveAgentGate(null)).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
  });
});
describe("resolveSaveGate", () => {
  test("second new startup while trial_active consumes trial and blocks", () => {
    expect(resolveSaveGate("trial_active", true, 1)).toEqual({ allowed: false, code: "TRIAL_CONSUMED", consumeTrial: true });
    expect(resolveSaveGate("trial_active", true, 0).allowed).toBe(true);
    expect(resolveSaveGate("trial_active", false, 5).allowed).toBe(true);
    expect(resolveSaveGate("subscribed", true, 9).allowed).toBe(true);
  });
});
describe("resolveInviteGate", () => {
  test("only subscribed/legacy create and accept", () => {
    expect(resolveInviteGate("subscribed", "create").allowed).toBe(true);
    expect(resolveInviteGate("legacy", "accept").allowed).toBe(true);
    expect(resolveInviteGate("trial_active", "accept").allowed).toBe(false);
    expect(resolveInviteGate("trial_consumed", "create").allowed).toBe(false);
  });
});
describe("truncateIp", () => {
  test("ipv4 /24, ipv6 /48, mapped-ipv4 treated as ipv4", () => {
    expect(truncateIp("1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3:0000");
    expect(truncateIp("::ffff:1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("unknown")).toBe("unknown");
  });
});
describe("hashFingerprint", () => {
  test("stable 64-hex sha256 of canonical signals", () => {
    const s = { ua: "a", screen: "b", tz: "c", lang: "d" };
    expect(hashFingerprint(s)).toBe(hashFingerprint(s));
    expect(hashFingerprint(s)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx.cmd vitest run src/lib/__tests__/entitlements.test.ts` (workdir `apps/web`). Expected: FAIL with "Cannot find module".
- [ ] **Step 3: Write minimal implementation.** `temp-mail-domains.ts`: `export const TEMP_MAIL_DOMAINS = ["mailinator.com","tempmail.com","10minutemail.com","guerrillamail.com","yopmail.com", ...]` (≈30 well-known domains) + `export function isTempMailDomain(domain: string, extra = ""): boolean` (lowercase, trim, exact-or-subdomain match, plus comma-separated `extra`). `entitlements.ts`: the types + five functions exactly as the test calls them (`truncateIp`: `::ffff:a.b.c.d` mapped or plain IPv4 → first 3 octets; other IPv6 → first 4 hextets (/48); garbage → as-is). `hashFingerprint`: `createHash("sha256").update([ua,screen,tz,lang].join("|")).digest("hex")` via `node:crypto`.
- [ ] **Step 4: Run tests + gates.** `npx.cmd vitest run src/lib/__tests__/entitlements.test.ts` → PASS; then `npx.cmd tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `git add apps/web/src/lib/entitlements.ts apps/web/src/lib/temp-mail-domains.ts apps/web/src/lib/__tests__/entitlements.test.ts` + `git commit -m "feat: trial entitlement gate logic and temp-mail list"`.

### Task 3: Trial-start evaluation — `lib/trial-claims.ts`

**Files:**
- Create: `apps/web/src/lib/trial-claims.ts`
- Test: `apps/web/src/lib/__tests__/trial-claims.test.ts`

**Interfaces:**
- Consumes: `isTempMailDomain`, `truncateIp`, `hashFingerprint` (Task 2); a minimal `Db` interface defined HERE: `export interface ClaimsDb { countRecentClaims(ipTrunc: string, sinceIso: string): Promise<number>; findConsumedByFp(fpHash: string, excludeUserId: string): Promise<boolean>; insertClaim(row: { user_id: string; ip_trunc: string; fp_hash: string; email_domain: string; is_temp_mail: boolean; suspected_duplicate: boolean }): Promise<void>; }` (routes adapt the Supabase client to it in Task 4).
- Produces: `export interface TrialStartResult { allowed: boolean; code: "OK" | "TRIAL_NOT_ALLOWED"; reason?: string; claim: { ip_trunc: string; fp_hash: string; email_domain: string; is_temp_mail: boolean; suspected_duplicate: boolean } }`; `export async function evaluateTrialStart(input: { userId: string; email: string; emailConfirmedAt: string | null; ip: string; fpSignals: { ua: string; screen: string; tz: string; lang: string }; db: ClaimsDb; maxPerIp?: number; windowDays?: number; extraTempDomains?: string }): Promise<TrialStartResult>` — order: unverified → temp-mail → SQL IP cap (`countRecentClaims >= maxPerIp` default 3/30d) → fp duplicate (allow + flag) → else allow.

- [ ] **Step 1: Write the failing test** with a fake in-memory `ClaimsDb` covering: unverified blocked; temp-mail blocked + flagged; 3rd-claim IP allowed / 4th blocked; duplicate fp allowed + `suspected_duplicate:true`; clean user allowed with `is_temp_mail:false`.
- [ ] **Step 2: Run to verify FAIL** (`npx.cmd vitest run src/lib/__tests__/trial-claims.test.ts`).
- [ ] **Step 3: Implement** `trial-claims.ts` exactly per the interface above (env defaults read at call time: `TRIAL_MAX_PER_IP`, `TRIAL_IP_WINDOW_DAYS`, `TEMP_MAIL_EXTRA_DOMAINS` — parsed with `Number()` + fallback, never throw on junk env).
- [ ] **Step 4: Run tests + typecheck** → PASS + clean.
- [ ] **Step 5: Commit** `git commit -m "feat: trial-start abuse evaluation"`.

### Task 4: Wire `/api/agent` — 401 + entitlement + trial-start + consume

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` (pre-flight after budget check `route.ts:1810-1838`; decisions-insert site `route.ts:2070-2076`)

**Interfaces:**
- Consumes: `resolveAgentGate`, `evaluateTrialStart` + `ClaimsDb` adapter (service-role client for `trial_claims`/`user_entitlements` writes — RLS denies user clients there), `getClientIp` (existing), `consume_trial` RPC.

- [ ] **Step 1: Add pre-flight gates** (no new test file — covered by Task 2/3 units + Task 9 e2e; state this in the commit message). Insert AFTER the budget pre-flight block: (a) `const { data: { user } } = await supabase.auth.getUser()` reuse `rateUserId` — if empty → 401 `{ error: "Unauthorized", code: "UNAUTHENTICATED" }`; (b) fetch entitlement via service-role (`user_entitlements` select by user.id, `maybeSingle`; missing + user created before migration → treat as `legacy` defensively, log warning); (c) `resolveAgentGate(status)` → 402 `{ error, code, plans_url: "/plans" }` with Arabic messages; (d) if `trial_active`, run `evaluateTrialStart` (email/`email_confirmed_at` from user, ip=`getClientIp`, fp signals from body `fp` validated by `fpSignalsSchema` — missing fp → treat as `{}` hashed, do NOT block); on deny → 402 `TRIAL_NOT_ALLOWED`; on allow → insert `trial_claims` row via service-role (best-effort: failure → allow + trace warning, never block a legit trial on a ledger write error).
- [ ] **Step 2: Add consumption call.** After the `decisions` insert succeeds (`route.ts:2070-2076`): `const { data: consumed } = await service.rpc("consume_trial", { p_user_id: ownerId, p_startup_id: startup.id })` — fire-and-forget is FORBIDDEN here; await it; on `'already_consumed'` push trace notice; on error push `persist_warning` trace (run already delivered value — never fail the stream).
- [ ] **Step 3: Verify**: `npx.cmd tsc --noEmit` + `npx.cmd next lint` clean; `npx.cmd vitest run` full suite still 299+ PASS.
- [ ] **Step 4: Commit** `git commit -m "feat: agent trial enforcement with consume_trial"`.

### Task 5: Save + invite gates

**Files:**
- Modify: `apps/web/src/app/api/startups/save/route.ts` (after 401 at line 26-28)
- Modify: `apps/web/src/app/api/workspace/invite/route.ts` (POST after 401 at line 109-112; PATCH accept path at line 224-277)

**Interfaces:** Consumes `resolveSaveGate`, `resolveInviteGate` + service-role entitlement fetch (same snippet as Task 4 — copy it, do not import route code).

- [ ] **Step 1 (save):** After auth, fetch entitlement; fetch existing row for `rawId` (already done at lines 76-80 — reuse `existing`): `isNew = !existing || existing.owner_id !== user.id`... precisely: creation = `!existing` (unknown id) OR (existing owned by someone else → already 403 above). If `isNew`: count `startups` by `owner_id=user.id` (head count); `resolveSaveGate(status, true, count)` → deny 402, and when `consumeTrial` call `consume_trial` RPC with the new id BEFORE the upsert (prevents trial-hopping via snapshots). If `!isNew` (update own row): deny when row `is_frozen` or status is consumed/paused → 402 `TRIAL_CONSUMED`/`ACCOUNT_PAUSED`.
- [ ] **Step 2 (invite POST):** After 401: `resolveInviteGate(status, "create")` → non-subscribed/legacy get 402 `SUBSCRIPTION_REQUIRED`.
- [ ] **Step 3 (invite PATCH accept):** In the accept branch before member insert: fetch invitee entitlement; `resolveInviteGate(status, "accept")` → trial/consumed/paused get 402 (privileged on-behalf path unchanged).
- [ ] **Step 4: Unit-test the new branches** by extracting nothing — instead extend `entitlements.test.ts`? No: gates already tested. Verification = typecheck + lint + Task 9 e2e. Run `npx.cmd tsc --noEmit`, `npx.cmd next lint`, full vitest PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: save and invite entitlement gates"`.

### Task 6: Subscription requests API + entitlement readout

**Files:**
- Modify: `apps/web/src/lib/validation.ts` (append `subscriptionRequestSchema`, `fpSignalsSchema`)
- Create: `apps/web/src/app/api/subscription-requests/route.ts`
- Create: `apps/web/src/app/api/entitlements/me/route.ts`
- Test: `apps/web/src/app/api/__tests__/subscription-requests.test.ts`

**Interfaces:**
- Consumes: `createServerSupabaseClient` (user-scoped; RLS enforces own-rows), rate-limit `checkRateLimit` for form spam (key `subreq:<userId>`, limit 5/hour).
- Produces: `POST /api/subscription-requests` → 201 `{ request: { id, plan, status } }` + `owner_alerts` insert (service-role); 409 when pending exists; 401 anon. `GET` → own requests (id, plan, status, created_at only — NO phone/full_name in list payload? Owner needs them in admin view only; own GET may include own PII — allowed, it is their data). `GET /api/entitlements/me` → `{ status, plan, trial_startup_id, frozen_startup_ids: string[] }` or `{ status: "legacy" }`.

- [ ] **Step 1: Write failing tests** for the zod schemas (valid form passes; bad phone/short name/wrong plan fail) + handler shape test via mocked supabase modules (follow `budget-metering.test.ts` mock style — read it first).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** schemas + both routes. POST: auth 401 → zod 400 → rate-limit 429 → insert (catch unique-violation → 409 "لديك طلب قيد المراجعة") → service-role `owner_alerts` insert `{ kind: "subscription_request", ref_id }` (best-effort) → 201. Phone stored as-given (PII: RLS own-only + platform service-role reads; documented in code comment).
- [ ] **Step 4: Run tests + gates** → PASS + clean.
- [ ] **Step 5: Commit** `git commit -m "feat: subscription request and entitlement APIs"`.

### Task 7: Plans page + frozen UX + dashboard paywall

**Files:**
- Create: `apps/web/src/app/plans/page.tsx`
- Modify: `apps/web/src/app/validate/page.tsx` (frozen banner + `id=paywall-cta`)
- Modify: `apps/web/src/app/dashboard/page.tsx` (paywall modal)

**Interfaces:** Consumes `GET /api/entitlements/me` (fresh fetch per navigation — never cache across approve events; Review Focus #5).

- [ ] **Step 1: Build `/plans`.** Server component: reads session; cards Free/Pro/Team with prices from `process.env.NEXT_PUBLIC_PLAN_PRO_PRICE` etc (fallback "—"); paid CTA → client form (full name, phone `inputMode="tel"`, company, notes; `dir="rtl"`; inline errors; submit → POST `/api/subscription-requests` → success state "طلبك وصل — سنراجعه قريبًا" / 409 state "لديك طلب قيد المراجعة"). Layout: `min-h-dvh`, container `px-4 sm:px-6`, cards `grid gap-4 md:grid-cols-3`.
- [ ] **Step 2: Frozen validate.** When loaded startup `is_frozen` (from history/startup fetch) OR entitlement is consumed/paused: banner "انتهت تجربتك المجانية — مشروعك محفوظ كاملًا" + disable run button + primary link `/plans` with `id="paywall-cta"`. Reads (memo, history, export) untouched.
- [ ] **Step 3: Dashboard modal.** "New validation" click while consumed/paused → modal (not redirect) with trial summary + `/plans` CTA; trial_active/legacy/subscribed unaffected.
- [ ] **Step 4: Verify** typecheck + lint; manual check on dev server at 390px (banner readable, form usable, no horizontal scroll).
- [ ] **Step 5: Commit** `git commit -m "feat: plans page, frozen UX, paywall modal"`.

### Task 8: Admin review queue + badge

**Files:**
- Create: `apps/web/src/app/admin/requests/page.tsx`
- Modify: `apps/web/src/app/admin/layout.tsx` (nav + badge)

**Interfaces:** Consumes `requireAdminFromSupabase()` + `tier === "platform"` hard gate (403 otherwise); service-role reads of `subscription_requests` + `profiles` email + `trial_claims` badges; `admin_action` `approve_subscription` RPC (Task 1); `owner_alerts` unseen count.

- [ ] **Step 1: Build queue.** Server component, platform-tier gate FIRST (before any data fetch). Table pending-first: user email (via profiles), plan, name, phone, company, notes, date + badges (بريد مؤقت / نفس الشبكة: N / بصمة مكررة — N from `trial_claims` count by ip). Actions تفعيل / إيقاف مؤقت / رفض via server actions or POST to new `apps/web/src/app/api/admin/requests/route.ts` (create it: platform gate → `admin_action` RPC with `approve_subscription` / `pause_subscription` (add this branch in Task 1 migration too) / `reject_subscription` → mark `owner_alerts.seen_at`). Reject = status rejected only (entitlement untouched).
- [ ] **Step 2: Badge.** Admin layout fetches unseen `owner_alerts` count (service-role in layout server component) → badge on Requests nav item; mark seen when queue page opened.
- [ ] **Step 3: Verify** typecheck + lint + vitest full PASS; workspace-tier admin gets 403 (assert in e2e Task 9 if a second-tier fixture exists, else manual).
- [ ] **Step 4: Commit** `git commit -m "feat: subscription review queue"`.

### Task 9: E2E journey + final gates + dark ship

**Files:**
- Create: `apps/web/e2e/trial-paywall.spec.ts`

**Interfaces:** Consumes all previous tasks. Uses a fresh test user per run (signUp via UI or API with timestamp email; `test.skip` when `NEXT_PUBLIC_SUPABASE_URL` is the dummy CI host — mirror the existing smoke spec's env handling; read `e2e/smoke.spec.ts` header first).

- [ ] **Step 1: Write the journey spec**: (1) anon POST `/api/agent` → 401; (2) new user runs validation to completion → `trial_consumed` + startup frozen (assert via `/api/entitlements/me`); (3) second run → 402 `TRIAL_CONSUMED`; (4) frozen validate shows banner + `#paywall-cta`; (5) second startup save → 402; (6) submit plan form → 201 + appears in admin queue (platform session); (7) approve → runs allowed + unfrozen; (8) pause → writes 402, reads 200. Mobile project: repeat (2)+(4) at 390px with zero horizontal scroll assertion (`document.documentElement.scrollWidth <= 390`).
- [ ] **Step 2: Run e2e** `npx.cmd playwright test e2e/trial-paywall.spec.ts` (workdir `apps/web`, msedge channel per repo config) → green. Fix flakes inline (SSE timing: reuse existing wait patterns from smoke spec).
- [ ] **Step 3: Final gates**: stop dev → delete `.next` → `npm.cmd run build` (32 routes OK) → `npx.cmd tsc --noEmit` + `npx.cmd next lint` + `npm.cmd run test:ci` (full suite PASS). Serve prod build, re-run smoke + new spec once.
- [ ] **Step 4: Dark ship**: feature is live but UNLINKED (no nav links to `/plans` except paywall surfaces, which only consumed users see) → owner smoke-tests with a fresh account → enable links. Document the outcome in the plan file footer. Commit spec-e2e: `git commit -m "test: trial paywall e2e journey"`.

---

## Self-Review

**1. Spec coverage:** §2 states → Task 1 (tables) + Task 4 (transitions); §3 → Task 1 (SQL) + Task 4 (`consume_trial`); §4 matrix → Tasks 2 (pure) + 4/5 (wiring); trial-start gate → Task 3; §5 freeze UX → Task 7; §6 plans+form → Tasks 6+7; §7 queue → Tasks 1 (RPC/alerts) + 8; §8 abuse → Tasks 2+3 (+ badges Task 8); §9 D1–D6 → encoded in Tasks 1/4/8; §10 tests → Tasks 2/3/6/9. No gaps.
**2. Placeholder scan:** no TBD/TODO; every code step ships concrete SQL/TS/test bodies; "read X first" pointers cite exact files+lines, never "similar to".
**3. Type consistency:** `EntitlementStatus`, gate result shapes, `ClaimsDb`, RPC arg names (`p_user_id`, `p_startup_id`), `admin_action` arg names match migration 0001's `(action, target, payload, reason)` — reused verbatim in Tasks 4/8.
**4. Review Focus:** all five lines have pinning tests in their owning tasks (listed inline).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trial-paywall.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **native**, because the tasks share tight interfaces (`consume_trial` args, gate result shapes) that are cheaper to keep consistent in one context, and every task already carries its own red→green gate so a shipped mistake is caught same-task. Does the plan capture what you want, and which approach should we use?
