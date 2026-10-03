-- ============================================================
-- Validation Copilot — workspace spend ledger (Task 5 hardening R1/5)
-- Atomic budget counters backing lib/cost.ts Supabase RPC path.
-- Idempotent (IF NOT EXISTS / OR REPLACE). Apply with `supabase db push`
-- or via the Supabase SQL Editor before prod.
-- Dev/test without this migration (or without Supabase env) falls back to
-- the in-memory ledger in lib/cost.ts — clearly marked, never for prod.
-- ============================================================

-- ── Spend table (keyed by budget key: workspace_id, user id, or anon key) ──
create table if not exists workspace_spend (
  key text primary key,
  spent_usd numeric not null default 0 check (spent_usd >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspace_spend_updated on workspace_spend(updated_at desc);

alter table workspace_spend enable row level security;

-- Service-role only: app reads/writes via SECURITY DEFINER RPCs below.
-- No direct authenticated policies — deny by default.
drop policy if exists "spend_no_direct" on workspace_spend;

-- ── Atomic increment (single-statement upsert → atomic under concurrency) ───
create or replace function add_workspace_spend(p_key text, p_amount numeric)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_total numeric;
begin
  if p_key is null or p_key = '' then
    raise exception 'add_workspace_spend: p_key required';
  end if;
  if p_amount is null or p_amount <= 0 then
    select coalesce(spent_usd, 0) into v_total from public.workspace_spend where key = p_key;
    return coalesce(v_total, 0);
  end if;
  insert into public.workspace_spend (key, spent_usd, updated_at)
  values (p_key, p_amount, now())
  on conflict (key) do update
    set spent_usd = public.workspace_spend.spent_usd + excluded.spent_usd,
        updated_at = now()
  returning spent_usd into v_total;
  return v_total;
end; $$;

-- ── Atomic read ─────────────────────────────────────────────────────────────
create or replace function get_workspace_spend(p_key text)
returns numeric language sql security definer stable set search_path = '' as $$
  select coalesce((select spent_usd from public.workspace_spend where key = p_key), 0);
$$;
