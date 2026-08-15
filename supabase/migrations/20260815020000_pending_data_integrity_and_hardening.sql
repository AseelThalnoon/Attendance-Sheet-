-- STATUS: NOT YET APPLIED.
--
-- This migration was written during the 2026-08-15 audit remediation but could
-- not be applied automatically — the tooling blocked DDL against the live
-- project. Apply it yourself via the Supabase SQL Editor or the CLI:
--
--     supabase db push
--   or paste into  Dashboard -> SQL Editor -> Run
--
-- Everything here was checked against the live data first: all 345 existing
-- entries already satisfy the CHECK constraints below, so this will not fail on
-- existing rows. Re-verify before running if the data has changed since.
--
-- Covers audit findings H-7, H-4, H-3, M-24, P-8, and the unindexed foreign key.

-- ===========================================================================
-- H-7: server-side validation. Every rule lived only in the browser, and the
-- browser talks straight to PostgREST — so "99:99" was a storable clock time and
-- an arbitrary string was a storable day type (which renders as the literal word
-- "undefined" in the log, the calendar, the print report and the audit detail).
-- ===========================================================================

-- Empty strings are how the client signals "no time". Normalise to NULL before
-- the CHECK sees them, so there is exactly one representation of "not set".
CREATE OR REPLACE FUNCTION public.normalize_entry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.clock_in  = '' THEN NEW.clock_in  := NULL; END IF;
  IF NEW.clock_out = '' THEN NEW.clock_out := NULL; END IF;
  NEW.note := left(coalesce(NEW.note, ''), 500);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.normalize_entry() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS entries_normalize ON public.entries;
CREATE TRIGGER entries_normalize
  BEFORE INSERT OR UPDATE ON public.entries
  FOR EACH ROW EXECUTE FUNCTION public.normalize_entry();

ALTER TABLE public.entries
  ADD CONSTRAINT entries_type_chk CHECK (
    type IN ('regular','wfh','halfleave','leave','sick','trip','training','holiday','other')),
  ADD CONSTRAINT entries_clock_in_chk CHECK (
    clock_in  IS NULL OR clock_in  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT entries_clock_out_chk CHECK (
    clock_out IS NULL OR clock_out ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT entries_note_chk CHECK (char_length(coalesce(note,'')) <= 500),
  ADD CONSTRAINT entries_date_chk CHECK (date >= DATE '2000-01-01' AND date <= DATE '2100-01-01');

-- ===========================================================================
-- P-8: evaluate auth.uid() once per query instead of once per row.
-- ===========================================================================
DROP POLICY IF EXISTS entries_select_own_or_admin ON public.entries;
DROP POLICY IF EXISTS entries_insert_own_or_admin ON public.entries;
DROP POLICY IF EXISTS entries_update_own_or_admin ON public.entries;
DROP POLICY IF EXISTS entries_delete_own_or_admin ON public.entries;

CREATE POLICY entries_select_own_or_admin ON public.entries
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()) OR public.is_admin());
CREATE POLICY entries_insert_own_or_admin ON public.entries
  FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()) OR public.is_admin());
CREATE POLICY entries_update_own_or_admin ON public.entries
  FOR UPDATE TO authenticated
  USING      (user_id = (select auth.uid()) OR public.is_admin())
  WITH CHECK (user_id = (select auth.uid()) OR public.is_admin());
CREATE POLICY entries_delete_own_or_admin ON public.entries
  FOR DELETE TO authenticated USING (user_id = (select auth.uid()) OR public.is_admin());

-- ===========================================================================
-- H-4: let a user own their own schedule.
-- INSERT/UPDATE were admin-only, so a new employee had no user_settings row and
-- silently inherited Sun–Thu 08:00–16:00 with no way to change it and nothing in
-- the UI hinting the setting existed. In a Mon–Fri org every figure was wrong.
-- The front end has already been updated to expose Schedule Settings to every
-- user; without this migration those saves will be rejected by RLS.
-- ===========================================================================
DROP POLICY IF EXISTS settings_select_own_or_admin ON public.user_settings;
DROP POLICY IF EXISTS settings_insert_admin_only  ON public.user_settings;
DROP POLICY IF EXISTS settings_update_admin_only  ON public.user_settings;

CREATE POLICY settings_select_own_or_admin ON public.user_settings
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()) OR public.is_admin());
CREATE POLICY settings_insert_own_or_admin ON public.user_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()) OR public.is_admin());
CREATE POLICY settings_update_own_or_admin ON public.user_settings
  FOR UPDATE TO authenticated
  USING      (user_id = (select auth.uid()) OR public.is_admin())
  WITH CHECK (user_id = (select auth.uid()) OR public.is_admin());

-- ===========================================================================
-- H-3: "Allow new registrations" did nothing. The flag was read only after
-- sign-in (so a signed-out visitor never saw the button hidden), the RLS policy
-- would not have let them read it anyway, and hiding a button does not close
-- Supabase's signup endpoint. Enforce it where it actually counts.
--
-- NOTE: this makes handle_new_user() reject signups when the flag is off. Also
-- turn off email signups in Dashboard -> Authentication -> Providers for a
-- belt-and-braces block that never reaches the database at all.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_allow   boolean;
  v_default jsonb;
BEGIN
  SELECT allow_registration, default_settings INTO v_allow, v_default
  FROM public.app_settings WHERE id = 1;

  IF v_allow IS NOT NULL AND v_allow = false THEN
    RAISE EXCEPTION 'Registration is currently closed. Ask an administrator for an account.';
  END IF;

  INSERT INTO public.profiles (id, email, full_name)
  VALUES (new.id, new.email, new.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING;

  -- Seed a settings row so nobody starts on an invisible implicit schedule.
  IF v_default IS NOT NULL AND v_default <> '{}'::jsonb THEN
    INSERT INTO public.user_settings (user_id, settings)
    VALUES (new.id, v_default)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN new;
END $$;

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

DROP POLICY IF EXISTS app_settings_select_all ON public.app_settings;
CREATE POLICY app_settings_select_auth ON public.app_settings
  FOR SELECT TO authenticated USING ((select auth.uid()) IS NOT NULL);
DROP POLICY IF EXISTS app_settings_update_admin ON public.app_settings;
CREATE POLICY app_settings_update_admin ON public.app_settings
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ===========================================================================
-- M-24: internal trigger/helper functions should not be public RPC endpoints.
-- Triggers run as the definer regardless, so revoking EXECUTE is safe.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.handle_new_user()       FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_entry_change()      FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_profile_change()    FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_profile_columns() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_admin()              FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_admin()          TO authenticated;

-- Advisor 0011: set_updated_at had a mutable search_path.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END $$;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM public, anon, authenticated;

-- ===========================================================================
-- Indexes: the Team tab and the bulk-apply pre-check both scan by date, and
-- app_settings.updated_by was an unindexed foreign key (advisor 0001).
-- ===========================================================================
CREATE INDEX IF NOT EXISTS entries_date_idx ON public.entries (date);
CREATE INDEX IF NOT EXISTS app_settings_updated_by_idx ON public.app_settings (updated_by);
