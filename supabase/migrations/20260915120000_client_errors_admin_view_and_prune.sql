-- STATUS: NOT YET APPLIED. Run this against the live project; until then the
-- Crash Reports section in the Admin console loads nothing and says so.
--
-- Two halves of the same omission. 20260915084500 gave crashes somewhere to be
-- recorded and nowhere to be read: the rows exist, admin-read RLS is on them,
-- and the only way to see one is to open the Supabase dashboard -- which is
-- not a place this app ever asks anyone to go, and not somewhere a person
-- checks on the off chance something broke. A record nobody reads is a record
-- nobody acts on.
--
-- The other half is that nothing deleted anything. The original migration said
-- so in its own known-gaps note. A crash table is the worst kind of unbounded
-- growth: it fills fastest exactly when something is wrong, which is the
-- moment you least want the database to become a second problem.

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
-- Mirrors admin_audit_log: SECURITY DEFINER so it can read past the
-- admin-read policy, with the is_admin() check as the actual gate, and the
-- same least(coalesce(...)) ceiling so a caller cannot ask for the table.
--
-- The reporter's email is joined in rather than left as a uuid. "Whose browser
-- was this?" is the first question anyone asks of a crash, and audit_log
-- already settled the precedent by storing actor_email alongside actor_id.
CREATE OR REPLACE FUNCTION public.admin_client_errors(
  limit_n integer DEFAULT 100,
  filter_kind text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can view crash reports';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb)
    FROM (
      SELECT e.id, e.occurred_at, e.kind, e.message, e.stack, e.source,
             e.line, e.col, e.build, e.url, e.user_agent,
             p.email AS reporter_email,
             p.full_name AS reporter_name
      FROM public.client_errors e
      LEFT JOIN public.profiles p ON p.id = e.user_id
      WHERE (filter_kind IS NULL OR e.kind = filter_kind)
      ORDER BY e.occurred_at DESC
      LIMIT least(coalesce(limit_n, 100), 500)
    ) c
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_client_errors(integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_client_errors(integer, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Pruning
-- ---------------------------------------------------------------------------
-- Deliberately NOT callable through the API. There is no is_admin() guard
-- because there is no caller to guard against: EXECUTE is revoked from every
-- role PostgREST can act as, so the scheduled job below -- which runs as the
-- database owner, with no auth.uid() to check -- is the only thing that can
-- reach it. A guard here would have made the function uncallable by the one
-- caller it has.
--
-- 90 days because a crash older than a quarter has either been fixed or is
-- being reported again; the build column is what ties a report to the code
-- that produced it, and that code is long replaced by then.
CREATE OR REPLACE FUNCTION public.prune_client_errors(keep_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.client_errors
  WHERE occurred_at < now() - make_interval(days => greatest(coalesce(keep_days, 90), 1));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_client_errors(integer) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
-- pg_cron is already installed on this project. Wrapped in an exception
-- handler on purpose: if the role running this migration cannot schedule jobs,
-- that must not take the function definitions above down with it. The prune
-- can be scheduled by hand afterwards; an unreadable crash log cannot be fixed
-- by hand at all.
--
-- 03:40 UTC, and unscheduled first so re-running this file replaces the job
-- rather than stacking a second copy of it.
DO $$
BEGIN
  PERFORM cron.unschedule('prune-client-errors');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- no such job yet, or no permission; the schedule below reports either
END $$;

DO $$
BEGIN
  PERFORM cron.schedule('prune-client-errors', '40 3 * * *',
    $job$SELECT public.prune_client_errors(90)$job$);
  RAISE NOTICE 'prune-client-errors scheduled for 03:40 UTC daily';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not schedule prune-client-errors (%). The table will grow until it is scheduled by hand.', SQLERRM;
END $$;
