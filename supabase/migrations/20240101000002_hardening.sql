-- ============================================================
-- Validation Copilot — RLS hardening (Task 4, M4 + Schema debts)
-- Additive-only on top of 20240101000000_schema_unified.sql.
-- Run AFTER 0000 + 0001. Idempotent (IF NOT EXISTS / OR REPLACE /
-- drop-if-exists). Does NOT touch 0000 / 0001. 0003 reserved Task 8.
--
-- What this hardens:
--  * Helpers move to private.* with fixed search_path = '' and
--    REVOKE EXECUTE FROM anon, authenticated (direct RPC blocked;
--    RLS policies call them as SECURITY DEFINER via GRANT below).
--    Public wrappers kept as deprecated shims delegating to private.*
--    for any pre-existing policy/view references.
--  * trace_events: drops the open `WITH CHECK (true)` authenticated
--    insert and the `startup_id IS NULL` select bypass. Authenticated
--    insert now requires a startup link + workspace member+ (or owner
--    fallback), matching the agent persist path (always sets
--    startup_id). Service-role path documented via explicit
--    service_role policies (service_role bypasses RLS regardless).
--  * update_updated_at() gains SET search_path = '' (+ qualified
--    public.* trigger calls, M2 pattern from 0001).
--
-- Backfill guidance (workspace_id NOT NULL follow-up — NOT enforced
-- here): prod may still hold legacy NULL-workspace rows (single-tenant
-- demo data + agent personal fallback). Do NOT add NOT NULL yet.
-- Follow-up (separate migration, reserved Task 8 scope):
--   -- 1) Backfill legacy rows to owner personal workspaces, verify zero NULLs:
--   -- SELECT count(*) FROM startups WHERE workspace_id IS NULL;
--   -- 2) Then enforce:
--   -- ALTER TABLE startups ALTER COLUMN workspace_id SET NOT NULL;
-- Until then, policies keep the owner_id = (select auth.uid())
-- fallback for NULL-workspace legacy rows (except trace, which now
-- requires a startup link — NULL trace rows are unreadable via the
-- authenticated API by design).
--
-- Conventions (same as schema-unified.sql):
--  * (select auth.uid()) wrapped — initPlan cached per-statement
--  * SECURITY DEFINER helpers with fixed search_path = ''
--  * qualified public.* refs inside definer functions
--  * policies scoped TO authenticated (+ explicit service_role docs
--    for trace), split per operation
-- ============================================================

-- ── 0. Private helpers ──────────────────────────────────────
create schema if not exists private;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = (select auth.uid())
  );
$$;

create or replace function private.workspace_role(p_workspace_id uuid)
returns text language sql security definer stable set search_path = '' as $$
  select role from public.workspace_members
  where workspace_id = p_workspace_id and user_id = (select auth.uid())
  limit 1;
$$;

-- Direct RPC blocked for anon/authenticated (private schema is also
-- outside the PostgREST-exposed schemas). RLS policy evaluation calls
-- these as SECURITY DEFINER via the GRANT below.
revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.workspace_role(uuid) from public;
revoke execute on function private.is_workspace_member(uuid) from anon, authenticated;
revoke execute on function private.workspace_role(uuid) from anon, authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.workspace_role(uuid) to authenticated, service_role;

-- ── 0b. Deprecated public shims (backward compat) ───────────
-- Pre-hardening policies/views may reference the public names.
-- New policies below call private.* directly; these shims delegate
-- so old references keep working until fully migrated.
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select private.is_workspace_member(p_workspace_id);
$$;

create or replace function public.workspace_role(p_workspace_id uuid)
returns text language sql security definer stable set search_path = '' as $$
  select private.workspace_role(p_workspace_id);
$$;

-- ── 1. Migrate policies to private.* ────────────────────────
drop policy if exists "workspaces_select" on workspaces;
create policy "workspaces_select" on workspaces for select to authenticated
  using (private.is_workspace_member(id));
drop policy if exists "workspaces_update" on workspaces;
create policy "workspaces_update" on workspaces for update to authenticated
  using (private.workspace_role(id) in ('owner','admin'));
drop policy if exists "workspaces_delete" on workspaces;
create policy "workspaces_delete" on workspaces for delete to authenticated
  using (private.workspace_role(id) = 'owner');

drop policy if exists "members_select" on workspace_members;
create policy "members_select" on workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists "members_insert" on workspace_members;
create policy "members_insert" on workspace_members for insert to authenticated
  with check (private.workspace_role(workspace_id) in ('owner','admin'));
drop policy if exists "members_delete" on workspace_members;
create policy "members_delete" on workspace_members for delete to authenticated
  using (private.workspace_role(workspace_id) = 'owner' or user_id = (select auth.uid()));

drop policy if exists "invites_select" on workspace_invites;
create policy "invites_select" on workspace_invites for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists "invites_insert" on workspace_invites;
create policy "invites_insert" on workspace_invites for insert to authenticated
  with check (private.workspace_role(workspace_id) in ('owner','admin'));

-- startups: member+ can read/insert/update; admin+ can delete.
-- Legacy rows with NULL workspace_id fall back to owner check.
drop policy if exists "startups_select" on startups;
create policy "startups_select" on startups for select to authenticated
  using (
    (workspace_id is not null and private.is_workspace_member(workspace_id))
    or owner_id = (select auth.uid())
  );
drop policy if exists "startups_insert" on startups;
create policy "startups_insert" on startups for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (workspace_id is null or private.workspace_role(workspace_id) in ('owner','admin','member'))
  );
drop policy if exists "startups_update" on startups;
create policy "startups_update" on startups for update to authenticated
  using (
    (workspace_id is not null and private.workspace_role(workspace_id) in ('owner','admin','member'))
    or owner_id = (select auth.uid())
  );
drop policy if exists "startups_delete" on startups;
create policy "startups_delete" on startups for delete to authenticated
  using (
    (workspace_id is not null and private.workspace_role(workspace_id) in ('owner','admin'))
    or owner_id = (select auth.uid())
  );

-- Child tables resolve ownership via parent startup (workspace preferred, owner fallback).
drop policy if exists "assumptions_all" on assumptions;
create policy "assumptions_all" on assumptions for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "evidence_all" on evidence;
create policy "evidence_all" on evidence for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "experiments_all" on experiments;
create policy "experiments_all" on experiments for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "leads_all" on leads;
create policy "leads_all" on leads for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "messages_all" on messages;
create policy "messages_all" on messages for all to authenticated
  using (
    lead_id in (
      select l.id from leads l join startups s on s.id = l.startup_id
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    lead_id in (
      select l.id from leads l join startups s on s.id = l.startup_id
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "decisions_all" on decisions;
create policy "decisions_all" on decisions for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

-- ── 2. trace_events tightening ──────────────────────────────
-- trace_select: authenticated must present a startup link whose parent
-- startup is workspace-visible (member) or owner-held. The old
-- `startup_id IS NULL` bypass is dropped: NULL trace rows are not
-- readable via the authenticated API (service path below covers ops).
drop policy if exists "trace_select" on trace_events;
create policy "trace_select" on trace_events for select to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  );

-- trace_insert: authenticated WITH CHECK membership + startup link
-- (replaces the open WITH CHECK (true)). startup_id IS NOT NULL is
-- enforced here so orphan trace rows cannot be created via the API.
-- The agent persist path always sets startup_id, so no app break.
drop policy if exists "trace_insert" on trace_events;
create policy "trace_insert" on trace_events for insert to authenticated
  with check (
    startup_id is not null and startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

-- Service-role docs (service_role bypasses RLS regardless; explicit
-- policies record the intended privileged path for ops/admin reads).
drop policy if exists "trace_service_all" on trace_events;
create policy "trace_service_all" on trace_events for all to service_role
  using (true)
  with check (true);

-- ── 3. update_updated_at hardening ─────────────────────────
create or replace function public.update_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_workspaces_updated_at on workspaces;
create trigger trg_workspaces_updated_at before update on workspaces
  for each row execute function public.update_updated_at();
drop trigger if exists trg_startups_updated_at on startups;
create trigger trg_startups_updated_at before update on startups
  for each row execute function public.update_updated_at();
