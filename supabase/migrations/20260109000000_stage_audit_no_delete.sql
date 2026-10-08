-- 0017 project progress audit hardening: the stage history and dismissal
-- tables are append-only audit. The 0016 "for all" policies let any project
-- member DELETE audit rows (USING governs DELETE). Split into per-command
-- policies — SELECT/INSERT/UPDATE keep the 0016 membership rules — and grant
-- NO delete to authenticated, so deletes are denied by default. Cleanup and
-- admin flows use service_role, which bypasses RLS.
drop policy if exists "stage_history_all" on public.startup_stage_history;
drop policy if exists "stage_history_select" on public.startup_stage_history;
drop policy if exists "stage_history_insert" on public.startup_stage_history;
drop policy if exists "stage_history_update" on public.startup_stage_history;
create policy "stage_history_select" on public.startup_stage_history for select to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  );
create policy "stage_history_insert" on public.startup_stage_history for insert to authenticated
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );
create policy "stage_history_update" on public.startup_stage_history for update to authenticated
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
drop policy if exists "stage_dismissals_select" on public.stage_suggestion_dismissals;
drop policy if exists "stage_dismissals_insert" on public.stage_suggestion_dismissals;
drop policy if exists "stage_dismissals_update" on public.stage_suggestion_dismissals;
create policy "stage_dismissals_select" on public.stage_suggestion_dismissals for select to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  );
create policy "stage_dismissals_insert" on public.stage_suggestion_dismissals for insert to authenticated
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and private.workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );
create policy "stage_dismissals_update" on public.stage_suggestion_dismissals for update to authenticated
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
