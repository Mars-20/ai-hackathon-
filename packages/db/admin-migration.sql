-- ============================================================
-- Validation Copilot — Admin Dashboard migration (Task 1)
-- Additive-only on top of packages/db/schema-unified.sql.
-- Run AFTER schema-unified.sql in the Supabase SQL Editor.
-- Idempotent (IF NOT EXISTS / OR REPLACE / drop-if-exists).
--
-- Adds: platform_admins, audit_log, admin_settings, profiles,
--       startups.flagged, is_platform_admin(), admin_action().
-- Extends: handle_new_user() to also insert public.profiles.
--
-- Conventions (same as schema-unified.sql):
--  * (select auth.uid()) wrapped — initPlan cached per-statement
--  * SECURITY DEFINER helpers in public with fixed search_path = ''
--  * indexes on every policy filter column
--  * policies scoped TO authenticated, split per operation
--
-- C1 bootstrap: this migration seeds NOTHING into platform_admins.
-- One-time operator step (runbook):
--   INSERT INTO platform_admins(user_id, granted_by, granted_at)
--   SELECT id, id, now() FROM auth.users
--   WHERE email = '<BOOTSTRAP_EMAIL>';
-- Before that row exists, grant paths return 403 (enforced in the
-- admin_action RPC below: non-platform callers are rejected).
--
-- Assumes (from schema-unified.sql): pgcrypto (gen_random_uuid),
-- public.update_updated_at(), public.is_workspace_member(), and the base tables.
--
-- Round 1 fixes (Task 1 review):
--  * C1: suspend/unsuspend (+grant/revoke) require platform tier.
--  * C2: role_change requires caller owner/admin + rank + last-owner.
--  * I1: plan_note requires platform OR workspace admin/owner.
--  * I2: denies are RETURN {ok:false} with denied audit trail (no RAISE).
--  * I3: revoke locks platform_admins FOR UPDATE + post-delete guard.
--  * I4: audit workspace-side select restricted to owner/admin.
--  * I5: settings_change DEFERRED to Task 5 (not implemented here).
-- ============================================================

-- ── 0. Extension guards ─────────────────────────────────────
-- NOTE (pg_trgm guard): the trigram extension MUST exist before the
-- profiles(email) GIN index below is created. schema-unified.sql
-- already creates it; this guard keeps the migration re-runnable
-- standalone without failing on gin_trgm_ops.
create extension if not exists "pg_trgm";
-- gen_random_uuid() (audit_log PK default) comes from pgcrypto,
-- created by schema-unified.sql; guard kept for standalone runs.
create extension if not exists "pgcrypto";

-- ── 1. platform_admins ──────────────────────────────────────
create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);

-- ── 2. audit_log ────────────────────────────────────────────
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users(id) on delete set null,
  action text not null,
  target jsonb not null default '{}',
  reason text,
  diff jsonb not null default '{}',
  workspace_id uuid references workspaces(id) on delete set null,
  result text not null default 'ok',
  created_at timestamptz not null default now()
);

-- ── 3. admin_settings (key/value) ───────────────────────────
create table if not exists admin_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ── 4. profiles (C3 source for /admin/users email search) ───
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
create index if not exists idx_profiles_email_trgm on profiles using gin (email gin_trgm_ops);

-- ── 4b. profiles one-time backfill (M3) ─────────────────────
-- handle_new_user() below only fires for users created AFTER this
-- migration. Pre-existing auth.users rows would otherwise have no
-- profiles row, so backfill the missing ones once here (idempotent
-- via the LEFT JOIN + ON CONFLICT guard).
insert into public.profiles (user_id, email)
select u.id, u.email
from auth.users u
left join public.profiles p on p.user_id = u.id
where p.user_id is null
on conflict (user_id) do nothing;

-- ── 5. startups.flagged ─────────────────────────────────────
-- Flag = hides the startup from the content queue "unflagged"
-- filter only; no effect on agent output (spec I3).
-- M5: kept BOOLEAN NOT NULL DEFAULT false (no change).
alter table startups add column if not exists flagged boolean not null default false;

-- ── 5b. workspaces.status (Task 4) ────────────────────────────
-- Lifecycle status for the admin workspaces table (plan stays a separate
-- entitlement column). Additive-only; defaults keep existing rows valid.
alter table workspaces add column if not exists status text not null default 'active'
  check (status in ('active', 'suspended'));

-- ── 6. Indexes on policy/audit filter columns ───────────────
create index if not exists idx_platform_admins_user on platform_admins(user_id);
create index if not exists idx_audit_log_actor on audit_log(actor);
create index if not exists idx_audit_log_ws on audit_log(workspace_id);
create index if not exists idx_audit_log_created on audit_log(created_at desc);
create index if not exists idx_audit_log_action on audit_log(action);

-- ── 7. handle_new_user(): also populate profiles ────────────
-- Same body as schema-unified.sql plus the profiles upsert first.
-- The upsert covers new users and email changes; pre-existing users
-- are covered by the one-time backfill in section 4b above (M3).
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_slug text;
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  v_slug := lower(coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
            || '-' || floor(extract(epoch from now()))::text;
  v_slug := regexp_replace(v_slug, '[^a-z0-9-]', '-', 'g');
  insert into public.workspaces (name, slug, owner_id, plan)
  values (coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)) || '''s Workspace',
          v_slug, new.id, 'free')
  returning id into v_workspace_id;
  insert into public.workspace_members (workspace_id, user_id, role, joined_at)
  values (v_workspace_id, new.id, 'owner', now());
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ── 8. is_platform_admin() ──────────────────────────────────
-- Hardened helper: same SECURITY DEFINER + fixed search_path +
-- (select auth.uid()) pattern as is_workspace_member.
create or replace function public.is_platform_admin(p_user uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins where user_id = p_user
  );
$$;

-- ── 9. Enable RLS ───────────────────────────────────────────
alter table platform_admins enable row level security;
alter table audit_log enable row level security;
alter table admin_settings enable row level security;
alter table profiles enable row level security;

-- ── 10. Policies (drop-if-exists for re-runnable migration) ─
-- platform_admins: SELECT via is_platform_admin() only.
-- No insert/update/delete policies: writes via admin_action RPC /
-- service-role only (helper-gated, spec Section 6).
drop policy if exists "platform_admins_select" on platform_admins;
create policy "platform_admins_select" on platform_admins for select to authenticated
  using (public.is_platform_admin((select auth.uid())));

-- audit_log: SELECT for platform admins (full) + workspace
-- owner/admin restricted to rows in their own workspaces (I4:
-- plain member/viewer get NO audit read, matching spec Section 7
-- matrix). No insert/update/delete policies: INSERT only via the
-- admin_action RPC / service-role from admin routes, so audit
-- failure rolls back the mutation.
drop policy if exists "audit_log_select" on audit_log;
create policy "audit_log_select" on audit_log for select to authenticated
  using (
    public.is_platform_admin((select auth.uid()))
    or (
      workspace_id is not null
      and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = audit_log.workspace_id
          and wm.user_id = (select auth.uid())
          and wm.role in ('owner', 'admin')
      )
    )
  );

-- admin_settings: platform-admin SELECT, no anon access.
-- No write policies: platform writes via service-role only.
drop policy if exists "admin_settings_select" on admin_settings;
create policy "admin_settings_select" on admin_settings for select to authenticated
  using (public.is_platform_admin((select auth.uid())));

-- profiles (PII emails): own-row SELECT plus platform-admin full
-- read. /api/admin/users reads via service-role but returns only
-- rows for in-scope workspaces (platform: all).
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_platform_admin((select auth.uid()))
  );

-- ── 11. admin_action() RPC (audit-atomic privileged path) ───
-- Single-transaction RPC: inserts the audit_log row FIRST, then
-- dispatches the mutation. Any failure (audit insert or mutation)
-- rolls back the whole transaction — no orphan privileged change
-- (spec Section 6 / C7). The two-client pattern is forbidden here.
--
-- Actions: grant_platform, revoke_platform, suspend, unsuspend,
--          role_change, revoke_membership, plan_note (plans read-only in v1:
--          note only), flag_startup, screen_decision, update_workspace
--          (Task 4: content flag/screen + workspace plan/status, all
--          audit-atomic with I2 deny trails), email_resend (Task 5: pending
--          invite resend record, platform-tier only, audit-atomic).
-- Suspend semantics (spec Section 4): the DB records the authorized
-- suspend audit-atomically; the route applies the Auth ban via
-- auth.admin.updateUserById (ban_duration '8760h' / 'none').
--
-- I2: ALL denies use RETURN jsonb {ok:false, error:<code>} with the
-- audit row committed as result='denied' (no RAISE so the txn
-- commits and the trail survives). Deny codes: forbidden,
-- last_platform_admin, cannot_suspend_self, invalid_role,
-- membership_not_found (plus not_authenticated, invalid_workspace_id,
-- invalid_user_id, user_id_required, workspace_id_and_user_id_required,
-- last_owner, unknown_action). Task 4 branches add: startup_not_found,
-- invalid_startup_id, invalid_flag, invalid_decision, invalid_confidence,
-- workspace_id_required, workspace_not_found, invalid_plan, invalid_status,
-- invalid_payload. Task 5 email_resend adds: invite_not_found,
-- invalid_invite_id, invite_not_pending.
--
-- I5: settings_change branch is DEFERRED to Task 5 — not implemented
-- here (privileged settings writes per spec Section 6 will be added
-- by the Task 5 implementer, either as an RPC branch or a documented
-- service-role path).
-- Task 5 ruling: v1 ships the agent settings READ view only
-- (GET /api/admin/agent); no settings write path exists, so no
-- settings_change branch is added. Any future settings_* write MUST be
-- platform-tier only with the same deny-trail pattern as email_resend
-- below (workspace-tier fast-guard + RPC-committed denied trail).
create or replace function admin_action(action text, target jsonb, payload jsonb, reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_caller uuid;
  v_target_user uuid;
  v_workspace_id uuid;
  v_payload_ws uuid;
  v_effective_ws uuid;
  v_role text;
  v_caller_role text;
  v_target_role text;
  v_caller_rank int;
  v_new_rank int;
  v_count int;
  v_is_admin boolean;
  v_result jsonb;
  v_audit_id uuid;
  v_startup_id uuid;
  v_ws_of_startup uuid;
  v_startup_found boolean := false;
  v_flag_raw text;
  v_flagged boolean := false;
  v_decision text;
  v_verdict text;
  v_confidence text;
  v_decision_id uuid;
  v_plan text;
  v_status text;
  v_invite_id uuid;
  v_invite_ws uuid;
  v_invite_status text;
  v_bad_sid boolean := false;
  v_bad_ws boolean := false;
  v_bad_uid boolean := false;
  v_bad_payload_ws boolean := false;
  v_bad_invite boolean := false;
begin
  v_caller := (select auth.uid());

  -- Lenient UUID parsing: invalid text marks a flag instead of
  -- raising, so the deny below still commits its audit trail (I2).
  begin
    v_workspace_id := nullif(admin_action.target->>'workspace_id', '')::uuid;
  exception when invalid_text_representation then
    v_workspace_id := null; v_bad_ws := true;
  end;
  begin
    v_target_user := nullif(admin_action.target->>'user_id', '')::uuid;
  exception when invalid_text_representation then
    v_target_user := null; v_bad_uid := true;
  end;
  begin
    v_payload_ws := nullif(admin_action.payload->>'workspace_id', '')::uuid;
  exception when invalid_text_representation then
    v_payload_ws := null; v_bad_payload_ws := true;
  end;
  begin
    v_startup_id := nullif(admin_action.target->>'startup_id', '')::uuid;
  exception when invalid_text_representation then
    v_startup_id := null; v_bad_sid := true;
  end;
  begin
    v_invite_id := nullif(admin_action.target->>'invite_id', '')::uuid;
  exception when invalid_text_representation then
    v_invite_id := null; v_bad_invite := true;
  end;
  v_effective_ws := coalesce(v_workspace_id, v_payload_ws);

  -- 1) Audit row FIRST: failure here aborts the mutation below.
  insert into public.audit_log (actor, action, target, reason, diff, workspace_id, result)
  values (
    v_caller,
    admin_action.action,
    coalesce(admin_action.target, '{}'),
    admin_action.reason,
    coalesce(admin_action.payload, '{}'),
    v_effective_ws,
    'attempt'
  )
  returning id into v_audit_id;

  -- Auth / shape denies (I2 pattern: mark denied, RETURN, no RAISE).
  if v_caller is null then
    update public.audit_log set result = 'denied' where id = v_audit_id;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated', 'audit_id', v_audit_id);
  end if;
  if v_bad_ws or v_bad_payload_ws then
    update public.audit_log set result = 'denied' where id = v_audit_id;
    return jsonb_build_object('ok', false, 'error', 'invalid_workspace_id', 'audit_id', v_audit_id);
  end if;
  if v_bad_uid then
    update public.audit_log set result = 'denied' where id = v_audit_id;
    return jsonb_build_object('ok', false, 'error', 'invalid_user_id', 'audit_id', v_audit_id);
  end if;
  if v_bad_sid then
    update public.audit_log set result = 'denied' where id = v_audit_id;
    return jsonb_build_object('ok', false, 'error', 'invalid_startup_id', 'audit_id', v_audit_id);
  end if;
  if v_bad_invite then
    update public.audit_log set result = 'denied' where id = v_audit_id;
    return jsonb_build_object('ok', false, 'error', 'invalid_invite_id', 'audit_id', v_audit_id);
  end if;

  -- 2) Dispatch on action.
  case admin_action.action
    when 'grant_platform' then
      -- C1: platform-tier only. Before bootstrap, no caller is
      -- platform-tier, so every grant is denied (403 mapped in route).
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      insert into public.platform_admins (user_id, granted_by)
      values (v_target_user, v_caller)
      on conflict (user_id) do nothing;
      v_result := jsonb_build_object('granted', v_target_user);
    when 'revoke_platform' then
      -- C1: platform-tier only.
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      -- I3: lock the rows before count+delete (TOCTOU guard).
      perform 1 from public.platform_admins for update;
      -- M4: non-member revoke is membership_not_found; the
      -- last-admin check applies only when the target IS an admin.
      select exists(select 1 from public.platform_admins where user_id = v_target_user) into v_is_admin;
      if not v_is_admin then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'membership_not_found', 'audit_id', v_audit_id);
      end if;
      select count(*) into v_count from public.platform_admins;
      if v_count <= 1 then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'last_platform_admin', 'audit_id', v_audit_id);
      end if;
      delete from public.platform_admins where user_id = v_target_user;
      -- I3 post-delete guard: the invariant (≥1 admin) must hold;
      -- if violated, restore the row and report denied (trail kept).
      select count(*) into v_count from public.platform_admins;
      if v_count = 0 then
        insert into public.platform_admins (user_id, granted_by)
        values (v_target_user, v_caller)
        on conflict (user_id) do nothing;
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'last_platform_admin', 'audit_id', v_audit_id);
      end if;
      v_result := jsonb_build_object('revoked', v_target_user);
    when 'suspend' then
      -- C1: platform-tier only (was missing: any authenticated user
      -- could record a suspend — now denied unless platform admin).
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      if v_target_user = v_caller then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'cannot_suspend_self', 'audit_id', v_audit_id);
      end if;
      if public.is_platform_admin(v_target_user) then
        perform 1 from public.platform_admins for update;
        select count(*) into v_count from public.platform_admins;
        if v_count <= 1 then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'last_platform_admin', 'audit_id', v_audit_id);
        end if;
      end if;
      v_result := jsonb_build_object('suspended', v_target_user, 'ban_duration', '8760h');
    when 'unsuspend' then
      -- C1: platform-tier only (same gap as suspend).
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      v_result := jsonb_build_object('unsuspended', v_target_user, 'ban_duration', 'none');
    when 'role_change' then
      -- M1: NULL-role guard (NULL NOT IN (...) is NULL, so test null first).
      v_role := admin_action.payload->>'role';
      if v_role is null or v_role not in ('owner', 'admin', 'member', 'viewer') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_role', 'audit_id', v_audit_id);
      end if;
      if v_workspace_id is null or v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'workspace_id_and_user_id_required', 'audit_id', v_audit_id);
      end if;
      -- C2a: caller must be owner/admin of the target workspace.
      select wm.role into v_caller_role from public.workspace_members wm
      where wm.workspace_id = v_workspace_id and wm.user_id = v_caller;
      if not found or v_caller_role not in ('owner', 'admin') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      -- C2b: ROLE_RANK anti-escalation (viewer1 member2 admin3 owner4:
      -- new role rank must be <= caller rank).
      v_caller_rank := case v_caller_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
      v_new_rank := case v_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
      if v_new_rank > v_caller_rank then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      -- Target must already be a member (M4 analogue for workspaces).
      select wm.role into v_target_role from public.workspace_members wm
      where wm.workspace_id = v_workspace_id and wm.user_id = v_target_user;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'membership_not_found', 'audit_id', v_audit_id);
      end if;
      -- C2c: block removing/changing the last owner (would leave zero).
      if v_target_role = 'owner' and v_role <> 'owner' then
        select count(*) into v_count from public.workspace_members
        where workspace_id = v_workspace_id and role = 'owner';
        if v_count <= 1 then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'last_owner', 'audit_id', v_audit_id);
        end if;
      end if;
      update public.workspace_members set role = v_role
      where workspace_id = v_workspace_id and user_id = v_target_user;
      v_result := jsonb_build_object('user_id', v_target_user, 'workspace_id', v_workspace_id, 'role', v_role);
    when 'revoke_membership' then
      -- Task 3 C1: workspace membership revoke, audit-atomic (spec Section 6).
      -- Caller must be platform admin OR owner/admin of the target workspace
      -- (else denied forbidden with trail, I2 pattern). Last-owner revoke
      -- denied last_owner. DELETE + audit commit in the same transaction.
      if v_workspace_id is null or v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'workspace_id_and_user_id_required', 'audit_id', v_audit_id);
      end if;
      if not public.is_platform_admin(v_caller) then
        select wm.role into v_caller_role from public.workspace_members wm
        where wm.workspace_id = v_workspace_id and wm.user_id = v_caller;
        if not found or v_caller_role not in ('owner', 'admin') then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
      end if;
      -- Lock the target row before read-then-delete (TOCTOU guard).
      select wm.role into v_target_role from public.workspace_members wm
      where wm.workspace_id = v_workspace_id and wm.user_id = v_target_user
      for update;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'membership_not_found', 'audit_id', v_audit_id);
      end if;
      -- ROLE_RANK anti-escalation for workspace tier (platform bypasses):
      -- cannot revoke a member whose role outranks your own.
      if not public.is_platform_admin(v_caller) then
        v_caller_rank := case v_caller_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
        v_new_rank := case v_target_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
        if v_new_rank > v_caller_rank then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
      end if;
      -- Last-owner guard: revoking the final owner would leave zero owners.
      if v_target_role = 'owner' then
        perform 1 from public.workspace_members
        where workspace_id = v_workspace_id and role = 'owner'
        for update;
        select count(*) into v_count from public.workspace_members
        where workspace_id = v_workspace_id and role = 'owner';
        if v_count <= 1 then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'last_owner', 'audit_id', v_audit_id);
        end if;
      end if;
      delete from public.workspace_members
      where workspace_id = v_workspace_id and user_id = v_target_user;
      v_result := jsonb_build_object('revoked', v_target_user, 'workspace_id', v_workspace_id, 'role', v_target_role);
    when 'plan_note' then
      -- I1: plans are read-only in v1 (audit note only, no write),
      -- and noting requires platform admin OR workspace admin/owner
      -- of the payload workspace (was: any authenticated user).
      if public.is_platform_admin(v_caller) then
        v_result := jsonb_build_object('noted', coalesce(admin_action.payload, '{}'));
      elsif v_effective_ws is not null and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = v_effective_ws
          and wm.user_id = v_caller
          and wm.role in ('owner', 'admin')
      ) then
        v_result := jsonb_build_object('noted', coalesce(admin_action.payload, '{}'));
      else
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
    when 'flag_startup' then
      -- Task 4 content flag toggle (spec Sections 3,6-7): platform tier OR
      -- workspace member+ of the startup's workspace. ROLE_RANK max-own
      -- (viewer1 member2 admin3 owner4): caller rank must be >= member(2),
      -- so viewers are denied. NULL-workspace legacy rows: platform only
      -- (workspace tier cannot scope them — denied forbidden with trail).
      v_flag_raw := admin_action.payload->>'flagged';
      if v_flag_raw is null or v_flag_raw not in ('true', 'false') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_flag', 'audit_id', v_audit_id);
      end if;
      v_flagged := (v_flag_raw = 'true');
      if v_startup_id is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'startup_not_found', 'audit_id', v_audit_id);
      end if;
      select s.workspace_id into v_ws_of_startup
      from public.startups s where s.id = v_startup_id;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'startup_not_found', 'audit_id', v_audit_id);
      end if;
      -- Attribute the audit row to the startup's workspace (workspace-tier
      -- audit reads are scoped on workspace_id).
      update public.audit_log set workspace_id = v_ws_of_startup where id = v_audit_id;
      v_effective_ws := v_ws_of_startup;
      if not public.is_platform_admin(v_caller) then
        if v_ws_of_startup is null then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
        select wm.role into v_caller_role from public.workspace_members wm
        where wm.workspace_id = v_ws_of_startup and wm.user_id = v_caller;
        if not found then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
        v_caller_rank := case v_caller_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
        if v_caller_rank < 2 then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
      end if;
      update public.startups set flagged = v_flagged where id = v_startup_id;
      v_result := jsonb_build_object('startup_id', v_startup_id, 'flagged', v_flagged);
    when 'screen_decision' then
      -- Task 4 content policy screen: approve maps to verdict 'go', reject
      -- to 'stop', recorded as a decisions row (audit-atomic). Platform OR
      -- workspace admin/owner (rank >= 3) of the startup's workspace;
      -- members are read-only here. NULL-workspace rows are EXCLUDED
      -- (denied invalid_workspace_id with trail).
      v_decision := admin_action.payload->>'decision';
      if v_decision is null or v_decision not in ('approve', 'reject') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_decision', 'audit_id', v_audit_id);
      end if;
      v_confidence := coalesce(admin_action.payload->>'confidence', 'medium');
      if v_confidence not in ('low', 'medium', 'high') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_confidence', 'audit_id', v_audit_id);
      end if;
      if v_startup_id is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'startup_not_found', 'audit_id', v_audit_id);
      end if;
      select s.workspace_id into v_ws_of_startup
      from public.startups s where s.id = v_startup_id;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'startup_not_found', 'audit_id', v_audit_id);
      end if;
      update public.audit_log set workspace_id = v_ws_of_startup where id = v_audit_id;
      v_effective_ws := v_ws_of_startup;
      if v_ws_of_startup is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_workspace_id', 'audit_id', v_audit_id);
      end if;
      if not public.is_platform_admin(v_caller) then
        select wm.role into v_caller_role from public.workspace_members wm
        where wm.workspace_id = v_ws_of_startup and wm.user_id = v_caller;
        if not found then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
        v_caller_rank := case v_caller_role when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
        if v_caller_rank < 3 then
          update public.audit_log set result = 'denied' where id = v_audit_id;
          return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
        end if;
      end if;
      v_verdict := case v_decision when 'approve' then 'go' else 'stop' end;
      insert into public.decisions (startup_id, workspace_id, verdict, confidence, rationale, evidence_ids)
      values (
        v_startup_id,
        v_ws_of_startup,
        v_verdict,
        v_confidence,
        coalesce(admin_action.payload->>'rationale', ''),
        '{}'
      )
      returning id into v_decision_id;
      v_result := jsonb_build_object('decision_id', v_decision_id, 'startup_id', v_startup_id, 'verdict', v_verdict);
    when 'update_workspace' then
      -- Task 4 workspace plan/status write (spec I1: workspace tier has no
      -- plan path in v1, so this branch is platform-tier only; workspace
      -- callers are denied forbidden with trail).
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_workspace_id is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'workspace_id_required', 'audit_id', v_audit_id);
      end if;
      v_plan := admin_action.payload->>'plan';
      v_status := admin_action.payload->>'status';
      if v_plan is null and v_status is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'audit_id', v_audit_id);
      end if;
      if v_plan is not null and v_plan not in ('free', 'pro', 'team') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_plan', 'audit_id', v_audit_id);
      end if;
      if v_status is not null and v_status not in ('active', 'suspended') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_status', 'audit_id', v_audit_id);
      end if;
      select true into v_startup_found from public.workspaces w where w.id = v_workspace_id;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'workspace_not_found', 'audit_id', v_audit_id);
      end if;
      update public.workspaces w set
        plan = coalesce(v_plan, w.plan),
        status = coalesce(v_status, w.status)
      where w.id = v_workspace_id;
      v_result := jsonb_build_object('workspace_id', v_workspace_id, 'plan', v_plan, 'status', v_status);
    -- I5: no settings_change branch here — DEFERRED to Task 5.
    when 'email_resend' then
      -- Task 5 pending-invite resend record (spec Sections 5-7):
      -- platform-tier only (workspace tier is denied forbidden with
      -- trail — the route also fast-guards with the Task-4 PATCH trail
      -- pattern). The invite must exist and still be pending; v1 wires
      -- no mailer (spec Section 9 non-goal), so success records the
      -- resend in the audit trail only. The audit row is re-attributed
      -- to the invite's workspace so workspace-tier audit reads stay
      -- scoped.
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_invite_id is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invite_not_found', 'audit_id', v_audit_id);
      end if;
      select i.workspace_id, i.status into v_invite_ws, v_invite_status
      from public.workspace_invites i where i.id = v_invite_id;
      if not found then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invite_not_found', 'audit_id', v_audit_id);
      end if;
      update public.audit_log set workspace_id = v_invite_ws where id = v_audit_id;
      v_effective_ws := v_invite_ws;
      if v_invite_status <> 'pending' then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invite_not_pending', 'audit_id', v_audit_id);
      end if;
      v_result := jsonb_build_object('resent', v_invite_id, 'workspace_id', v_invite_ws);
    -- I5: no settings_change branch here — DEFERRED to Task 5.
    else
      update public.audit_log set result = 'denied' where id = v_audit_id;
      return jsonb_build_object('ok', false, 'error', 'unknown_action', 'audit_id', v_audit_id);
  end case;

  update public.audit_log set result = 'ok' where id = v_audit_id;

  return jsonb_build_object('ok', true, 'action', admin_action.action, 'result', v_result, 'audit_id', v_audit_id);
end; $$;

-- RPC callable by signed-in users only (anon has no path); the
-- function itself enforces platform-tier per action above.
revoke all on function admin_action(text, jsonb, jsonb, text) from public;
grant execute on function admin_action(text, jsonb, jsonb, text) to authenticated, service_role;

-- ── 12. admin_settings updated_at trigger ───────────────────
-- Reuses the base public.update_updated_at() from schema-unified.sql (M2: qualified).
drop trigger if exists trg_admin_settings_updated_at on admin_settings;
create trigger trg_admin_settings_updated_at before update on admin_settings
  for each row execute function public.update_updated_at();
