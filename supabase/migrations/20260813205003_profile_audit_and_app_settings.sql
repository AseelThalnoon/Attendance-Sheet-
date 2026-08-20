-- STATUS: APPLIED to the live project on 2026-08-13.
--
-- Reconstructed on 2026-08-20 from the live schema -- see the note at the top
-- of 20260813204929_admin_db_stats_function.sql for why this file exists.
--
-- Extends the audit trail (see the prior migration) to role/name changes on
-- profiles, and adds the one org-wide settings row every admin console
-- feature since has hung new columns off of (theme, seasonal periods, the
-- announcement banner). id is pinned to the single row 1 -- there is never a
-- second org to configure.

-- Only role and full_name changes are worth a row; every other UPDATE
-- (last-seen timestamps etc.) would otherwise flood the log.
CREATE OR REPLACE FUNCTION public.log_profile_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
BEGIN
  IF tg_op = 'UPDATE' AND old.role IS NOT DISTINCT FROM new.role
     AND old.full_name IS NOT DISTINCT FROM new.full_name THEN
    RETURN new;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.audit_log(
    actor_id, actor_email, action, table_name, record_id,
    target_user_id, target_email, old_values, new_values
  ) VALUES (
    v_actor, v_actor_email,
    CASE WHEN tg_op = 'INSERT' THEN 'user_created' ELSE 'role_change' END,
    'profiles',
    coalesce(new.id, old.id)::text,
    coalesce(new.id, old.id),
    coalesce(new.email, old.email),
    CASE WHEN tg_op = 'UPDATE' THEN jsonb_build_object('role', old.role, 'full_name', old.full_name) ELSE NULL END,
    jsonb_build_object('role', new.role, 'full_name', new.full_name)
  );
  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION public.log_profile_change() FROM public, anon, authenticated;

CREATE TRIGGER profiles_audit
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.log_profile_change();

CREATE TABLE public.app_settings (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  announcement        text,
  announcement_active boolean NOT NULL DEFAULT false,
  allow_registration  boolean NOT NULL DEFAULT true,
  default_settings    jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_settings_select_all ON public.app_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY app_settings_update_admin ON public.app_settings
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- A narrow, anon-readable view of just the public flag, so the sign-in screen
-- can hide "Create an account" before anyone has signed in. No other column
-- of app_settings is exposed.
CREATE OR REPLACE FUNCTION public.public_app_flags()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'allow_registration',
    coalesce((SELECT allow_registration FROM public.app_settings WHERE id = 1), true)
  );
$$;
REVOKE ALL ON FUNCTION public.public_app_flags() FROM public;
GRANT EXECUTE ON FUNCTION public.public_app_flags() TO anon, authenticated;
