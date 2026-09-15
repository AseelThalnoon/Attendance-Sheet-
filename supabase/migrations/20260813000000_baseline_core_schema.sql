-- STATUS: reconstructed from the live project on 2026-09-15. NOT YET RECORDED
-- there as applied -- the tables below already exist in production, so this
-- file is written to be a no-op against it and needs its history row inserted
-- by hand rather than run. On an empty database it is the first thing that
-- runs, and every migration after it depends on that.
--
-- profiles, entries and user_settings hold every row this app has, and until
-- now none of them existed in version control. Twenty-three migrations added
-- policies, triggers, constraints and columns to three tables that nothing in
-- the repository ever created. The consequences were not theoretical:
--
--   * The database could not be rebuilt from this repository at all. A lost or
--     corrupted project meant the schema AND its row-level security were
--     unrecoverable from source, whatever the backups held.
--   * Supabase's own preview check has been failing on every pull request for
--     months. It replays the migrations against an empty database, and the
--     very first one (20260813204929_admin_db_stats_function.sql) selects FROM
--     public.profiles on line 18. It never got that far, because a duplicate
--     history row stopped it earlier -- so the check reported a bookkeeping
--     error and hid this one behind it.
--   * entries_user_id_date_key, the UNIQUE (user_id, date) that every upsert
--     in app.js depends on through onConflict:"user_id,date", existed only
--     inside the live project. Nothing in the repository said the client's
--     main write path had a constraint holding it up.
--
-- WHAT IS DELIBERATELY ABSENT. This is the schema as it stood BEFORE the first
-- migration, not as it stands today, because everything a later migration adds
-- must still be that migration's to add. A baseline that captured the current
-- shape would collide on replay -- ADD CONSTRAINT has no IF NOT EXISTS. So:
--
--   profiles.avatar_updated_at  belongs to 20260830153507_shared_avatars
--   profiles.last_seen_at       belongs to 20260909060549_profiles_last_seen_at
--   entries' five CHECK constraints and entries_date_idx
--                               belong to 20260815104221_pending_data_integrity
--   every RLS POLICY on all three tables
--                               belongs to 20260815012052 and 20260815104221
--
-- That last one is also what keeps the ordering honest: all nine policies call
-- public.is_admin(), which 20260813204929 creates -- after this file. A
-- baseline that tried to carry the policies could not have run first.
--
-- RLS itself IS enabled here, because no migration does it and a policy
-- arriving later would otherwise attach to a table that was not enforcing
-- anything. Enabled with no policies is the safe order: the table denies
-- everything to ordinary roles until the policies land.

CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  full_name   text,
  role        text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        date NOT NULL,
  clock_in    text,
  clock_out   text,
  type        text NOT NULL DEFAULT 'regular',
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- One entry per person per day. Named explicitly rather than left to
  -- Postgres because app.js names it too, in effect: every write to this table
  -- goes through an upsert with onConflict:"user_id,date", which is a
  -- reference to this constraint by its columns and fails without it.
  CONSTRAINT entries_user_id_date_key UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Defined here rather than only in 20260815104221, where it currently lives,
-- because the two triggers below are in no migration at all and cannot be
-- created before the function they call. That later file declares it with
-- CREATE OR REPLACE, so it will simply redefine this identical body when it
-- runs; nothing is lost by it existing earlier.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END $$;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM public, anon, authenticated;

-- Both of these exist in the live project and in none of the twenty-three
-- migrations -- the same gap as the tables, one level down. Without them
-- updated_at records when a row was created and then never moves again.
DROP TRIGGER IF EXISTS entries_set_updated_at ON public.entries;
CREATE TRIGGER entries_set_updated_at
  BEFORE UPDATE ON public.entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS settings_set_updated_at ON public.user_settings;
CREATE TRIGGER settings_set_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
