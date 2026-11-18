-- Schedules are set by admins.
--
-- Until now anyone could write their own user_settings row: their working
-- week, Start and End (and so their daily target), leave days a year and their
-- Ramadan hours. An employee could give themselves a three-hour day or forty
-- days of leave, and every figure in the app would agree with them. The owner
-- chose (2026-11-18) that admins set schedules and employees see theirs
-- read-only.
--
-- The one part of that row that belongs to the person is the pair of reminder
-- switches, remindClockIn and remindClockOut, which the app saves the moment
-- they are flipped. They get a narrow door of their own, set_my_reminder():
-- it changes exactly one of those two keys, on the caller's own row, and
-- nothing else. Everything else in the row is admin-only from here on.
--
-- Reading is unchanged (your own row, or any row for an admin), and so is the
-- audit trigger: a reminder flipped through the function is logged like any
-- other change, with the caller as the actor.

DROP POLICY IF EXISTS settings_insert_own_or_admin ON public.user_settings;
DROP POLICY IF EXISTS settings_update_own_or_admin ON public.user_settings;

CREATE POLICY settings_insert_admin ON public.user_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY settings_update_admin ON public.user_settings
  FOR UPDATE TO authenticated
  USING      (public.is_admin())
  WITH CHECK (public.is_admin());

-- One reminder switch, on your own row. Someone with no row yet (the
-- organisation defaults were not set when they signed up) gets one started
-- from those defaults, the same row handle_new_user() would have given them,
-- so flipping a switch never leaves them on a schedule nobody chose.
CREATE OR REPLACE FUNCTION public.set_my_reminder(p_key text, p_on boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_default jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to change your reminders.' USING ERRCODE = '42501';
  END IF;
  IF p_key IS NULL OR p_key NOT IN ('remindClockIn', 'remindClockOut') THEN
    RAISE EXCEPTION 'That is not one of your reminders.' USING ERRCODE = '22023';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'A reminder is either on or off.' USING ERRCODE = '22023';
  END IF;

  SELECT default_settings INTO v_default FROM public.app_settings WHERE id = 1;

  INSERT INTO public.user_settings (user_id, settings)
  VALUES (v_uid, COALESCE(v_default, '{}'::jsonb) || jsonb_build_object(p_key, p_on))
  ON CONFLICT (user_id) DO UPDATE
    SET settings = public.user_settings.settings || jsonb_build_object(p_key, p_on);
END $$;

REVOKE ALL ON FUNCTION public.set_my_reminder(text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_my_reminder(text, boolean) TO authenticated;
