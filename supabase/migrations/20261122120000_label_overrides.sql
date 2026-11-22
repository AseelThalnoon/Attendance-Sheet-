-- Admin › Labels (2026-11-22): the team's own wording for any text in the app,
-- in English and in Arabic, set by an admin and seen by everyone.
--
-- Shape: {"en": {"Clock In": "Punch In", ...}, "ar": {"Clock In": "...", ...}}.
-- Each key is the app's own English for that text (the key the dictionaries in
-- src/i18n-ar-*.js use); a missing key means "the app's default". The app
-- reads it with the rest of app_settings (select "*", which every signed-in
-- person already does at startup), so this adds no request.
--
-- Who may change it is app_settings' existing rule: anyone signed in reads,
-- only an admin updates (app_settings_update_admin).

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS label_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- An object, and small: the whole app's text in two languages is under
-- 100 KB, so 200 KB is headroom rather than a target.
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_label_overrides_chk;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_label_overrides_chk
  CHECK (jsonb_typeof(label_overrides) = 'object'
         AND octet_length(label_overrides::text) <= 200000);

-- The Activity Log says which labels changed, without copying the whole set
-- into audit_log on every save: the keys whose wording moved, in either
-- language, up to twenty of them, and how many there were.
CREATE OR REPLACE FUNCTION public.log_app_settings_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_labels jsonb := '[]'::jsonb;
  v_label_count int := 0;
begin
  if old.label_overrides is distinct from new.label_overrides then
    select coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb), count(*)
      into v_labels, v_label_count
      from (
        select distinct k from (
          select l.lang, s.k
            from (values ('en'), ('ar')) as l(lang)
            cross join lateral (
              select jsonb_object_keys(coalesce(old.label_overrides -> l.lang, '{}'::jsonb)) as k
              union
              select jsonb_object_keys(coalesce(new.label_overrides -> l.lang, '{}'::jsonb))
            ) s
           where (old.label_overrides -> l.lang -> s.k) is distinct from (new.label_overrides -> l.lang -> s.k)
        ) changed
      ) keys;
    if v_label_count > 20 then
      v_labels := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_labels) e limit 20) t);
    end if;
  end if;

  if old.announcement is not distinct from new.announcement
     and old.announcement_active is not distinct from new.announcement_active
     and old.announcement_until is not distinct from new.announcement_until
     and old.allow_registration is not distinct from new.allow_registration
     and old.default_settings is not distinct from new.default_settings
     and v_label_count = 0
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
      'announcement_until', old.announcement_until,
      'allow_registration', old.allow_registration,
      'default_settings', old.default_settings
    ),
    jsonb_build_object(
      'announcement', new.announcement, 'announcement_active', new.announcement_active,
      'announcement_until', new.announcement_until,
      'allow_registration', new.allow_registration,
      'default_settings', new.default_settings
    ) || case when v_label_count > 0
              then jsonb_build_object('labels_changed', v_labels, 'labels_changed_count', v_label_count)
              else '{}'::jsonb end
  );

  return new;
end;
$$;
