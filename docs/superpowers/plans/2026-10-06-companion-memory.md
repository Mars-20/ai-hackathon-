# Companion Memory Implementation Plan v1.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-user co-founder memory foundation: durable Postgres memory + Redis accelerator, hybrid approve-before-inject lifecycle, deterministic injection into the agent, and the Arabic "ذكرياتي" console.

**Architecture:** Postgres (`companion_profile`, `companion_memory`) is the ledger; Upstash Redis (raw REST, same pattern as `lib/rate-limit.ts`) is the accelerator holding only a compiled ≤300-token block + a daily counter. A pure compiler/ranker/scans module keeps all token math and safety scans unit-testable; a `server-only` DAL calls user-JWT RPCs (never service-role for user writes) that enforce the transition machine + caps + ownership inside the DB; five API routes expose the queue; the agent calls one `composePrompt()` helper and fires inference in `after()` called synchronously in request scope.

**Tech Stack:** Next.js 15 App Router + Supabase Postgres/RLS + Upstash Redis REST (raw `fetch`, NO new npm deps) + vitest 5 + zod + `server-only` (both already in deps) + Arabic-first UI in existing Tailwind pages.

**Spec:** `docs/superpowers/specs/2026-10-06-companion-memory-design.md` (v0.3.1 — archive TTL-bound deviation, `MEMORY_DUPLICATE` code, self-contact allowlist). The plan argues from the spec; executors read both.

**History:** v1.0 → adversarial plan review (10 Critical + 12 High + 6 Medium, verdict NOT READY) → this v1.1: 27/28 applied. C10 REBUTTED with evidence (`supabase db query` exists — verified `supabase.cmd db --help` lists `query`; 0010 was applied with it) but the step is still hardened with expected output + SQL Editor fallback.

## Global Constraints

- Base branch is `feat/trial-paywall` (migration `0010`, `lib/entitlements.ts`, trial gates all live there) — new work branches off it in a FRESH worktree created at execution time via `superpowers:using-git-worktrees`. Never develop on `main` directly.
- Workdir for all JS commands is `apps/web` via `npm.cmd`/`npx.cmd` (Windows PowerShell 5.1). Never `next build` while `next dev` runs.
- No `token/secret` in code/tests/commits. User writes go through the authenticated USER client into SECURITY DEFINER RPCs that verify `(select auth.uid()) = p_user_id` first (0010 `admin_action` precedent: caller check + jsonb envelope, deny-with-return, no RAISE). Service-role is for trace inserts + test setup only, never user memory writes.
- Identity ALWAYS from `supabase.auth.getUser()` server-side; NEVER accept a caller-supplied `userId`.
- Route order on every new route: **401 auth check BEFORE rate-limit** (anon never burns buckets).
- Enforcement matrix (spec §4) is server-side, never trusted from the client.
- TDD red→green; one task = one review gate; local commits only, NEVER push.
- Vitest include is `src/lib/__tests__/**/*.test.ts` + `src/app/api/**/*.test.ts`. New tests live ONLY in those globs.
- Arabic UI copy comes ONLY from the §9 table (17 keys, verbatim) via `lib/companion/copy.ts`.
- `trace_events.event_type` has a CHECK allow-list (`0000_schema_unified.sql:176-177`); Task 1a widens it, never a raw violating insert.
- Migration numbering: `20240101000011_companion_memory.sql` (schema) applied AFTER `0010`. RPCs live in the SAME file (one migration, two reviewable parts across Tasks 1/2).
- No new npm dependencies (Upstash via raw REST `fetch`, same as `lib/rate-limit.ts:133-145`).
- RLS idiom reference is `20240101000000_schema_unified.sql:240` (`(select auth.uid())` subselect form) — NOT 0010 (which uses the bare form).

## Review Focus

1. Double-approve race: two tabs approve row #200 simultaneously and approved count overshoots 200 → second approve must 409 `MEMORY_FULL` (test in Task 5, serialized by the profile-row `FOR UPDATE` lock inside the RPC).
2. Arabic memory value with diacritics + Arabic-Indic digits must rank identically to its plain form (test in Task 3, normalizer fixture).
3. Disabled memory (`memory_enabled=false`) with 5 pending rows: injection empty AND inference skipped, but queue still readable (test in Task 5).
4. Redis outage, DAL level: injected Redis failure → `getCompiledContext` returns the Postgres-compiled block, decide writes succeed (unit, injected fakes, Task 5). HTTP layer explicitly inherits platform fail-closed: `checkRateLimit` throw → 429 on all five routes (route test in Task 7 pins this — no silent divergence).
5. Archive deletes are TTL-bounded (≤3600 s, inside the spec's stated worst-case staleness bound for missed paths) — no `DEL` is claimed on the cron path, and no test asserts one (spec v0.3.1 deviation, Task 1).

---

## File Structure

- Create: `supabase/migrations/20240101000011_companion_memory.sql` — Task 1: tables, CHECKs, RLS, trace CHECK widen, pg_cron archive job. Task 2: `decide_memory` + `propose_memories` RPCs appended in the same file.
- Create: `apps/web/src/lib/companion/normalize.ts` — `normalizeForMatch()`, `estimateTokens()`, constants.
- Create: `apps/web/src/lib/companion/escape.ts` — `toUntrusted()` + `truncateField()` (exact replica of agent `route.ts:111-122` semantics), single owner of prompt-wrapping.
- Create: `apps/web/src/lib/companion/scans.ts` — `containsBlockedSecret()`, `containsThirdPartyPii(value, allowedContacts)`.
- Create: `apps/web/src/lib/companion/ranker.ts` — `scoreMemory()`, `compileContext()` (wraps values via `escape.ts`, caches the WRAPPED block), `flagPossibleConflicts()`, `MemoryRow` (full nullable DB shape), `MEMORY_KIND_WEIGHTS`, `INFER_CONFIDENCE_THRESHOLD = 0.7`, `COMPILED_CONTEXT_TOKEN_LIMIT = 300`, `MEMORY_RECENCY_HALF_LIFE_DAYS = 30`.
- Create: `apps/web/src/lib/companion/copy.ts` — `MEMORY_COPY` with all 17 spec §9 keys verbatim.
- Create: `apps/web/src/lib/companion/redis.ts` — `companionCtxKey(userId)`, `companionBudgetKey(userId, nowMs = Date.now())` (`YYYYMMDD` UTC, no dashes), `redisGet/Setex/Del()`, `incrBudgetAtomic(userId)` (Lua returns counter; cap compared client-side; TTL 86400 in ARGV).
- Create: `apps/web/src/lib/companion/dal.ts` — `server-only` DAL over user-JWT RPCs + RLS reads: `getCompanionProfile`, `listMemories` (`all` ≡ `pending+approved`, never rejected), `createManualMemory` (via `propose_memories`, human-entered ⇒ confidence NULL), `decideMemory`, `forgetMemory`, `setMemoryEnabled`, `getCompiledContext`, `proposeMemories(userId: string, rows: ProposeRow[])` (batch, for the Task 6 hook), `purgeCompanionCache`. Optional `deps` param for tests. RPC
jsonb envelopes mapped to typed errors (`MEMORY_FULL`, `MEMORY_DUPLICATE`, `STARTUP_NOT_OWNED`, `NOT_FOUND`, `FORBIDDEN`).
- Create: `apps/web/src/lib/companion/validation.ts` — zod schemas mirroring DB CHECKs.
- Create: `apps/web/src/lib/companion/infer.ts` — `buildExtractionPrompt()`, `parseExtractionResult()`, `dedupeAgainstApproved()`, `runPostSessionInference()` (returns `{skipped} | {proposed, usage}`; NEVER inserts traces — the `after()` hook in Task 8 does spend+trace).
- Create: `apps/web/src/lib/companion/prompt.ts` — `composePrompt(base, companionCtx)` (concatenation ONLY; wrapping already done in `compileContext`).
- Create: `apps/web/src/app/api/companion/memory/route.ts` — GET list + POST manual.
- Create: `apps/web/src/app/api/companion/memory/[id]/route.ts` — PATCH decide + DELETE forget.
- Create: `apps/web/src/app/api/companion/profile/route.ts` — POST toggle.
- Create: `apps/web/src/lib/companion/errors.ts` — `companionErr(status, code, arMessage)` local helper (do NOT reuse the admin envelope; `packages/admin/errors.ts` is admin-routes-only).
- Modify: `apps/web/src/app/api/agent/route.ts` — import `composePrompt` + `getCompiledContext` (fetch ctx ONCE per request after auth+gate), apply at every `callAIWithFallback` site, verifier sites pass `""` with H2 comment, `after()` called synchronously in `POST()` before `return new Response(...)`, hook does `recordSpendAsync` + trace.
- Create: `apps/web/src/app/memories/page.tsx` (+ colocated client list) — "ذكرياتي" console.
- Create: `apps/web/src/lib/companion/rubric.md` — N=30 inference fixture rubric (Task 6).
- Create: `scripts/verify-companion-rpcs.mjs` — live RPC behavior matrix with temp auth users (Task 10, repo-root scripts dir).
- Tests: `src/lib/__tests__/companion-pure.test.ts`, `companion-redis.test.ts`, `companion-dal.test.ts`, `companion-infer.test.ts`, `companion-overhead.test.ts`, `src/app/api/companion/{memory,memory-id,profile}.test.ts`, `apps/web/e2e/companion-memory.spec.ts`.

---

### Task 1: Migration 0011a — tables, RLS, trace CHECK, archive cron

**Files:**
- Create: `supabase/migrations/20240101000011_companion_memory.sql` (schema part; RPCs appended by Task 2)
- Read-only reference: `supabase/migrations/20240101000000_schema_unified.sql:171-182,240` (trace table + RLS idiom)

**Interfaces:**
- Consumes: `auth.users(id)`, `public.startups(id, owner_id)`, `public.trace_events(event_type CHECK)`, pg_cron-if-present pattern from `0007`.
- Produces: `public.companion_profile`, `public.companion_memory`, widened trace CHECK, `archive_companion_memory()` + nightly cron. (RPCs are Task 2's product in the same file.)

- [ ] **Step 1: Write the schema part.** TEXT + CHECK (no native enums), `if not exists`, `(select auth.uid())` RLS idiom:

```sql
-- 0011a companion memory ledger (spec v0.3.1 §3). Lazy profiles, no backfill.
create table if not exists public.companion_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  memory_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.companion_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('fact','preference','style','episode')),
  value text not null check (char_length(value) between 1 and 500),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  confidence real null check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_ref text null,
  startup_id uuid null references public.startups(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz null
);
create index if not exists idx_companion_memory_user_status on public.companion_memory(user_id, status, created_at desc);

alter table public.companion_profile enable row level security;
alter table public.companion_memory enable row level security;

drop policy if exists "companion_profile_own" on public.companion_profile;
create policy "companion_profile_own" on public.companion_profile
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "companion_memory_own" on public.companion_memory;
create policy "companion_memory_own" on public.companion_memory
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Widen trace_events.event_type CHECK (0000:176-177). Constraint name is
-- auto-generated: discover-then-replace in a DO block (re-runs safe).
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
    where conrelid = 'public.trace_events'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%event_type%';
  if cname is not null then
    execute format('alter table public.trace_events drop constraint %I', cname);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.trace_events'::regclass
      and contype = 'c' and conname = 'trace_events_event_type_check') then
    alter table public.trace_events add constraint trace_events_event_type_check
      check (event_type in ('tool_call','tool_result','verification','decision','error',
        'skill_start','skill_end','companion_inject','companion_infer','companion_decide'));
  end if;
end $$;

-- Archive helper: delete rejected rows older than 30 days. Returns deleted count.
-- STALENESS CONTRACT (spec v0.3.1 §2 deviation): cron runs inside Postgres with no
-- app code, so NO Redis DEL happens here; deleted rows may persist in the compiled
-- cache until TTL expiry (≤3600 s), inside the spec's worst-case bound. Rejected
-- rows are never injected, so user-visible impact is nil.
create or replace function public.archive_companion_memory()
returns integer language plpgsql security definer set search_path = public as $$
declare deleted_count integer := 0;
begin
  delete from public.companion_memory
    where status = 'rejected' and created_at < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;
revoke all on function public.archive_companion_memory() from public, anon, authenticated;

-- pg_cron schedule (0007 precedent: no-op NOTICE when extension absent). Daily 03:00 UTC.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'archive-companion-memory-nightly') then
      perform cron.unschedule('archive-companion-memory-nightly');
    end if;
    perform cron.schedule('archive-companion-memory-nightly', '0 3 * * *', 'select public.archive_companion_memory()');
  else
    raise notice 'pg_cron absent: companion archive NOT scheduled (rejected rows retained until scheduled).';
  end if;
exception
  when others then
    raise notice 'companion archive cron scheduling skipped: %', sqlerrm;
end $$;
```

- [ ] **Step 2: Apply to live DB and verify.** Run from repo root: `supabase.cmd db query --linked -f supabase/migrations/20240101000011_companion_memory.sql` (verified command — `supabase db --help` lists `query`; 0010 was applied with it. If `--linked` errors with "not linked", fallback: paste the file into the Supabase SQL Editor and run). Expected output: `Success. No rows returned` (DDL + NOTICEs only). Then verify with probes: `select tablename from pg_tables where schemaname='public' and tablename like 'companion%'` → 2 rows; `select conname from pg_constraint where conrelid='public.trace_events'::regclass and conname='trace_events_event_type_check'` → 1 row; anon-key REST select on `companion_memory` → 0 rows (RLS own-only). If the CLI holds a link session open, unlink/clean temp afterwards (0010 precedent).
- [ ] **Step 3: Commit.** `git add supabase/migrations/20240101000011_companion_memory.sql` + `git commit -m "feat(companion): migration 0011a profile+memory tables, RLS, trace CHECK, archive cron"`. Expected: worktree otherwise clean.

### Task 2: Migration 0011b — `decide_memory` + `propose_memories` RPCs (full bodies)

**Files:**
- Modify: `supabase/migrations/20240101000011_companion_memory.sql` (append RPC part)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (FROZEN signatures — every later task references exactly these):
  - `decide_memory(p_user_id uuid, p_id uuid, p_action text, p_value text default null) returns jsonb`
  - `propose_memories(p_user_id uuid, p_rows jsonb) returns jsonb`
  - Envelope: `{ok bool, code text, row? jsonb, results? jsonb, dropped? uuid[]}`. Codes: `OK, NOT_AUTHENTICATED, FORBIDDEN, INVALID, NOT_FOUND, MEMORY_FULL, MEMORY_DUPLICATE, STARTUP_NOT_OWNED` (no dead branches: every (status, action) pair is legal or idempotent by construction — H7).
  - Contract: caller check `(select auth.uid()) = p_user_id` FIRST (deny-with-return, no RAISE — 0010 `admin_action` precedent); writes called via the authenticated USER client (service-role never calls these); transition machine = spec §3/M1; caps = 20 pending (overflow drops lowest-confidence, ids returned for the app to trace-log) / 200 approved (`MEMORY_FULL`); `startup_id` ownership (`owner_id = p_user_id`) INSIDE the RPC (FK proves existence only); normalized-dupe backstop = `lower(trim(value))` equality vs approved + within-batch (app pre-checks with the full normalizer; RPC is the race backstop); profile row locked (`SELECT … FOR UPDATE`, lazy-inserted) so concurrent deciders serialize.

- [ ] **Step 1: Append the RPC bodies.** Exact content (no delegation — this IS the implementation):

```sql
-- 0011b companion RPCs. Called with the authenticated USER JWT (auth.uid() is the
-- caller); service-role must never call these. Deny-with-return envelope, no RAISE.

create or replace function public.decide_memory(p_user_id uuid, p_id uuid, p_action text, p_value text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := (select auth.uid());
  v_row public.companion_memory%rowtype;
  v_approved_count integer;
  v_new_value text := p_value;
begin
  if v_caller is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;
  if v_caller <> p_user_id then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_action not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'code', 'INVALID'); end if;

  insert into public.companion_profile(user_id) values (p_user_id) on conflict (user_id) do nothing;
  perform 1 from public.companion_profile where user_id = p_user_id for update;

  select * into v_row from public.companion_memory where id = p_id and user_id = p_user_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  if v_row.status = 'approved' and p_action = 'approve' then
    return jsonb_build_object('ok', true, 'code', 'OK', 'row', to_jsonb(v_row));
  end if;
  if v_row.status = 'rejected' and p_action = 'reject' then
    return jsonb_build_object('ok', true, 'code', 'OK', 'row', to_jsonb(v_row));
  end if;
  if v_row.status = 'pending' and p_action = 'reject' then
    update public.companion_memory set status = 'rejected', decided_at = now()
      where id = p_id returning * into v_row;
    return jsonb_build_object('ok', true, 'code', 'OK', 'row', to_jsonb(v_row));
  end if;
  if v_row.status = 'approved' and p_action = 'reject' then
    update public.companion_memory set status = 'rejected', decided_at = now()
      where id = p_id returning * into v_row;
    return jsonb_build_object('ok', true, 'code', 'OK', 'row', to_jsonb(v_row));
  end if;
  -- Remaining: (->approved) from pending or rejected. Edit-then-approve allowed.
  if v_new_value is not null then
    if char_length(v_new_value) not between 1 and 500 then
      return jsonb_build_object('ok', false, 'code', 'INVALID');
    end if;
  else
    v_new_value := v_row.value;
  end if;
  select count(*) into v_approved_count from public.companion_memory
    where user_id = p_user_id and status = 'approved';
  if v_approved_count >= 200 then
    return jsonb_build_object('ok', false, 'code', 'MEMORY_FULL');
  end if;
  update public.companion_memory set status = 'approved', value = v_new_value, decided_at = now()
    where id = p_id returning * into v_row;
  return jsonb_build_object('ok', true, 'code', 'OK', 'row', to_jsonb(v_row));
end $$;
revoke all on function public.decide_memory(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.propose_memories(p_user_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := (select auth.uid());
  v_results jsonb := '[]'::jsonb;
  v_dropped uuid[] := '{}';
  v_el jsonb; v_idx integer := 0;
  v_kind text; v_value text; v_conf real; v_src text; v_sid uuid;
  v_owner uuid; v_pending_count integer; v_drop_id uuid; v_new_id uuid;
begin
  if v_caller is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;
  if v_caller <> p_user_id then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID');
  end if;

  insert into public.companion_profile(user_id) values (p_user_id) on conflict (user_id) do nothing;
  perform 1 from public.companion_profile where user_id = p_user_id for update;

  for v_el in select * from jsonb_array_elements(p_rows) loop
    v_kind := v_el->>'kind'; v_value := v_el->>'value'; v_src := v_el->>'source_ref';
    begin v_conf := nullif(v_el->>'confidence', '')::real; exception when others then v_conf := null; end;
    begin v_sid := nullif(v_el->>'startup_id', '')::uuid; exception when others then v_sid := null; end;

    if v_kind not in ('fact','preference','style','episode')
       or v_value is null or char_length(v_value) not between 1 and 500
       or (v_conf is not null and (v_conf < 0 or v_conf > 1)) then
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', false, 'code', 'INVALID');
    elsif v_sid is not null and not exists
        (select 1 from public.startups where id = v_sid and owner_id = p_user_id) then
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', false, 'code', 'STARTUP_NOT_OWNED');
    elsif exists (select 1 from public.companion_memory
        where user_id = p_user_id and status = 'approved'
          and lower(trim(value)) = lower(trim(v_value))) then
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', false, 'code', 'MEMORY_DUPLICATE');
    else
      select count(*) into v_pending_count from public.companion_memory
        where user_id = p_user_id and status = 'pending';
      if v_pending_count >= 20 then
        select id into v_drop_id from public.companion_memory
          where user_id = p_user_id and status = 'pending'
          order by confidence nulls last, created_at asc limit 1;
        delete from public.companion_memory where id = v_drop_id;
        v_dropped := v_dropped || v_drop_id;
      end if;
      insert into public.companion_memory(user_id, kind, value, status, confidence, source_ref, startup_id)
        values (p_user_id, v_kind, v_value, 'pending', v_conf, v_src, v_sid)
        returning id into v_new_id;
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', true, 'code', 'OK', 'id', v_new_id);
    end if;
    v_idx := v_idx + 1;
  end loop;
  return jsonb_build_object('ok', true, 'code', 'OK', 'results', v_results, 'dropped', to_jsonb(v_dropped));
end $$;
revoke all on function public.propose_memories(uuid, jsonb) from public, anon, authenticated;
```

- [ ] **Step 2: Apply + assert signatures.** Re-run the whole file (`db query --linked -f …`, idempotent by construction). Then: `select p.proname, pg_get_function_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('decide_memory','propose_memories')` → exactly `decide_memory(p_user_id uuid, p_id uuid, p_action text, p_value text)` and `propose_memories(p_user_id uuid, p_rows jsonb)`. Behavioral matrix (transitions, caps, ownership, dupe, cross-user FORBIDDEN) is verified LIVE in Task 10 with temp user JWTs — not here (bare SQL has no `auth.uid()` caller).
- [ ] **Step 3: Commit.** `git commit -m "feat(companion): migration 0011b decide/propose RPCs (caller check, machine, caps, ownership)"` with the migration file.

### Task 3: Pure layer — normalize, escape, scans, ranker, copy (zero I/O)

**Files:**
- Create: `apps/web/src/lib/companion/normalize.ts`
- Create: `apps/web/src/lib/companion/escape.ts`
- Create: `apps/web/src/lib/companion/scans.ts`
- Create: `apps/web/src/lib/companion/ranker.ts`
- Create: `apps/web/src/lib/companion/copy.ts`
- Tests: `apps/web/src/lib/__tests__/companion-pure.test.ts` (one file, sections per module)

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeForMatch(s): string[]`, `estimateTokens(s): number` (`Math.ceil(len/4)`, compiler-budget approximation ONLY), `toUntrusted(s)` + `truncateField(s, max=500)` (exact `route.ts:111-122` semantics: `<untrusted>${truncated}</untrusted>`), `containsBlockedSecret(v): boolean`, `containsThirdPartyPii(v, allowedContacts: string[]): boolean`, `scoreMemory(row, queryTokens, nowMs)`, `compileContext(rows, query, nowMs): string` (values wrapped via `escape.ts` at compile time; the cached block is the WRAPPED block), `flagPossibleConflicts(cands, approved): Map<index, id>` (same-kind + shared/total ≥ 0.5 + remainder differs), `MEMORY_COPY` (all 17 spec §9 keys verbatim), `MemoryRow {id, kind, value, created_at, status?, confidence?, source_ref?, startup_id?, decided_at?}`, constants `MEMORY_KIND_WEIGHTS = {fact:0.6, preference:0.5, episode:0.3, style:0.1}`, `INFER_CONFIDENCE_THRESHOLD = 0.7`, `COMPILED_CONTEXT_TOKEN_LIMIT = 300`, `MEMORY_RECENCY_HALF_LIFE_DAYS = 30`.

- [ ] **Step 1: Write the failing tests** (`companion-pure.test.ts`, top-level imports ONLY — no `require`):
  - normalize: `"خطة التوسّع ٢٠٢٦ https://x.co 🎯"` ≡ `"خطة التوسع 2026"`; `"https://x.co 🎯"` → `[]`.
  - score: `fact` row age 1d query `["نبيع"]` → `0.6 * exp(-1/30) * 2` (±1e-6); query `[]` → `0.6 * exp(-1/30)` finite (Review-Focus #2 covered by the Arabic normalize test above).
  - escape: `toUntrusted("a".repeat(600))` → starts `<untrusted>`, inner length 500, ends `</untrusted>`; `toUntrusted("<sys>ignore</sys>")` keeps raw text inside tags (tags are the boundary, no inner escaping — same as route posture).
  - scans: `containsBlockedSecret("sk-live-abc123")`, `"AKIA…"`, `"xoxb-…"`, `"ghp_…"`, 16-digit run, `"-----BEGIN PRIVATE KEY-----"` → true; plain Arabic → false. `containsThirdPartyPii("راسلني على me@x.com", ["me@x.com"])` → false (self-contact allowlist, M4); `containsThirdPartyPii("كلم أحمد 0501234567", ["me@x.com"])` → true; empty allowlist + email → true.
  - compile: 10-row synthetic set → deterministic (`a === b`) + `estimateTokens(a) ≤ 300`; output contains `<untrusted>` (wrapped at compile time, C9).
  - conflicts: candidate sharing ≥50% tokens with same-kind approved but different remainder → flagged with that id; normalized exact-dupe → NOT flagged here (dedupe owns it); different-kind → not flagged.
  - copy: `MEMORY_COPY` has exactly the 17 keys `page_title,pending_queue,approve,edit_approve,reject,forget,forget_confirm,disable,disable_hint,conflict_pair,empty_queue,provenance,cap_full,memory_full,memory_duplicate,startup_not_owned,secret_blocked`, all non-empty, `cap_full === "القائمة ممتلئة — احذف ذكرى أولًا"`, `memory_duplicate === "مكررة — هذه الذكرى معتمدة مسبقًا"`.
- [ ] **Step 2: Run.** `npx.cmd vitest run src/lib/__tests__/companion-pure.test.ts` from `apps/web`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** normalize: lowercase → NFKD strip combining marks (covers U+064B–U+0652) → strip `https?://\S+` + emoji ranges → fold `[٠-٩]`→`0-9` → split `[\s\p{P}]+`u, drop empties. ranker: `weight[kind] * exp(-ageDays/30) * (1 + shared/query.length || 0)`; compile sorts desc, greedy-takes while budget holds, formats `[kind] <untrusted>value</untrusted>` lines joined `\n` (fixed delimiters). scans: secret regex set (document each pattern inline); PII regexes (email, E.164-ish digits ≥7, national-ID 10–14 digit runs) checked AFTER allowlist-substring pass.
- [ ] **Step 4: Run.** Expected: PASS (all sections).
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): pure normalize+escape+scans+ranker+copy (17 keys)"`.

### Task 4: Redis layer — raw REST, atomic counter, fail-open reads

**Files:**
- Create: `apps/web/src/lib/companion/redis.ts`
- Test: `apps/web/src/lib/__tests__/companion-redis.test.ts`

**Interfaces:**
- Consumes: `UPSTASH_REDIS_REST_URL/TOKEN` (same vars as rate-limit; NO new env), global `fetch` (mocked in tests).
- Produces: `companionCtxKey(userId)` → `companion:ctx:v1:{uid}`; `companionBudgetKey(userId, nowMs = Date.now())` → `companion:inferbudget:{uid}:{YYYYMMDD}` (UTC, NO dashes — `toISOString().slice(0,10).replaceAll("-","")`); `redisGet(key): Promise<string|null>` (throw → null); `redisSetex(key, ttlSec, value)` + `redisDel(key)` (throw → swallow+warn); `incrBudgetAtomic(userId): Promise<number>` (Lua `INCR` + `EXPIRE 86400` on first hit, returns the counter; the 50/day cap is a CLIENT-SIDE compare — stated in a comment, so no one assumes Lua enforces it). Failure contract: budget-path throw → caller skips inference (fail-open for this non-critical path — opposite of rate-limit's fail-closed, documented at the call site).

- [ ] **Step 1: Write the failing test.** Mock `global.fetch`: ctx key exact string; budget key for fixed clock `2026-10-06T00:00Z` → `companion:inferbudget:u1:20261006`; `redisGet` fetch-reject → null; `incrBudgetAtomic` sends ONE POST whose body array is `["EVAL", <lua>, 1, key, "86400"]` (limit NOT in ARGV — client compares) and stub `{result: 5}` → `5`; fetch-reject → throw (caller decides skip).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replicate the 15-line REST pattern from `lib/rate-limit.ts:126-145` (do not import its internals). Lua: `local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): Redis ctx+budget layer (YYYYMMDD, atomic INCR, fail-open reads)"`.

### Task 5: DAL — server-only, user-JWT RPC writes, matrix, caps, cache discipline

**Files:**
- Create: `apps/web/src/lib/companion/validation.ts`
- Create: `apps/web/src/lib/companion/dal.ts`
- Test: `apps/web/src/lib/__tests__/companion-dal.test.ts`

**Interfaces:**
- Consumes: `@/lib/supabase/server` (`createServerSupabaseClient`, `createServiceRoleClient` for traces only), `lib/entitlements.ts` (`resolveAgentGate`), Tasks 3–4, Task 2 RPC envelopes.
- Produces: `getCompanionProfile`, `listMemories(userId, status /* pending|approved|rejected|all */, limit, cursor?)` (`all` ≡ `status IN ('pending','approved')` — rejected NEVER surfaced, H10), `createManualMemory` (via `propose_memories` single-row, confidence NULL, pre-checks dupe with full normalizer; maps `MEMORY_DUPLICATE/STARTUP_NOT_OWNED`), `decideMemory` (via `decide_memory`; maps envelope codes to typed `CompanionError(code)`), `forgetMemory` (hard delete via user client + `purgeCompanionCache`), `setMemoryEnabled` (upsert profile + purge), `getCompiledContext(userId, query)` (disabled → `""` no Redis touch; hit → return; miss → approved-select → `compileContext` → best-effort setex; table-missing `PGRST205`/schema-cache/relation errors → `""` + warn, M6), `purgeCompanionCache` (single-row forget) + `proposeMemories(userId, rows: ProposeRow[]): Promise<ProposeResult>` (batch insert for the Task 6 hook; `ProposeRow = {kind, value, confidence: number|null, source_ref?: string, startup_id?: string|null}`). Writes use the USER client (so `auth.uid()` inside the RPC is the real caller); `deps` injection for tests.

- [ ] **Step 1: Write the failing tests** (in-memory fakes, no network): (a) approve at 200 approved → `MEMORY_FULL` (Review-Focus #1 — fake RPC honors the cap under the lock; the REAL race is proven in Task 10 live); (b) disabled + 5 pending → `""` + no Redis read (Review-Focus #3); (c) Redis throws → compiled block still returned, decide still writes (Review-Focus #4, DAL level); (d) non-owned startup → `STARTUP_NOT_OWNED` (H4); (e) forget + toggle call `redisDel("companion:ctx:v1:uid")` (spy; archive path asserts NOTHING — TTL-bound by contract); (f) PostgREST `{code:"PGRST205", message:"Could not find the table…"}` (REAL shape, not a bare string) → `""` no throw (M6/H6); (g) matrix: `paused` list → `ACCOUNT_PAUSED`, null → `SUBSCRIPTION_REQUIRED`, `trial_consumed` list OK but decide → `TRIAL_CONSUMED`; (h) `?status=all` result contains zero `rejected` rows (H10); (i) cross-user: user-A client calling with `p_user_id=B` → `FORBIDDEN` (C3 — fake honors caller check; live proof in Task 10).
- [ ] **Step 2: Run.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** `validation.ts`: `memoryKind/memoryValue(1..500)/memoryId(uuid)/decideAction(approve|reject)/statusFilter` zod schemas. `dal.ts` (`import "server-only"` FIRST line): lazy profile insert-on-conflict-do-nothing (0010:109 guard idiom — read the exact line in-task); `listMemories` via user client with `status` filter mapping (`all` → `.in("status",["pending","approved"])`); cursor pagination (`created_at,id`); `decideMemory/createManualMemory` via `userClient.rpc(...)` mapping envelope → `CompanionError`; `getCompiledContext` per the miss path above; `purgeCompanionCache = redisDel(ctxKey)` after every approve/reject/forget/toggle.
- [ ] **Step 4: Run.** `npx.cmd vitest run src/lib/__tests__/companion-dal.test.ts` + FULL `npx.cmd vitest run`. Expected: PASS, zero regressions.
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): server-only DAL (user-JWT RPCs, matrix, caps, cache discipline)"`.

### Task 6: Inference — prompt, parse, budget, dedupe, conflicts, rubric

**Files:**
- Create: `apps/web/src/lib/companion/infer.ts`
- Create: `apps/web/src/lib/companion/rubric.md`
- Test: `apps/web/src/lib/__tests__/companion-infer.test.ts`

**Interfaces:**
- Consumes: Task 3 (threshold, normalizer, scans, conflict flagger), Task 4 (`incrBudgetAtomic`), `INFER_DAILY_LIMIT = 50`.
- Produces: `buildExtractionPrompt(memoText, startupName)`, `parseExtractionResult(jsonText)` (keeps well-formed `{kind,value,confidence}`, drops `confidence < 0.7` + malformed without throwing), `dedupeAgainstApproved(cands, approvedValues)` (full-normalizer equality), `runPostSessionInference({userId, userEmail, memoText, startupName, approvedValues, callAI, propose})` → `{skipped:"over-cap"|"redis"|"disabled"} | {proposed: results, dropped, usage: {totalTokenCount}}`. NEVER inserts traces or spend — returns `usage` for the Task 8 hook. `rubric.md` documents the 30 fixtures + per-fixture expectation + the ≥80% bar (spec §11).

- [ ] **Step 1: Write the failing tests.** Arabic memo fixtures: 3-candidate extraction JSON (one 0.62 → dropped; one `sk-live-…` → blocked; one third-party email, allowlist `["owner@x.com"]` → blocked; self-email candidate → kept); normalized-dupe suppressed, near-miss kept; conflict flag on overlapping candidate; `runPostSessionInference` with budget `51` → `{skipped:"over-cap"}`, `callAI` NOT called (spy); Redis throw → `{skipped:"redis"}`; mocked `callAI` returning canned JSON → `propose` called with parsed+filtered rows (LLM itself always mocked — deterministic); N=30 fixture loop over `rubric.md` pairs through parse/filter/dedupe asserting ≥24 pass with zero secret flags.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Prompt: Arabic instruction — facts ABOUT the account holder only; NEVER persons from evidence/interviews; NEVER secrets/keys; strict JSON array `{kind,value,confidence}`. Pipeline: `incrBudgetAtomic` FIRST (spend-first-drop-later; over → skip) → `callAI` → parse → threshold → secret scan → third-party-PII scan with `[userEmail]` allowlist → app-level normalized-dupe suppress → `propose` (Task 5 DAL `proposeMemories(userId: string, rows: ProposeRow[])` batch via `propose_memories` — DAL exposes `proposeMemories(userId, rows)`; per Task 5 Produces) → return outcomes + `usage`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): inference pipeline + N=30 rubric (mocked LLM, deterministic)"`.

### Task 7: API routes — five endpoints, 401-first, matrix, Arabic errors

**Files:**
- Create: `apps/web/src/lib/companion/errors.ts` — `companionErr(status, code, arMessage)` → `Response` JSON `{error: arMessage, code, ...(402 && {plans_url:"/plans"})}`.
- Create: `apps/web/src/app/api/companion/memory/route.ts` (GET + POST)
- Create: `apps/web/src/app/api/companion/memory/[id]/route.ts` (PATCH + DELETE)
- Create: `apps/web/src/app/api/companion/profile/route.ts` (POST toggle)
- Tests: `apps/web/src/app/api/companion/memory.test.ts`, `memory-id.test.ts`, `profile.test.ts`

**Interfaces:**
- Consumes: Task 5 DAL (+ `proposeMemories`), Task 5 validation (reference it, do not duplicate), `checkRateLimit` (`mem:{uid}`, 30/min), entitlement read (same service-role `user_entitlements` select as agent route ~1900), §9 Arabic strings via `MEMORY_COPY`.
- Produces: spec §8 contracts — 201/200/401/402/404/409/422/429; 409 codes `MEMORY_FULL` (`memory_full`) + `MEMORY_DUPLICATE` (new copy `مكررة — هذه الذكرى معتمدة مسبقًا`, spec v0.3.1); 422 `STARTUP_NOT_OWNED` (`startup_not_owned`), unknown `action`, `value` >500 on edit-then-approve (REALIZABLE 422s — H7: no approved→pending test, no such action exists); PATCH response includes `possible_conflict_with` when the Task 6 flagger fires on edit values.

- [ ] **Step 1: Write the failing route tests** (mock `@/lib/supabase/server` + DAL per the existing `src/app/api/**/*.test.ts` idiom — read one in-task): GET all excludes rejected; POST manual → 201 approved/NULL-confidence; POST non-owned startup → 422; POST at cap → 409 `MEMORY_FULL`; POST normalized-dupe → 409 `MEMORY_DUPLICATE`; PATCH approve → 200 + purge spy; PATCH unknown action → 422; PATCH edit value 501 chars → 422; DELETE unknown → 404; unauthenticated → 401 AND `checkRateLimit` NOT called; `paused` GET → 402 `ACCOUNT_PAUSED`; trial_consumed GET 200 / PATCH 402; `checkRateLimit` throwing → 429 (C6 — outage behavior PINNED, not wished away).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Handler order: `getUser()` → 401 → rate-limit → 429 → entitlement → matrix 402 → zod → 422 → DAL → mapped status. POST manual skips secret scan (explicit user act) with a comment citing spec §10(5).
- [ ] **Step 4: Run.** `npx.cmd vitest run src/app/api/companion` + full suite. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): memory queue APIs + toggle (401-first, matrix, Arabic errors)"`.

### Task 8: Agent wiring — composePrompt, verifier exclusion, after() hook, spend

**Files:**
- Create: `apps/web/src/lib/companion/prompt.ts`
- Create: `apps/web/src/lib/__tests__/companion-overhead.test.ts`
- Modify: `apps/web/src/app/api/agent/route.ts` (re-locate sites in-worktree; spec snapshot: skills `881,982,1282,1431,1535`, verifier `1690`, router `253-297`)

**Interfaces:**
- Consumes: Task 5 `getCompiledContext`, Task 6 `runPostSessionInference`, `after` from `next/server`, `recordSpendAsync` + `extractUsageCost` (`lib/cost`), `findUnsupportedFactualClaims` (`lib/utils`).
- Produces: `composePrompt(base, companionCtx)` (concatenation ONLY — values already wrapped in `compileContext`), verifier inputs with `""` ctx + `// H2: companion block is NEVER evidence` comment, synchronous `after()` in `POST()` capturing `{userId, userEmail, memoText, startupName}` BY VALUE before `return new Response(...)` (C4 — never from the background IIFE), hook body: `runPostSessionInference` → `recordSpendAsync(budgetKey, extractUsageCost(usage, "gemini_call"))` (H5) + best-effort `companion_infer` trace.

- [ ] **Step 1: Write the failing tests.** (a) `composePrompt("BASE","")` → `"BASE"` byte-identical; with ctx → concatenation with fixed delimiters, no re-wrapping; (b) H2 executable: memo line `"السوق 5B دولار والقنوات"` (matches the utils `/(\d|…)/` + length>12 gate) supported ONLY by a companion row, evidence WITHOUT memory → `findUnsupportedFactualClaims` flags it (proves the exclusion wiring the verifier uses); (c) hook dispatcher test: `POST`-scope calls `after` synchronously (assert via injected `after` spy — route code takes an optional `deps.after` defaulting to real `after`), background-`done` path never calls it; (d) `companion-overhead.test.ts`: 20-row Arabic fixture → `estimateTokens(compileContext(...)) ≤ 300` + stable ordering; documents that TRUE live-`promptTokenCount` p50 ≤350 is measured in Task 10; (e) spend test (H5): hook with mocked `runPostSessionInference` returning `{usage: {totalTokenCount: 1500}}` calls injected `recordSpendAsync` exactly once with `(budgetKey, extractUsageCost({totalTokenCount: 1500}, "gemini_call"))` and inserts one `companion_infer` trace row (spy). (no conditional — BOTH exist).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `prompt.ts` (~10 lines). Route edits: fetch ctx ONCE after auth+gate (`getCompiledContext(uid, idea)`); replace prompt construction at every `callAIWithFallback` site with `composePrompt(base, ctx)`; verifier sites `composePrompt(base, "")`. `after()` in `POST()` before the SSE response is returned; hook catches everything + warns. Spend: `recordSpendAsync(budgetKey, extractUsageCost(usage, "gemini_call"))` where `budgetKey` reuses the route's existing key.
- [ ] **Step 4: Run.** `npx.cmd vitest run` + `npx.cmd tsc --noEmit` + `npx.cmd eslint` (workdir `apps/web`). Expected: all green.
- [ ] **Step 5: Commit.** `git commit -m "feat(companion): agent injection, verifier exclusion, after() hook + spend"`.

### Task 9: "ذكرياتي" console — queue UI, all 17 keys, conflict banner

**Files:**
- Create: `apps/web/src/app/memories/page.tsx` (+ colocated client list component)
- Modify: navigation (locate in-task — dashboard or validate layout) adding `ذكرياتي`.

**Interfaces:**
- Consumes: Task 7 endpoints, Task 3 `MEMORY_COPY`.
- Produces: server page: `page_title`/`pending_queue`/per-row `provenance` (Arabic-locale date) / `approve` / `edit_approve` / `reject` / `forget` (+ `forget_confirm` modal: `role=dialog aria-modal`, ESC, focus — trial-paywall Task 7 precedent) / `disable` + `disable_hint` / `empty_queue` / `cap_full` + `memory_full` + `memory_duplicate` states / `conflict_pair` banner when `possible_conflict_with` present (approved row shown beside the candidate — the deterministic spec §5 surfacing) / `startup_not_owned` + `secret_blocked` toasts.

- [ ] **Step 1: Extend the copy test** (Task 3 test file already asserts all 17 — add page-level assertion: import `MEMORY_COPY` in the page, no inline Arabic strings; grep-check in-task `grep -rn "اعتماد" src/app/memories/` returns ONLY `copy.ts`). No new test file needed — document the grep in the step.
- [ ] **Step 2: Run the copy test.** Expected: PASS (copy already green; page must not break it).
- [ ] **Step 3: Implement.** Server component fetches GET `?status=all` with cookies; client component for approve/reject/forget/edit/toggle. Responsive rules: `min-h-dvh`, `container-app`, `safe-top`, `aria-label`s (trial-paywall session rules).
- [ ] **Step 4: Run.** `npx.cmd tsc --noEmit` + `npx.cmd eslint` + copy test. Expected: green.
- [ ] **Step 5: Commit** (include `copy.ts` + its test if amended): `git add apps/web/src/app/memories apps/web/src/lib/companion/copy.ts apps/web/src/lib/__tests__/companion-pure.test.ts` + `git commit -m "feat(companion): ذكرياتي console (queue, decide, toggle, 17-key copy)"`.

### Task 10: Full verification — gates, live RPC matrix, E2E, meters, §13

**Files:**
- Create: `scripts/verify-companion-rpcs.mjs` (repo root; uses `@supabase/supabase-js` — already a dep — with `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `apps/web/.env.local` to create TWO temp auth users via Admin API, sign in as each, and run the matrix)
- Create: `apps/web/e2e/companion-memory.spec.ts` (follow `e2e/trial-paywall.spec.ts` idiom)
- Record: `.superpowers/sdd/2026-10-06-companion-memory/verification.md` (gitignored ledger, local-only)

**Interfaces:**
- Consumes: everything; spec §13.
- Produces: green gates + §13 evidence lines.

- [ ] **Step 1: Static + unit gates.** From `apps/web`: `npx.cmd tsc --noEmit` (0) → `npx.cmd eslint` (0) → `npx.cmd vitest run` (all pass, record count) → remove `.next` → `npm.cmd run build` (all routes, green). Any red → fix in the OWNING task, never here.
- [ ] **Step 2: Live RPC matrix** (`node scripts/verify-companion-rpcs.mjs`, temp users A+B, cleanup deletes both): A approve→approved; re-approve → idempotent OK; approved→pending impossible (no path — assert code has no such branch by attempting reject→approve→reject cycle → ends rejected, never pending); pending→rejected→approved cycle; no dead transition branch fires (all six legal pairs return OK); fill A to 200 approved → 201st approve → `MEMORY_FULL`; A proposes with B's startup → `STARTUP_NOT_OWNED`; B calls `decide_memory(A's row)` with B's JWT but `p_user_id=A` → `FORBIDDEN` (C3 live proof); normalized-dupe propose → `MEMORY_DUPLICATE`; pending overflow 21st → 20 kept + 1 dropped id returned. ALL green or the owning task reopens.
- [ ] **Step 3: E2E (UI+API observable only).** `companion-memory.spec.ts`: seed via UI login → POST manual memory → appears under `بانتظار موافقتك` → approve → appears approved with `من جلسة …` → DAL-level node probe (user JWT) `getCompiledContext` contains the value (the executable §13 "session 4 contains it" proof — no test-only endpoints) → forget with confirm → absent from GET → toggle off → injection state off. All green, 0 skipped.
- [ ] **Step 4: Meters + overhead.** Query live `trace_events` for `companion_inject/companion_infer/companion_decide` rows from the E2E runs; measure TRUE `promptTokenCount` p50 delta on the Task 8 20-row fixture via a scripted mocked-provider run, record the number (must be ≤350) in `verification.md`; reference Task 6 N=30 counts (≥24/30).
- [ ] **Step 5: Ledger + branch review.** Write `verification.md` with the §13 checklist (4 lines PASS/FAIL each) + counts; `git log --oneline` review of the branch. No code changes in this task.

---

## Self-Review

**1. Spec coverage:** §2 → Tasks 1/4/5 (+ v0.3.1 archive deviation recorded in Task 1). §3 → Tasks 1/2 (+ M1 machine in RPC, M2 lock+caps, H4 ownership in RPC). §4 → Tasks 5/7. §5 → Tasks 6/7/8/9 (conflict surfacing = deterministic flagger + banner). §6 → Tasks 4/6/8 (budget key, cap, spend wiring H5). §7 → Tasks 3/8 (ranker+M3 decay, H3 normalizer, H2 test with numeric fixture, M6 tolerance). §8 → Task 7 (M5 auth-first, H4 422, M2/M11 409s, H7 realizable 422s, H10 all-exclusion). §9 → Tasks 3/9 (17 keys, H9 fixed). §10 → Tasks 3/5/6/7/8 (escape ownership C9, H2, H5+M4 allowlist, rate-limited decide). §11 → Tasks 1/2/6/8/10 (CHECK, rubric, overhead split H4, meters, cron). §12 → nothing (by construction). §13 → Task 10 checklist. H1 → Task 3 imports. H6 → Task 5 PGRST205. M2/M6 → Tasks 3/9. M3/M1 → Task 4. M5 → Task 2 RPC. No gaps. **C10 rebuttal:** `supabase db query` VERIFIED to exist (`supabase.cmd db --help` → `query`; 0010 applied with it) — step kept + hardened with expected output and SQL Editor fallback.

**2. Placeholder scan:** Full RPC bodies quoted (Tasks 1/2); exact SQL/console commands with expected outputs; exact test assertions; exact function signatures frozen once and referenced by name afterward. The single deliberate forward-reference (Task 6 consuming Task 5's `proposeMemories`) is declared in BOTH tasks' Interfaces with the exact signature `proposeMemories(userId: string, rows: ProposeRow[]): Promise<ProposeResult>`.

**3. Type consistency:** `MemoryRow` (full nullable shape, Task 3) reused by compiler+DAL+infer; envelope `{ok, code, row?, results?, dropped?}` single-sourced in Task 2; codes identical across Tasks 2/5/7/9; Redis builders single-sourced in Task 4; copy single-sourced in Task 3.

**4. Review Focus:** All five lines own task tests (marked inline). Section non-empty.
