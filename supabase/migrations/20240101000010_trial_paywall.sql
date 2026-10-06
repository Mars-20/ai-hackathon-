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

-- ── (a) handle_new_user() rewrite ─────────────────────────────
-- Existing body from 20240101000001_admin.sql:115-141 preserved verbatim,
-- plus the trial entitlement insert before `return new;`.
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
  insert into public.user_entitlements (user_id, status, plan) values (new.id, 'trial_active', 'free') on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ── (b) admin_action approve/pause/reject branches ────────────
-- Full rewrite of admin_action() from 20240101000001_admin.sql:240+
-- (all existing branches preserved verbatim) with three appended branches:
-- approve_subscription / reject_subscription / pause_subscription.
-- Each follows the suspend-branch audit pattern: platform-tier only,
-- shape denies RETURN {ok:false} with a committed denied trail (no RAISE),
-- success sets v_result and falls through to the shared ok tail.
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
    when 'approve_subscription' then
      -- 0010 trial paywall: owner approves a pending subscription request.
      -- Platform-tier only; audit-atomic (denies commit a denied trail).
      -- On success: pending request(s) -> approved, entitlement ->
      -- subscribed/<plan>, startups unfrozen, related owner_alerts marked
      -- seen (seen-safe: coalesce preserves an existing seen_at).
      -- Idempotent: re-approve with no pending row still returns ok.
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      v_plan := admin_action.payload->>'plan';
      if v_plan is null or v_plan not in ('pro', 'team') then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'invalid_plan', 'audit_id', v_audit_id);
      end if;
      update public.subscription_requests
        set status = 'approved', reviewed_by = v_caller, reviewed_at = now()
        where user_id = v_target_user and status = 'pending';
      insert into public.user_entitlements (user_id, status, plan)
        values (v_target_user, 'subscribed', v_plan)
        on conflict (user_id) do update set status = 'subscribed', plan = excluded.plan, updated_at = now();
      update public.startups set is_frozen = false
        where owner_id = v_target_user and is_frozen = true;
      update public.owner_alerts set seen_at = coalesce(seen_at, now())
        where ref_id in (select id from public.subscription_requests where user_id = v_target_user);
      v_result := jsonb_build_object('approved', v_target_user, 'plan', v_plan);
    when 'reject_subscription' then
      -- 0010 trial paywall: owner rejects a pending subscription request.
      -- Platform-tier only; entitlement untouched (stays trial_consumed).
      -- Idempotent: re-reject with no pending row still returns ok.
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      update public.subscription_requests
        set status = 'rejected', reviewed_by = v_caller, reviewed_at = now()
        where user_id = v_target_user and status = 'pending';
      update public.owner_alerts set seen_at = coalesce(seen_at, now())
        where ref_id in (select id from public.subscription_requests where user_id = v_target_user);
      v_result := jsonb_build_object('rejected', v_target_user);
    when 'pause_subscription' then
      -- 0010 trial paywall: owner pauses an active subscription.
      -- Platform-tier only; entitlement -> paused (plan preserved).
      -- Upsert keeps it idempotent for users with no entitlement row.
      if not public.is_platform_admin(v_caller) then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'audit_id', v_audit_id);
      end if;
      if v_target_user is null then
        update public.audit_log set result = 'denied' where id = v_audit_id;
        return jsonb_build_object('ok', false, 'error', 'user_id_required', 'audit_id', v_audit_id);
      end if;
      insert into public.user_entitlements (user_id, status, plan)
        values (v_target_user, 'paused', 'free')
        on conflict (user_id) do update set status = 'paused', updated_at = now();
      v_result := jsonb_build_object('paused', v_target_user);
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
