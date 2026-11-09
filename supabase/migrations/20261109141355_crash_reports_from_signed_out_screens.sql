-- Crash reports from the signed-out screens.
--
-- client_errors took inserts from signed-in users only (user_id NOT NULL,
-- insert policy TO authenticated), so a crash on the sign-in or sign-up
-- screen -- the first thing every new person meets -- reached the browser
-- console and nowhere else. The objection on record (app.js, persistCrash)
-- was that an anon-writable table behind a public URL is a spam target. So
-- this opens a narrow door rather than the table:
--   * anon may insert only rows with no user;
--   * a BEFORE INSERT trigger stamps those rows with the server's clock,
--     drops automated browsers (HeadlessChrome: test suites, page renderers),
--     and drops anything past 60 signed-out rows an hour, so a flood costs a
--     bounded number of rows instead of an unbounded table;
--   * the existing length checks and the 90-day prune still apply.
-- Dropped rows are dropped silently (the trigger returns NULL): the client is
-- fire-and-forget, and an error would only show a spammer where the line is.

ALTER TABLE public.client_errors ALTER COLUMN user_id DROP NOT NULL;

DROP POLICY IF EXISTS client_errors_insert_signed_out ON public.client_errors;
CREATE POLICY client_errors_insert_signed_out ON public.client_errors
  FOR INSERT TO anon
  WITH CHECK (user_id IS NULL);

-- SECURITY DEFINER so the hourly count sees every signed-out row; anon has
-- no read access of its own, and under RLS the count would always be 0.
CREATE OR REPLACE FUNCTION public.client_errors_signed_out_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_agent IS NULL OR NEW.user_agent ILIKE '%headless%' THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM public.client_errors
        WHERE user_id IS NULL AND occurred_at > now() - interval '1 hour') >= 60 THEN
    RETURN NULL;
  END IF;
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$;
-- A trigger fires without the inserting role holding EXECUTE, and nothing
-- else should call this (same treatment as 20260902182918).
REVOKE ALL ON FUNCTION public.client_errors_signed_out_guard() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS client_errors_signed_out_guard ON public.client_errors;
CREATE TRIGGER client_errors_signed_out_guard
  BEFORE INSERT ON public.client_errors
  FOR EACH ROW EXECUTE FUNCTION public.client_errors_signed_out_guard();

-- The admin view says which rows came from a signed-out screen, rather than
-- leaving the reporter blank for the reader to guess at.
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
             p.full_name AS reporter_name,
             (e.user_id IS NULL) AS signed_out
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
