-- ============================================================
-- Validation Copilot — workspace bootstrap fix (members_insert deadlock)
-- Root cause: workspace_members INSERT requires workspace_role in
-- ('owner','admin'), but the FIRST member (workspace creator) has no role
-- yet, so personal-workspace auto-create (agent-workspace.ts step 3 +
-- dashboard createNewWorkspace) always fails RLS → persistence skipped →
-- history/dashboard look empty after re-login (data only in localStorage).
-- Fix: workspace owner may insert the first membership for their own
-- workspace (bootstrap exception). Existing owner/admin path preserved.
-- Idempotent (drop-if-exists). Run AFTER 0002 hardening.
-- ============================================================

drop policy if exists "members_insert" on workspace_members;
create policy "members_insert" on workspace_members for insert to authenticated
  with check (
    private.workspace_role(workspace_id) in ('owner','admin')
    or exists (
      select 1 from public.workspaces w
      where w.id = workspace_id
        and w.owner_id = (select auth.uid())
    )
  );
