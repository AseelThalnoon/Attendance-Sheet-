-- STATUS: APPLIED to the live project on 2026-09-15.
--
-- Verified afterwards: the table is present with RLS enabled, all twelve
-- columns carry their CHECK constraints, and the foreign key to auth.users is
-- in place. The database linter reports client_errors under no finding at all
-- -- in particular not rls_enabled_no_policy, which is what an ENABLE ROW
-- LEVEL SECURITY with both policies silently missing would have looked like:
-- a table nobody can read and nobody can write, failing closed and quietly.
--
-- Every failure this app ANTICIPATED already had somewhere to go: a Postgres
-- code became a sentence through friendlyError(), a dead connection became the
-- outbox, a hung request became a timeout with a Try Again. The failures it did
-- not anticipate had nowhere at all. An exception thrown inside app.js stopped
-- the render where it threw and left whatever had already painted on screen
-- looking finished, and the only person who ever learned about it was whoever
-- happened to be holding the phone. Nothing was written down, so "it did
-- something weird yesterday" was the entire bug report and there was no way to
-- turn it into a line number.
--
-- One row per distinct crash, readable by the admin, is what turns that into
-- something actionable.
--
-- Deliberately NOT anon-writable. This app is served from a public URL, so an
-- INSERT policy granted to anon is a table anyone on the internet can fill.
-- The cost of authenticated-only is that a crash on the signed-out screen is
-- never recorded; the sign-in path is also the smallest and least changing
-- part of the app, and a spam target is worse than a blind spot.
--
-- KNOWN GAPS, recorded rather than quietly carried:
--   * No retention. This table only grows. It wants a periodic delete of rows
--     older than ~90 days, which this project has nowhere to schedule yet.
--   * No server-side rate limit. The client caps itself at 8 reports per
--     session, but that cap lives in the browser and a signed-in account could
--     ignore it. Acceptable while every account belongs to a trusted team
--     member (see PRODUCT.md); not acceptable if that ever stops being true.

CREATE TABLE IF NOT EXISTS public.client_errors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Defaulted rather than client-supplied, and pinned by the INSERT policy
  -- below: a report names the session that produced it, not whoever the
  -- reporter claims to be.
  user_id      uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- 'resource' is split from 'error' because the admin's next move differs: a
  -- missing asset is usually a stale service-worker shell or a bad deploy,
  -- while an 'error' is a fault in the code itself.
  kind         text NOT NULL CHECK (kind IN ('error','unhandledrejection','resource')),
  message      text NOT NULL CHECK (char_length(message) <= 500),
  stack        text CHECK (stack IS NULL OR char_length(stack) <= 4000),
  source       text CHECK (source IS NULL OR char_length(source) <= 500),
  line         int,
  col          int,
  -- The cache-busting query off the script tag (app.js?v=...). Without it a
  -- stack trace cannot be matched to the code that produced it, since the
  -- file is served from a static host and overwritten in place.
  build        text CHECK (build IS NULL OR char_length(build) <= 120),
  -- Path and query only. The fragment is where Supabase puts access and
  -- recovery tokens during an auth round-trip, and this is not the place to
  -- keep a copy of one. The client strips it; the length cap is the backstop.
  url          text CHECK (url IS NULL OR char_length(url) <= 500),
  user_agent   text CHECK (user_agent IS NULL OR char_length(user_agent) <= 500)
);

-- The admin console reads this newest-first, which is the only way it is read.
CREATE INDEX IF NOT EXISTS client_errors_occurred_idx
  ON public.client_errors (occurred_at DESC);

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Own-row inserts only, and the row must name the caller. Without the
-- WITH CHECK a signed-in account could file crash reports under someone
-- else's id, which would make the table actively misleading rather than
-- merely noisy.
DROP POLICY IF EXISTS client_errors_insert_own ON public.client_errors;
CREATE POLICY client_errors_insert_own ON public.client_errors
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

-- Admin-read only. A crash report carries a stack trace and a user agent --
-- enough to fingerprint a device -- so it follows audit_log's rule rather
-- than entries': the person it came from does not get the table, the
-- administrator does.
DROP POLICY IF EXISTS client_errors_admin_read ON public.client_errors;
CREATE POLICY client_errors_admin_read ON public.client_errors
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- No UPDATE and no DELETE policy, deliberately. A crash log that can be
-- edited after the fact is not evidence of anything.
