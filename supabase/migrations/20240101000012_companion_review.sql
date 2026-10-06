-- 0012 companion memory review fixes (code review 2026-10-06, merged main).
-- 1. propose_memories: within-batch normalized-dupe backstop (review #3).
--    The table scan only saw rows committed by EARLIER calls; two identical
--    values inside one p_rows array both inserted. A per-call seen-set now
--    reports the repeat as MEMORY_DUPLICATE (same code as the table backstop).
-- 2. archive_companion_memory: purge on DECISION time, not creation time
--    (review #10). A row pending 40 days then just rejected was deleted
--    immediately, destroying the 30-day audit window. coalesce keeps rows
--    whose decided_at is somehow null on the old created_at behavior.
-- 3. Drop the dead v_owner declaration (review minor).

create or replace function public.archive_companion_memory()
returns integer language plpgsql security definer set search_path = public as $$
declare deleted_count integer := 0;
begin
  delete from public.companion_memory
    where status = 'rejected'
      and coalesce(decided_at, created_at) < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;
revoke all on function public.archive_companion_memory() from public, anon, authenticated;

create or replace function public.propose_memories(p_user_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := (select auth.uid());
  v_results jsonb := '[]'::jsonb;
  v_dropped uuid[] := '{}';
  v_seen text[] := '{}';
  v_el jsonb; v_idx integer := 0;
  v_kind text; v_value text; v_norm text; v_conf real; v_src text; v_sid uuid;
  v_pending_count integer; v_drop_id uuid; v_new_id uuid;
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
    v_norm := case when v_value is null then null else lower(trim(v_value)) end;
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
          and lower(trim(value)) = v_norm) then
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', false, 'code', 'MEMORY_DUPLICATE');
    elsif v_norm = any (v_seen) then
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
      v_seen := v_seen || v_norm;
      v_results := v_results || jsonb_build_object('index', v_idx, 'ok', true, 'code', 'OK', 'id', v_new_id);
    end if;
    v_idx := v_idx + 1;
  end loop;
  return jsonb_build_object('ok', true, 'code', 'OK', 'results', v_results, 'dropped', to_jsonb(v_dropped));
end $$;
revoke all on function public.propose_memories(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.decide_memory(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.propose_memories(uuid, jsonb) to authenticated, service_role;
