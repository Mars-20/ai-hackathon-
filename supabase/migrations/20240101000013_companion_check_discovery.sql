-- 0013: harden the 0011 trace_events CHECK widening discovery (review debt).
--
-- NEVER edit 0011 itself — it already applied live; history is immutable.
-- The 0011 DO block matches ANY check constraint whose definition mentions
-- event_type and, with several matches, drops an ARBITRARY one
-- (SELECT ... INTO with no ORDER BY / LIMIT). On a database that later
-- gains another event_type-adjacent CHECK, a re-run/fresh install could
-- drop the wrong constraint.
--
-- This migration re-runs the same widen IDEMPOTENTLY with a deterministic
-- rule:
--   1. the canonical name 'trace_events_event_type_check' wins outright;
--   2. a non-canonical match is dropped ONLY if its definition carries a
--      known pre-0011 allow-list literal ('tool_call') — an unknown shape
--      is left alone with a NOTICE for a human (fail-safe, no silent drop);
--   3. single-row selection with a fixed ORDER BY (no arbitrary pick).
-- On the live database this is a strict no-op (canonical already exists).
do $$
declare cname text;
declare cdef text;
begin
  select conname, pg_get_constraintdef(oid) into cname, cdef
    from pg_constraint
    where conrelid = 'public.trace_events'::regclass and contype = 'c'
      and (conname = 'trace_events_event_type_check'
        or pg_get_constraintdef(oid) like '%event_type%')
    order by case when conname = 'trace_events_event_type_check' then 0 else 1 end,
      conname
    limit 1;

  if cname = 'trace_events_event_type_check' then
    -- Canonical widening already in place: strict no-op.
    raise notice '0013: canonical trace_events CHECK present, nothing to do';
  elsif cname is not null and cdef like '%tool_call%' then
    -- Known pre-0011 shape only: safe to replace.
    execute format('alter table public.trace_events drop constraint %I', cname);
    if not exists (select 1 from pg_constraint where conrelid = 'public.trace_events'::regclass
        and contype = 'c' and conname = 'trace_events_event_type_check') then
      alter table public.trace_events add constraint trace_events_event_type_check
        check (event_type in ('tool_call','tool_result','verification','decision','error',
          'skill_start','skill_end','companion_inject','companion_infer','companion_decide'));
    end if;
  elsif cname is not null then
    -- Unknown constraint shape: NEVER drop blindly. Human intervenes.
    raise notice '0013: unexpected CHECK % kept untouched (definition: %)', cname, cdef;
  else
    -- No event_type CHECK at all: ensure the canonical one exists.
    if not exists (select 1 from pg_constraint where conrelid = 'public.trace_events'::regclass
        and contype = 'c' and conname = 'trace_events_event_type_check') then
      alter table public.trace_events add constraint trace_events_event_type_check
        check (event_type in ('tool_call','tool_result','verification','decision','error',
          'skill_start','skill_end','companion_inject','companion_infer','companion_decide'));
    end if;
  end if;
end $$;
