-- Announcements that end on their own, and that each person can hide.
--
-- Until now the banner stayed up, for everyone, until an admin switched it
-- off: a "Happy weekend!" posted on Thursday was still in every bell's count
-- on Tuesday, and nobody but an admin could make it go away.
--
-- Additive and backward compatible: the client before this change reads
-- app_settings with select("*") and ignores columns it does not know, and it
-- never calls hide_announcement().

-- ---------- app_settings: an end date, and when the banner went up ----------
-- announcement_until is a calendar date, inclusive: the banner shows through
-- the end of that day and not after. NULL keeps the old behaviour -- up until
-- someone switches it off.
--
-- announcement_posted_at is when the current announcement went up. It is what
-- a person's "hide" is measured against: hiding covers whatever was posted
-- before you hid it, so a new announcement shows again by itself. It is set
-- only by the trigger below, never by a client.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS announcement_until date,
  ADD COLUMN IF NOT EXISTS announcement_posted_at timestamptz;

-- An announcement already up when this runs counts as posted when it was last
-- saved. Done before the trigger exists, which would otherwise keep the NULL.
UPDATE public.app_settings
  SET announcement_posted_at = coalesce(updated_at, now())
  WHERE announcement_posted_at IS NULL AND announcement_active;

-- "Posted" means the banner went from not showing to showing, or its wording
-- changed while it was showing. Moving only the end date of a banner that is
-- still up is not a new announcement, so it does not bring back a banner
-- people have hidden. Re-enabling one whose end date has passed is.
--
-- "Today" is Asia/Riyadh's, the organisation's timezone -- the same choice
-- check-clockout-reminders makes, for the same reason: this runs on a server
-- with no local clock of its own that means anything here.
CREATE OR REPLACE FUNCTION public.stamp_announcement_posted()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_today    date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_is_live  boolean;
  v_was_live boolean := false;
BEGIN
  v_is_live := coalesce(NEW.announcement_active, false)
    AND coalesce(btrim(NEW.announcement), '') <> ''
    AND (NEW.announcement_until IS NULL OR NEW.announcement_until >= v_today);

  IF TG_OP = 'UPDATE' THEN
    v_was_live := coalesce(OLD.announcement_active, false)
      AND coalesce(btrim(OLD.announcement), '') <> ''
      AND (OLD.announcement_until IS NULL OR OLD.announcement_until >= v_today);
    -- Not client-writable: whatever a client sent is replaced either way.
    NEW.announcement_posted_at := OLD.announcement_posted_at;
  ELSE
    NEW.announcement_posted_at := NULL;
  END IF;

  IF v_is_live AND (NOT v_was_live
      OR (TG_OP = 'UPDATE' AND NEW.announcement IS DISTINCT FROM OLD.announcement)) THEN
    NEW.announcement_posted_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_settings_stamp_announcement ON public.app_settings;
CREATE TRIGGER app_settings_stamp_announcement
  BEFORE INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_announcement_posted();

-- ---------- the activity log records the end date too ----------
-- Same function as before with announcement_until added to the columns it
-- compares and records. announcement_posted_at is left out on purpose: it is
-- derived from the others, so logging it would only repeat them.
CREATE OR REPLACE FUNCTION public.log_app_settings_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
begin
  if old.announcement is not distinct from new.announcement
     and old.announcement_active is not distinct from new.announcement_active
     and old.announcement_until is not distinct from new.announcement_until
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
      'announcement_until', old.announcement_until,
      'allow_registration', old.allow_registration,
      'default_settings', old.default_settings
    ),
    jsonb_build_object(
      'announcement', new.announcement, 'announcement_active', new.announcement_active,
      'announcement_until', new.announcement_until,
      'allow_registration', new.allow_registration,
      'default_settings', new.default_settings
    )
  );

  return new;
end;
$$;

-- ---------- announcement_hides: one row per person ----------
-- When that person last hid the announcement. One timestamp rather than one
-- row per announcement, because announcements have no id of their own: the
-- banner is hidden while hidden_at >= app_settings.announcement_posted_at.
CREATE TABLE IF NOT EXISTS public.announcement_hides (
  user_id   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.announcement_hides ENABLE ROW LEVEL SECURITY;

-- Your own row, and only ever your own -- an admin included.
DROP POLICY IF EXISTS announcement_hides_own_select ON public.announcement_hides;
CREATE POLICY announcement_hides_own_select ON public.announcement_hides
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No INSERT or UPDATE policy: writes go through hide_announcement(), which
-- stamps the server's clock. A client-supplied time could be set far ahead
-- and silently hide every announcement still to come.

-- ---------- hide_announcement ----------
CREATE OR REPLACE FUNCTION public.hide_announcement()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  INSERT INTO public.announcement_hides (user_id, hidden_at)
  VALUES (auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE SET hidden_at = excluded.hidden_at;
END;
$$;
REVOKE ALL ON FUNCTION public.hide_announcement() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hide_announcement() TO authenticated;
