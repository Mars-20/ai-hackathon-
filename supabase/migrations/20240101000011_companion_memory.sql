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

-- REVIEW FIX (Task 2 adversarial review): the REVOKEs above strip the default
-- PUBLIC execute grant, so without explicit GRANTs the authenticated user-JWT
-- client could not call these RPCs at all. 0010 precedent (consume_trial):
-- revoke from public, then grant execute to authenticated + service_role.
-- anon stays revoked (defense in depth; caller check would deny it anyway).
grant execute on function public.decide_memory(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.propose_memories(uuid, jsonb) to authenticated, service_role;
