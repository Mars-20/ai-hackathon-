-- ============================================================
-- Validation Copilot — UNIFIED Supabase Schema (v2.2, canonical)
-- Run this in your Supabase SQL Editor. Idempotent (IF NOT EXISTS).
-- Merges: packages/db/schema.sql (leads/messages/trace) +
--         docs/supabase-schema.sql (workspaces multi-tenancy)
-- Source of truth after 2026-09-27 audit. Supersedes both files.
-- docs/supabase-schema.sql is SUPERSEDED — do not run it directly;
-- run this file (then supabase/migrations/0001 + 0002) instead.
-- Task 4 hardening (mirrors 20240101000002_hardening.sql):
--  * RLS helpers live in private.* (SECURITY DEFINER, fixed
--    search_path = '', REVOKE EXECUTE FROM anon, authenticated);
--    public.* names kept as deprecated shims delegating to private.*.
--  * trace_events: no WITH CHECK (true) for authenticated; insert
--    requires startup link + member+ (or owner); select drops the
--    startup_id IS NULL bypass (service_role path documented).
-- Conventions (Supabase RLS best practices):
--  * (select auth.uid()) wrapped — initPlan cached per-statement
--  * SECURITY DEFINER helpers in public with fixed search_path
--  * indexes on every policy filter column
--  * policies scoped TO authenticated, split SELECT/INSERT/UPDATE/DELETE
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ── Workspaces (multi-tenant root) ──────────────────────────
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro','team')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner','admin','member','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member'
    check (role in ('owner','admin','member','viewer')),
  token uuid not null default gen_random_uuid() unique,
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','expired')),
  expires_at timestamptz not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ── Startups (workspace-scoped) ─────────────────────────────
create table if not exists startups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  one_liner text not null,
  domain text not null,
  target_customer text,
  stage text not null default 'idea'
    check (stage in ('idea','prototype','live','scaling')),
  business_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backfill: workspace_id nullable for legacy rows (single-tenant demo data).
-- New rows MUST supply workspace_id (enforced in API + app policy below).
-- NOT NULL follow-up (deferred, see 0002): backfill legacy rows to owner
-- personal workspaces, verify zero NULLs, then ALTER ... SET NOT NULL
-- in a separate migration. Do NOT enforce NOT NULL while prod has NULLs.

-- ── Assumptions ─────────────────────────────────────────────
create table if not exists assumptions (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  statement text not null,
  category text not null check (category in ('desirability','viability','feasibility')),
  risk_level text not null check (risk_level in ('critical','high','medium','low')),
  status text not null default 'untested'
    check (status in ('untested','testing','validated','invalidated')),
  reasoning text,
  created_at timestamptz not null default now()
);

-- ── Evidence ────────────────────────────────────────────────
create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  evidence_type text not null check (evidence_type in ('secondary','primary')),
  source_type text check (source_type in ('web_search','interview','survey','preorder','usage_data')),
  source_url text,
  claim text not null,
  strength text not null check (strength in ('opinion','intent','time_given','contact_shared','commitment')),
  sample_size int check (sample_size >= 0),
  collected_at timestamptz not null default now()
);

-- ── Experiments ─────────────────────────────────────────────
create table if not exists experiments (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  type text not null check (type in ('interview','survey','landing_page','presale')),
  design jsonb not null default '{}',
  status text not null default 'draft'
    check (status in ('draft','approved','running','completed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Leads (Section 11 — consent required, PDPL audit) ───────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  email text,
  phone text,
  source text not null check (source in ('founder_list','signup_form','community')),
  consent_given boolean not null default false,
  consent_timestamp timestamptz,
  consent_text text,
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint leads_consent_required check (
    consent_given = false or
    (consent_given = true and consent_timestamp is not null and consent_text is not null)
  ),
  constraint leads_contact_required check (
    email is not null or phone is not null
  )
);

-- ── Messages (P1 audit trail) ───────────────────────────────
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  experiment_id uuid references experiments(id) on delete set null,
  direction text not null check (direction in ('outbound','inbound')),
  channel text not null check (channel in ('email','whatsapp')),
  template_id text,
  body text not null,
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','replied','bounced','failed')),
  idempotency_key text unique,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Decisions ───────────────────────────────────────────────
create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  verdict text not null check (verdict in ('go','iterate','stop','test_more')),
  confidence text not null check (confidence in ('low','medium','high')),
  rationale text not null,
  evidence_ids uuid[] not null default '{}',
  sample_size int check (sample_size >= 0),
  response_rate numeric check (response_rate between 0 and 100),
  next_experiment text,
  created_at timestamptz not null default now()
);

-- ── Trace events ────────────────────────────────────────────
create table if not exists trace_events (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  actor text not null,
  event_type text not null
    check (event_type in ('tool_call','tool_result','verification','decision','error','skill_start','skill_end')),
  payload jsonb not null default '{}',
  cost_usd numeric check (cost_usd >= 0),
  latency_ms int check (latency_ms >= 0),
  created_at timestamptz not null default now()
);

-- ── Indexes (policy columns + common queries) ───────────────
create index if not exists idx_members_user on workspace_members(user_id);
create index if not exists idx_members_ws on workspace_members(workspace_id);
create index if not exists idx_invites_token on workspace_invites(token);
create index if not exists idx_invites_email on workspace_invites(email);
create index if not exists idx_startups_ws on startups(workspace_id);
create index if not exists idx_startups_owner on startups(owner_id);
create index if not exists idx_assumptions_startup on assumptions(startup_id);
create index if not exists idx_assumptions_ws on assumptions(workspace_id);
create index if not exists idx_evidence_startup on evidence(startup_id);
create index if not exists idx_evidence_ws on evidence(workspace_id);
create index if not exists idx_experiments_startup on experiments(startup_id);
create index if not exists idx_leads_startup on leads(startup_id);
create index if not exists idx_messages_lead on messages(lead_id);
create index if not exists idx_decisions_startup on decisions(startup_id);
create index if not exists idx_trace_startup on trace_events(startup_id);
create index if not exists idx_trace_created on trace_events(created_at desc);
-- Full-text search acceleration for /api/search + /api/history
create index if not exists idx_startups_name_trgm on startups using gin (name gin_trgm_ops);
create index if not exists idx_evidence_claim_trgm on evidence using gin (claim gin_trgm_ops);

-- ── RLS helpers (SECURITY DEFINER, fixed search_path) ───────
-- Canonical location is private.* (Task 4). Public names are
-- deprecated shims delegating to private.* for backward compat.
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

revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.workspace_role(uuid) from public;
revoke execute on function private.is_workspace_member(uuid) from anon, authenticated;
revoke execute on function private.workspace_role(uuid) from anon, authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.workspace_role(uuid) to authenticated, service_role;

create or replace function is_workspace_member(p_workspace_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select private.is_workspace_member(p_workspace_id);
$$;

create or replace function workspace_role(p_workspace_id uuid)
returns text language sql security definer stable set search_path = '' as $$
  select private.workspace_role(p_workspace_id);
$$;

-- ── Enable RLS ──────────────────────────────────────────────
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table workspace_invites enable row level security;
alter table startups enable row level security;
alter table assumptions enable row level security;
alter table evidence enable row level security;
alter table experiments enable row level security;
alter table leads enable row level security;
alter table messages enable row level security;
alter table decisions enable row level security;
alter table trace_events enable row level security;

-- ── Policies (drop-if-exists for re-runnable migration) ─────
drop policy if exists "workspaces_select" on workspaces;
create policy "workspaces_select" on workspaces for select to authenticated
  using (private.is_workspace_member(id));
drop policy if exists "workspaces_insert" on workspaces;
create policy "workspaces_insert" on workspaces for insert to authenticated
  with check ((select auth.uid()) = owner_id);
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

-- trace_events (Task 4 hardened): no WITH CHECK (true) for
-- authenticated; insert requires startup link + member+ (or owner);
-- select drops the startup_id IS NULL bypass. Service-role path is
-- explicit (service_role bypasses RLS regardless). Mirrors 0002.
drop policy if exists "trace_select" on trace_events;
create policy "trace_select" on trace_events for select to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "trace_insert" on trace_events;
create policy "trace_insert" on trace_events for insert to authenticated
  with check (
    startup_id is not null and startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "trace_service_all" on trace_events;
create policy "trace_service_all" on trace_events for all to service_role
  using (true)
  with check (true);

-- ── updated_at triggers (Task 4: fixed search_path) ──────────
create or replace function public.update_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_workspaces_updated_at on workspaces;
create trigger trg_workspaces_updated_at before update on workspaces
  for each row execute function public.update_updated_at();
drop trigger if exists trg_startups_updated_at on startups;
create trigger trg_startups_updated_at before update on startups
  for each row execute function public.update_updated_at();

-- ── Auto-create personal workspace on signup ────────────────
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_slug text;
begin
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

-- ── 0014 (canonical mirror of
-- ── supabase/migrations/20240101000014_prospects_l3.sql) ──────
-- prospects: Apollo research data, never auto-messaged. Only manual
-- path to leads via source_prospect_id + 'prospect_manual_convert'.
create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  source text not null default 'apollo' check (source in ('apollo')),
  company_name text,
  company_domain text,
  company text,
  contact_name text,
  title text,
  seniority text,
  apollo_id text,
  email text,
  match_reason text not null,
  outreach_status text not null default 'not_contacted'
    check (outreach_status in ('not_contacted','founder_contacted_manually')),
  created_at timestamptz not null default now(),
  unique (startup_id, apollo_id)
);

create index if not exists idx_prospects_startup on prospects(startup_id);
create index if not exists idx_prospects_apollo on prospects(apollo_id);
create index if not exists idx_prospects_email on prospects(email);
create index if not exists idx_prospects_outreach on prospects(outreach_status);

alter table leads
  add column if not exists source_prospect_id uuid references prospects(id) on delete set null;

create index if not exists idx_leads_source_prospect on leads(source_prospect_id);

alter table leads drop constraint if exists leads_source_check;
alter table leads
  add constraint leads_source_check
  check (source in ('founder_list','signup_form','community','prospect_manual_convert'));

alter table prospects enable row level security;

drop policy if exists "prospects_select" on prospects;
create policy "prospects_select" on prospects for select to authenticated
  using (
    startup_id in (
      select s.id from public.startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "prospects_insert" on prospects;
create policy "prospects_insert" on prospects for insert to authenticated
  with check (
    startup_id in (
      select s.id from public.startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "prospects_update" on prospects;
create policy "prospects_update" on prospects for update to authenticated
  using (
    startup_id in (
      select s.id from public.startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "prospects_delete" on prospects;
create policy "prospects_delete" on prospects for delete to authenticated
  using (
    startup_id in (
      select s.id from public.startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin'))
         or s.owner_id = (select auth.uid())
    )
  );

-- P1 email-only lock (drop trigger at P2 PDPL license).
create or replace function public.reject_non_email_channel()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.channel <> 'email' then
    raise exception 'Channel locked to email until PDPL marketing license (P2): got %', new.channel;
  end if;
  return new;
end; $$;

drop trigger if exists trg_messages_email_only on public.messages;
create trigger trg_messages_email_only
  before insert or update of channel on public.messages
  for each row execute function public.reject_non_email_channel();

-- L3 experiment-approval gate at DB level (mirrors campaign.ts).
create or replace function public.messages_require_approved_experiment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status text; v_by uuid; v_at timestamptz;
begin
  if new.experiment_id is null then
    return new;
  end if;
  select status, approved_by, approved_at
    into v_status, v_by, v_at
    from public.experiments
    where id = new.experiment_id;
  if not found or v_status <> 'approved' or v_by is null or v_at is null then
    raise exception 'L3 approval required (403): experiment must have status=''approved'' with approved_by/at before queueing (Section 10).';
  end if;
  return new;
end; $$;

drop trigger if exists trg_messages_l3_approval on public.messages;
create trigger trg_messages_l3_approval
  before insert or update of experiment_id on public.messages
  for each row execute function public.messages_require_approved_experiment();
