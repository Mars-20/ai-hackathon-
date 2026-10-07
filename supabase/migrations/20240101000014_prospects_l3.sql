-- ============================================================
-- Validation Copilot — prospects research table + L3 DB gate
-- (Task 5/6 follow-up, spec v2.3 Sections 9 / 11.4 / 10)
--
-- Additive-only on top of 20240101000000_schema_unified.sql (+ later
-- migrations). Idempotent (IF NOT EXISTS / OR REPLACE / drop-if-exists).
-- Does NOT touch 0000..0013. Run in order after 0013.
-- DO NOT APPLY to prod without review: alters leads CHECK + adds
-- triggers on messages (email-only P1 + L3 approval).
--
-- What this adds:
--  1. prospects — Apollo-sourced RESEARCH data (spec Section 9).
--     NOT consented, NEVER eligible for automated outreach. No tool
--     reads prospects and writes to messages; the ONLY sanctioned
--     path to leads is manual founder conversion
--     (leads.source_prospect_id + source='prospect_manual_convert').
--     Extra nullable research-contact columns (contact_name, email)
--     exist for founder manual review ONLY — they do not confer
--     consent and no trigger/policy ever copies them to messages.
--  2. leads.source_prospect_id (nullable FK → prospects, set null on
--     delete) + source enum extended with 'prospect_manual_convert'.
--  3. messages email-only trigger (P1): rejects whatsapp until the
--     PDPL marketing license lands (P2). Drop the trigger then.
--  4. messages L3 trigger: when experiment_id is set, the linked
--     experiments row must be status='approved' with approved_by/at
--     stamped — mirrors the campaign.ts app gate at the DB level
--     (fail-closed, same "L3 approval required" wording).
--
-- Conventions (Supabase RLS best practices):
--  * private.* SECURITY DEFINER helpers, fixed search_path = ''
--  * (select auth.uid()) wrapped — initPlan cached per-statement
--  * policies scoped TO authenticated, split per operation
--  * indexes on every policy filter column
-- ============================================================

-- ── 1. prospects table (spec Section 9 + research-contact fields) ──
create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  source text not null default 'apollo' check (source in ('apollo')),
  company_name text,
  company_domain text,
  -- Compatibility aliases for the search-only tool payload
  -- (company mirrors company_name; contact_name is the person name).
  company text,
  contact_name text,
  title text,
  seniority text,
  apollo_id text,
  -- Research-only contact point for founder MANUAL review. Storing it
  -- here never implies consent; nothing auto-messages this address.
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

-- ── 2. leads: manual-convert link + enum ─────────────────────────
alter table leads
  add column if not exists source_prospect_id uuid references prospects(id) on delete set null;

create index if not exists idx_leads_source_prospect on leads(source_prospect_id);

-- The inline CHECK from 0000 got the auto name leads_source_check.
-- Drop + re-add with the manual-convert value (spec Section 11.4).
alter table leads drop constraint if exists leads_source_check;
alter table leads
  add constraint leads_source_check
  check (source in ('founder_list','signup_form','community','prospect_manual_convert'));

-- ── 3. prospects RLS (child of startup: workspace member / owner) ─
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

-- ── 4. messages email-only trigger (P1; drop at P2 license) ───────
-- The column CHECK still lists ('email','whatsapp') for the P2 future.
-- Until the PDPL marketing license lands, this trigger rejects any
-- non-email channel (fail-closed). P2: DROP TRIGGER + keep the CHECK.
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

-- ── 5. messages L3 trigger (mirrors campaign.ts app gate) ────────
-- When a message is queued inside an experiment scope, the experiment
-- must already carry founder approval (status='approved' + stamps).
-- No experiment_id → no L3 scope (Task 5 behaviour preserved).
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

-- ── 6. Hard boundary note (no code path prospects → messages) ────
-- This migration deliberately creates NO trigger, view, or policy that
-- copies prospects rows (or their research-only email) into messages.
-- The only sanctioned flow is manual: founder contacts the person
-- outside the platform, obtains explicit consent, then inserts a leads
-- row with source='prospect_manual_convert' + source_prospect_id.
