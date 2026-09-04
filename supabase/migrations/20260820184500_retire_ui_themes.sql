-- ===========================================================================
-- Retires the org-wide UI theme picker.
--
-- The app shipped three swappable visual themes (ledger / kinetic / velocity),
-- chosen by an admin for the whole organisation and stored in
-- app_settings.theme with a CHECK constraint keeping the database the
-- authority on which values were real. All three have been replaced by a
-- single committed design system ("Atrium"), so there is no longer anything
-- to pick: the column, its constraint, and the picker are all dead weight.
--
-- Two things this migration deliberately does NOT do:
--
--   1. It does not touch audit_log. Those rows are append-only history, and
--      rows written while the picker existed carry a theme diff inside their
--      old_values/new_values JSON. Rewriting them to hide a feature that
--      genuinely existed would be falsifying the record — the client keeps a
--      "Theme (retired)" label so those entries still render.
--
--   2. It does not drop the column before redefining the trigger that reads
--      it. log_app_settings_change() references old.theme/new.theme, so
--      dropping the column first would leave the next app_settings UPDATE
--      raising "record new has no field theme". Both statements run in one
--      migration (and therefore one transaction) so no window exists where
--      the trigger and the table disagree.
-- ===========================================================================

-- 1. Redefine the audit trigger WITHOUT the theme references. Identical to
--    20260819180150_log_app_settings_changes.sql in every other respect.
create or replace function public.log_app_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
begin
  -- Only the columns an admin actually edits from the UI. updated_at/
  -- updated_by change on every save regardless, so comparing those would
  -- log a row every single time even when nothing meaningful moved.
  if old.announcement is not distinct from new.announcement
     and old.announcement_active is not distinct from new.announcement_active
     and old.allow_registration is not distinct from new.allow_registration
     and old.default_settings is not distinct from new.default_settings
  then
    return new;
  end if;

  select email into v_actor_email from public.profiles where id = v_actor;

  insert into public.audit_log(
    actor_id, actor_email, action, table_name, record_id,
    old_values, new_values
  ) values (
    v_actor, v_actor_email, 'app_settings_change', 'app_settings', new.id::text,
    jsonb_build_object(
      'announcement', old.announcement, 'announcement_active', old.announcement_active,
      'allow_registration', old.allow_registration,
      'default_settings', old.default_settings
    ),
    jsonb_build_object(
      'announcement', new.announcement, 'announcement_active', new.announcement_active,
      'allow_registration', new.allow_registration,
      'default_settings', new.default_settings
    )
  );

  return new;
end;
$$;

-- 2. Now the column and its constraint can go.
alter table public.app_settings drop constraint if exists app_settings_theme_check;
alter table public.app_settings drop column if exists theme;
