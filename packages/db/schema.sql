-- ============================================================
-- Validation Copilot — Supabase Schema (Section 9 of spec)
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ── Startups ─────────────────────────────────────────────────
create table if not exists startups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  one_liner text not null,
  domain text not null,
  target_customer text,
  stage text not null default 'idea'
    check (stage in ('idea', 'prototype', 'live', 'scaling')),
  business_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Assumptions ──────────────────────────────────────────────
create table if not exists assumptions (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  statement text not null,
  category text not null
    check (category in ('desirability', 'viability', 'feasibility')),
  risk_level text not null
    check (risk_level in ('critical', 'high', 'medium', 'low')),
  status text not null default 'untested'
    check (status in ('untested', 'testing', 'validated', 'invalidated')),
  reasoning text,
  created_at timestamptz not null default now()
);

-- ── Evidence ─────────────────────────────────────────────────
create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  evidence_type text not null
    check (evidence_type in ('secondary', 'primary')),
  source_type text
    check (source_type in ('web_search', 'interview', 'survey', 'preorder', 'usage_data')),
  source_url text,
  claim text not null,
  strength text not null
    check (strength in ('opinion', 'intent', 'time_given', 'contact_shared', 'commitment')),
  sample_size int check (sample_size >= 0),
  collected_at timestamptz not null default now()
);

-- ── Experiments ──────────────────────────────────────────────
create table if not exists experiments (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  assumption_id uuid references assumptions(id) on delete set null,
  type text not null
    check (type in ('interview', 'survey', 'landing_page', 'presale')),
  design jsonb not null default '{}',
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'running', 'completed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Leads (Section 11 — consent required) ────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  email text,
  phone text,
  source text not null
    check (source in ('founder_list', 'signup_form', 'community')),
  consent_given boolean not null default false,
  consent_timestamp timestamptz,
  -- Exact wording shown at opt-in (PDPL audit log)
  consent_text text,
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now(),
  -- Enforce: no lead without consent_given=true
  constraint leads_consent_required check (
    consent_given = false or (consent_given = true and consent_timestamp is not null and consent_text is not null)
  )
);

-- ── Messages (P1 email outreach audit trail) ──────────────────
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  experiment_id uuid references experiments(id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  channel text not null check (channel in ('email', 'whatsapp')),
  template_id text,
  body text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'replied', 'bounced', 'failed')),
  idempotency_key text unique,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Decisions (memo history) ─────────────────────────────────
create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  verdict text not null
    check (verdict in ('go', 'iterate', 'stop', 'test_more')),
  confidence text not null
    check (confidence in ('low', 'medium', 'high')),
  rationale text not null,
  evidence_ids uuid[] not null default '{}',
  sample_size int,
  response_rate numeric check (response_rate between 0 and 100),
  next_experiment text,
  created_at timestamptz not null default now()
);

-- ── Trace Events (full observability) ────────────────────────
create table if not exists trace_events (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid references startups(id) on delete cascade,
  actor text not null,
  event_type text not null
    check (event_type in ('tool_call', 'tool_result', 'verification', 'decision', 'error', 'skill_start', 'skill_end')),
  payload jsonb not null default '{}',
  cost_usd numeric check (cost_usd >= 0),
  latency_ms int check (latency_ms >= 0),
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Indexes for performance (and RLS policy columns)
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_startups_owner on startups(owner_id);
create index if not exists idx_assumptions_startup on assumptions(startup_id);
create index if not exists idx_evidence_startup on evidence(startup_id);
create index if not exists idx_experiments_startup on experiments(startup_id);
create index if not exists idx_leads_startup on leads(startup_id);
create index if not exists idx_messages_lead on messages(lead_id);
create index if not exists idx_decisions_startup on decisions(startup_id);
create index if not exists idx_trace_startup on trace_events(startup_id);
create index if not exists idx_trace_created on trace_events(created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Row Level Security (MANDATORY per Section 9)
-- Pattern: use (select auth.uid()) to avoid per-row evaluation
-- ─────────────────────────────────────────────────────────────

alter table startups enable row level security;
alter table assumptions enable row level security;
alter table evidence enable row level security;
alter table experiments enable row level security;
alter table leads enable row level security;
alter table messages enable row level security;
alter table decisions enable row level security;
alter table trace_events enable row level security;

-- startups: owner only
create policy "startups_owner" on startups
  for all using (owner_id = (select auth.uid()));

-- assumptions: via startup ownership
create policy "assumptions_owner" on assumptions
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );

-- evidence: via startup ownership
create policy "evidence_owner" on evidence
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );

-- experiments: via startup ownership
create policy "experiments_owner" on experiments
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );

-- leads: via startup ownership
create policy "leads_owner" on leads
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );

-- messages: via lead → startup ownership
create policy "messages_owner" on messages
  for all using (
    lead_id in (
      select l.id from leads l
      join startups s on s.id = l.startup_id
      where s.owner_id = (select auth.uid())
    )
  );

-- decisions: via startup ownership
create policy "decisions_owner" on decisions
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );

-- trace_events: via startup ownership (null startup_id = system events, hidden from users)
create policy "trace_owner" on trace_events
  for all using (
    startup_id in (select id from startups where owner_id = (select auth.uid()))
  );
