-- Written during the 2026-11-14 review and applied to the live project on
-- 2026-11-15, on the owner's go-ahead (recorded there as version
-- 20261115135254; the statements below are what ran, the commentary is not
-- stored with them).
--
-- Verified straight afterwards, as the two roles the app uses and with every
-- test write rolled back: a signed-out visitor can read the sign-up flag and
-- file a crash report and nothing else; an employee reads only their own
-- entries, can add one (the audit trigger still writes), save a schedule and
-- register a device; "In today" returns no day type; and a 121-character name,
-- a schedule that is not an object, a device with a non-https address, a
-- deleted profile, a forged audit row and a read of the reminder guard are
-- each refused. The database went from 69.8MB to 15.1MB.
--
-- Five things, each found by reading the live database rather than the
-- repository, and none of them visible from inside the app:
--
--   1. Free text and JSON with no upper bound. The client caps a display name
--      at 120 characters and a schedule is about 500 bytes, but the API takes
--      whatever it is sent: profiles.full_name, user_settings.settings and the
--      push tables had no limit at all, so one signed-in account could store
--      megabytes in a field every teammate's roster then has to render.
--      entries has had this since 20260815104221; these are the tables that
--      were added after it.
--   2. "In today" handed every signed-in account more than the panel shows.
--      list_today_presence() returned a row for everybody with ANY entry that
--      day -- including the people on sick or annual leave, with the type
--      spelled out -- plus every address. The panel has only ever listed the
--      people who clocked in. With sign-up open, "every signed-in account"
--      means anyone who registers.
--   3. anon held every privilege on every table. Row Level Security is what
--      actually refuses a signed-out request, and it does; but that is one
--      layer, and the day a table is created without it the grant is already
--      waiting. A signed-out visitor needs exactly two things here.
--   4. A deleted person's photo stayed in Storage, readable by every account,
--      because no policy let anyone but its owner remove it.
--   5. cron.job_run_details. send-push ticks every minute and pg_cron keeps a
--      row per run for ever: 98,222 rows and 56.6MB on 2026-11-14, which is 78%
--      of the whole 72.5MB database, growing ~0.8MB a day against the plan's
--      500MB. Every table the app itself owns adds up to 1.9MB.
--
-- Checked before writing: every existing row already satisfies every
-- constraint below (longest name 20 characters, largest schedule 499 bytes,
-- every push endpoint https and under 240), so nothing here can fail on the
-- data that is there.

-- Every ALTER below takes a brief exclusive lock on a table the app is using.
-- If one of them cannot be had within five seconds, give up -- the whole file
-- is one transaction, so nothing is left half-done -- rather than queue behind
-- a long query while holding the locks already taken, with people's clock-ins
-- waiting behind those.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Bounds at the boundary
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_full_name_len_chk
  CHECK (full_name IS NULL OR char_length(full_name) <= 120);

-- A sign-up carries the name as metadata, and the constraint above would turn
-- an over-long one into a failed registration with a database error for a
-- message. Cut it to fit instead: same function as before, one expression
-- changed. (CREATE OR REPLACE keeps the function's owner and its grants.)
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
  VALUES (new.id, new.email, left(new.raw_user_meta_data->>'full_name', 120))
  ON CONFLICT (id) DO NOTHING;

  IF v_default IS NOT NULL AND v_default <> '{}'::jsonb THEN
    INSERT INTO public.user_settings (user_id, settings)
    VALUES (new.id, v_default)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN new;
END $$;

-- A schedule is an object, and a generous one (fifty seasonal periods) is
-- under 8KB. Every change to it is also copied whole into audit_log, old and
-- new, so an unbounded value here was an unbounded value there twice over.
ALTER TABLE public.user_settings
  ADD CONSTRAINT user_settings_shape_chk
  CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 20000);

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_announcement_len_chk
  CHECK (announcement IS NULL OR char_length(announcement) <= 300),
  ADD CONSTRAINT app_settings_default_settings_chk
  CHECK (default_settings IS NULL
         OR (jsonb_typeof(default_settings) = 'object'
             AND octet_length(default_settings::text) <= 20000));

-- The composer stops at 80 and 500; the reminder texts the server writes are
-- shorter than either. Headroom, not parity.
ALTER TABLE public.push_notifications
  ADD CONSTRAINT push_notifications_text_len_chk
  CHECK (char_length(title) <= 120 AND char_length(body) <= 1000);

-- send-push makes a request to whatever this column holds, so it is the one
-- field in the schema that is a destination rather than a value. https only;
-- which hosts count as a push service is decided in the function, where a
-- refusal can be reported to the administrator instead of surfacing here as a
-- failed toggle on somebody's phone.
ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_subscriptions_shape_chk
  CHECK (endpoint ~ '^https://'
         AND char_length(endpoint) <= 2048
         AND char_length(p256dh) <= 200
         AND char_length(auth) <= 100
         AND (user_agent IS NULL OR char_length(user_agent) <= 500));

-- And a ceiling on how many of them one account may hold. Every broadcast is
-- one request per row, so the row count is the fan-out: without this, a single
-- account could make each announcement cost thousands of sends. Ten is more
-- devices than anyone here has. The device being (re)registered is not
-- counted against itself, so switching notifications off and on again at the
-- limit still works.
CREATE OR REPLACE FUNCTION public.push_subscriptions_device_cap()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM public.push_subscriptions
        WHERE user_id = NEW.user_id AND endpoint <> NEW.endpoint) >= 10 THEN
    RAISE EXCEPTION 'Notifications are already on for 10 devices on this account. Remove one under Settings, then try again.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.push_subscriptions_device_cap() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS push_subscriptions_device_cap ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_device_cap
  BEFORE INSERT ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.push_subscriptions_device_cap();

-- ---------------------------------------------------------------------------
-- 2. "In today" returns what "In today" shows
-- ---------------------------------------------------------------------------
-- The panel lists the people who clocked in: still in, or done for the day.
-- It never listed anyone on leave -- the client filtered those rows out after
-- receiving them. So the rows are filtered here instead, and the day type is
-- no longer returned at all: the only thing the client did with it was that
-- filter. An address is returned only for somebody with no name to show.
--
-- A day typed as leave or sick that nevertheless has an open clock-in still
-- appears, as it did before -- that person is in the building -- but without
-- saying what the day was typed as.
--
-- The signed-in check is new as well. EXECUTE was already limited to
-- authenticated; this is the same guard every other function here carries,
-- so the rule does not rest on a grant alone.
CREATE OR REPLACE FUNCTION public.list_today_presence(p_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF abs(p_date - current_date) > 1 THEN
    RAISE EXCEPTION 'p_date must be within one day of the current date';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(u), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'user_id', p.id,
        'full_name', p.full_name,
        'email', CASE WHEN coalesce(btrim(p.full_name), '') = '' THEN p.email END,
        'avatar_updated_at', p.avatar_updated_at,
        'clock_in', e.clock_in,
        'clock_out', e.clock_out
      ) AS u
      FROM public.entries e
      JOIN public.profiles p ON p.id = e.user_id
      WHERE e.date = p_date
        AND e.clock_in IS NOT NULL
        AND (e.clock_out IS NULL
             OR e.type NOT IN ('leave', 'sick', 'holiday', 'other'))
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.list_today_presence(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_today_presence(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Least privilege
-- ---------------------------------------------------------------------------
-- A signed-out visitor does two things: reads whether sign-up is open
-- (public_app_flags(), a function) and files a crash report (an INSERT into
-- client_errors, capped and filtered by its own trigger). Nothing else.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
GRANT INSERT ON public.client_errors TO anon;

-- And the same for tables that do not exist yet, so the next one starts
-- closed to anon instead of open.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- Signed-in accounts keep the row access the policies describe, and lose the
-- three table privileges the API never exercises. TRUNCATE is the one that
-- matters: it is not subject to Row Level Security at all.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
-- Written only by the server (send-push and the reminder job, as service_role)
-- or only by SECURITY DEFINER triggers -- never by a person's own request.
REVOKE ALL ON public.clockout_reminders_sent FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.push_deliveries FROM authenticated;
REVOKE DELETE ON public.profiles FROM authenticated;

-- A trigger fires without the writing role holding EXECUTE, and nothing else
-- should call this one (same treatment as 20260902182918).
REVOKE ALL ON FUNCTION public.stamp_announcement_posted() FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A deleted person's photo can be deleted too
-- ---------------------------------------------------------------------------
-- admin_delete_user() removes the account and, by cascade, every row that
-- belonged to it. The photo is not a row: it is an object in Storage, where
-- the only DELETE policy is "your own folder", and Storage refuses deletes
-- made in SQL. So the photo outlived the person, in a bucket any signed-in
-- account can read. The Admin screen removes it after deleting the account;
-- this is the policy that lets it.
DROP POLICY IF EXISTS avatars_delete_admin ON storage.objects;
CREATE POLICY avatars_delete_admin ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. pg_cron's run history
-- ---------------------------------------------------------------------------
-- Emptied rather than trimmed. This role may DELETE and TRUNCATE the table but
-- does not own it, so it cannot VACUUM FULL: a DELETE would leave all 56MB
-- allocated, and only TRUNCATE hands it back. What is lost is a log of runs --
-- every one of the last week's 10,255 succeeded -- and it refills from the
-- next minute. The nightly job below then keeps it to a week (about 10,000
-- rows, a few MB).
TRUNCATE cron.job_run_details;

SELECT cron.schedule(
  'prune-cron-history',
  '50 3 * * *',
  $job$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$job$
);
