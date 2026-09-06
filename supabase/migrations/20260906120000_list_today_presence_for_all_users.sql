-- "In today" on the Overview tab was admin-only, but not by policy choice --
-- it was a side effect. entries and profiles both gate SELECT to
-- own_or_admin, so a non-admin's own version of the same query silently
-- returned just themself, and the client hid the whole panel behind
-- isAdmin() to avoid rendering a "team" of one. The fix is a narrow,
-- non-admin-gated read path for exactly what that panel needs -- name,
-- avatar, and today's clock_in/clock_out/type -- not a broader grant on
-- entries or profiles themselves, which stay own_or_admin for everything
-- else (history, settings, the viewer switcher).
--
-- p_date is bounded to within one day of the server's own current date so
-- this can't be repurposed into a general "who was in on date X" lookup
-- the way admin-only entries access already can be; the one-day slack is
-- for callers whose local "today" (used elsewhere in the app to compute
-- entries.date) sits just across a UTC boundary from the server's.
CREATE OR REPLACE FUNCTION public.list_today_presence(p_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF abs(p_date - current_date) > 1 THEN
    RAISE EXCEPTION 'p_date must be within one day of the current date';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(u), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'user_id', p.id,
        'full_name', p.full_name,
        'email', p.email,
        'avatar_updated_at', p.avatar_updated_at,
        'clock_in', e.clock_in,
        'clock_out', e.clock_out,
        'type', e.type
      ) AS u
      FROM public.entries e
      JOIN public.profiles p ON p.id = e.user_id
      WHERE e.date = p_date
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.list_today_presence(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_today_presence(date) TO authenticated;
