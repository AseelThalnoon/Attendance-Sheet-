-- ===========================================================================
-- Tracks changes to app_settings in the activity log.
--
-- entries and profiles already get an audit_log row on every write (see
-- log_entry_change / log_profile_change from the 2026-08-15 audit). The one
-- table with zero coverage was app_settings — which is exactly where the
-- most privileged admin actions live: the announcement banner, whether
-- registration is open, the org-wide theme, and the schedule every new
-- account starts on. An admin console that logs "someone edited a day" but
-- not "someone turned off sign-ups" has a hole in it.
--
-- Same shape as log_profile_change: SECURITY DEFINER so it can write to
-- audit_log regardless of the caller's own RLS grants, skips the write
-- entirely when nothing tracked actually changed (so touching Save without
-- editing anything doesn't spam the log), and never blocks the update itself
-- if anything here went wrong.
-- ===========================================================================

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
     and old.theme is not distinct from new.theme
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
      'allow_registration', old.allow_registration, 'theme', old.theme,
      'default_settings', old.default_settings
    ),
    jsonb_build_object(
      'announcement', new.announcement, 'announcement_active', new.announcement_active,
      'allow_registration', new.allow_registration, 'theme', new.theme,
      'default_settings', new.default_settings
    )
  );

  return new;
end;
$$;

drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit
  after update on public.app_settings
  for each row execute function public.log_app_settings_change();
