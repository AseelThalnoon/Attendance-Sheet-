-- The one table with zero audit coverage left: user_settings, the schedule
-- (work days, target hours, grace period, seasonal periods, annual leave).
-- The Activity Log's own description already claims to track "attendance
-- data, user roles, and organisation settings" -- schedules were never in
-- that list, because until now nothing recorded them. An admin changing
-- someone else's working days or target hours left no trace at all, which
-- is exactly the kind of admin affordance PRODUCT.md says needs a
-- server-side, auditable record, not just a UI that happens not to hide it.
--
-- Same shape as log_app_settings_change(): SECURITY DEFINER so it runs
-- regardless of the caller's own RLS grants, and skips the write on an
-- UPDATE that resaves the identical JSON (the Working Hours form always
-- submits the whole settings object, so a no-op Save is common). Unlike
-- that function, this does NOT skip the very first INSERT: the seed row
-- handle_new_user() writes at signup is a real fact worth a row -- "this is
-- the schedule someone started on" -- not provisioning noise to suppress.
CREATE OR REPLACE FUNCTION public.log_user_settings_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_target_email text;
BEGIN
  IF tg_op = 'UPDATE' AND old.settings IS NOT DISTINCT FROM new.settings THEN
    RETURN new;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;
  SELECT email INTO v_target_email FROM public.profiles WHERE id = new.user_id;

  INSERT INTO public.audit_log(
    actor_id, actor_email, action, table_name, record_id,
    target_user_id, target_email, old_values, new_values
  ) VALUES (
    v_actor, v_actor_email, 'schedule_change', 'user_settings', new.user_id::text,
    new.user_id, v_target_email,
    CASE WHEN tg_op = 'UPDATE' THEN old.settings ELSE NULL END,
    new.settings
  );

  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION public.log_user_settings_change() FROM public, anon, authenticated;

CREATE TRIGGER user_settings_audit
  AFTER INSERT OR UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_user_settings_change();
