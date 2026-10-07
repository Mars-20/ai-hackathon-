create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation'
    check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.assistant_conversations enable row level security;
drop policy if exists "assistant_conversations_owner" on public.assistant_conversations;
create policy "assistant_conversations_owner" on public.assistant_conversations for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create index if not exists idx_assistant_conversations_user_updated
  on public.assistant_conversations (user_id, updated_at desc);
-- updated_at maintenance (reviews #hardening 0010:284-286 pattern)
create trigger trg_assistant_conversations_updated_at
  before update on public.assistant_conversations
  for each row execute function public.update_updated_at();

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  seq bigint generated always as identity,
  client_message_id uuid not null,
  role text not null check (role in ('user','assistant','tool')),
  content text not null check (char_length(content) between 1 and 8000),
  tool_name text null,
  tool_args jsonb null,
  -- citations: [{kind: startup|assumption|evidence|decision|memory, id: uuid, label: text}]
  citations jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);
alter table public.assistant_messages enable row level security;
drop policy if exists "assistant_messages_via_parent" on public.assistant_messages;
create policy "assistant_messages_via_parent" on public.assistant_messages for all to authenticated
  using (exists (select 1 from public.assistant_conversations c
                 where c.id = conversation_id and c.user_id = (select auth.uid())))
  with check (exists (select 1 from public.assistant_conversations c
                      where c.id = conversation_id and c.user_id = (select auth.uid())));
create index if not exists idx_assistant_messages_conv_order
  on public.assistant_messages (conversation_id, created_at, seq, id);

-- Per-conversation cap 200 enforced in route (COUNT check before insert → 409
-- CONVERSATION_FULL + "start a new chat" CTA). No trigger debt, tested explicitly.

create table if not exists public.assistant_quota (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  used_count integer not null default 0 check (used_count >= 0),
  primary key (user_id, day)
);
alter table public.assistant_quota enable row level security;
-- service-role only, zero public policies (trial_claims precedent, 0010:61-62).

create or replace function public.consume_assistant_message(p_user uuid, p_max integer)
returns table (allowed boolean, used integer, remaining integer)
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_day date := (now() at time zone 'utc')::date;
begin
  insert into public.assistant_quota (user_id, day, used_count)
  values (p_user, v_day, 0) on conflict (user_id, day) do nothing;
  select used_count into v_used from public.assistant_quota
   where user_id = p_user and day = v_day for update;
  if v_used >= p_max then return query select false, v_used, 0;
  else update public.assistant_quota set used_count = used_count + 1
    where user_id = p_user and day = v_day;
    return query select true, v_used + 1, p_max - (v_used + 1);
  end if;
end; $$;
revoke all on function public.consume_assistant_message(uuid, integer) from public;
-- Explicit anon revoke: project default privileges auto-grant EXECUTE to anon at
-- CREATE time, which REVOKE FROM PUBLIC does not strip (0011 precedent).
revoke all on function public.consume_assistant_message(uuid, integer) from anon;
grant execute on function public.consume_assistant_message(uuid, integer) to authenticated, service_role;

-- Refund: provider-total-outage before dispatch only. Never refunds delivered answers.
create or replace function public.refund_assistant_message(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.assistant_quota set used_count = greatest(used_count - 1, 0)
   where user_id = p_user and day = (now() at time zone 'utc')::date;
end; $$;
revoke all on function public.refund_assistant_message(uuid) from public;
revoke all on function public.refund_assistant_message(uuid) from anon;
grant execute on function public.refund_assistant_message(uuid) to authenticated, service_role;

-- DB-backed float preference (D9: no localStorage-first debt)
create table if not exists public.assistant_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  float_enabled boolean not null default false,
  active_conversation_id uuid null references public.assistant_conversations (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.assistant_prefs enable row level security;
drop policy if exists "assistant_prefs_owner" on public.assistant_prefs;
create policy "assistant_prefs_owner" on public.assistant_prefs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
