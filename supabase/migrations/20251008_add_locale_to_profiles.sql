-- Task 5 (i18n): account-level locale persistence.
-- Old rows and the current handle_new_user() email-only insert path keep
-- working via the 'en' default (no trigger change needed).
alter table public.profiles
  add column if not exists locale text not null default 'en'
  check (locale in ('ar', 'en'));

-- Policy: a signed-in user may update ONLY their own row. Required for the
-- dashboard language-switch write (client anon-key update of profiles.locale).
-- Written in the repo's hardened (select auth.uid()) form.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
