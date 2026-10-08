-- 0016 project progress: relax stage CHECK (track-aware validation moves to
-- the API layer), add track columns, stage history + dismissal tables.
alter table public.startups drop constraint if exists startups_stage_check;
alter table public.startups add column if not exists stage_track text;
alter table public.startups add column if not exists stage_order jsonb;

create table if not exists public.startup_stage_history (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  actor text not null check (actor in ('user','suggestion')),
  reason text,
  supporting_refs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.stage_suggestion_dismissals (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  rung4_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (startup_id, from_stage, to_stage)
);

alter table public.startup_stage_history enable row level security;
alter table public.stage_suggestion_dismissals enable row level security;

drop policy if exists "stage_history_all" on public.startup_stage_history;
create policy "stage_history_all" on public.startup_stage_history for all to authenticated
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

drop policy if exists "stage_dismissals_all" on public.stage_suggestion_dismissals;
create policy "stage_dismissals_all" on public.stage_suggestion_dismissals for all to authenticated
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
