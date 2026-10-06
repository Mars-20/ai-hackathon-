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
