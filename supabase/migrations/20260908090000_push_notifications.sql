-- STATUS: NOT YET APPLIED. Run with `supabase db push`, or paste into
-- Dashboard -> SQL Editor -> Run, then follow the Vault + cron steps at the
-- bottom of this file (they can't be scripted here -- they need this
-- project's own function URLs and a secret that must never live in git).
--
-- Push notifications: two things share one delivery pipeline --
--   1. an admin composing a message to everyone or to specific people, and
--   2. the server noticing an open shift has passed remindAfterHours and
--      nobody has closed it.
-- Both just insert a row into push_notifications; a single Edge Function
-- (send-push) is the only thing that ever actually talks to a push service,
-- so there is exactly one place that can get delivery wrong instead of two.

-- ---------- push_subscriptions ----------
-- One row per browser/device a person has turned notifications on for.
-- Deliberately not one-per-user: someone signed in on both a phone and a
-- laptop should get the reminder on both, and losing a phone shouldn't
-- silently kill notifications on the laptop too.
CREATE TABLE public.push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- A person manages only their own device rows -- subscribing, unsubscribing,
-- and seeing whether this browser already has one. send-push reads across
-- everyone with the service-role key, which bypasses RLS entirely.
CREATE POLICY push_subscriptions_own ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------- push_notifications ----------
-- One row per composed or system-generated message. status starts 'pending'
-- and is claimed ('sending') by send-push before it does any network work,
-- so a cron tick and a "send now" click racing each other can't both send it.
CREATE TABLE public.push_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- null = system-generated (reminder)
  title            text NOT NULL,
  body             text NOT NULL,
  target_type      text NOT NULL CHECK (target_type IN ('all','users')),
  target_user_ids  uuid[],
  action           text,       -- e.g. 'clock_out'; null for a plain message
  action_payload   jsonb,      -- e.g. {"date":"2026-08-13"}
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sending','sent','failed','canceled')),
  sent_at          timestamptz,
  recipient_count  int,
  failure_count    int,
  error_detail     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_notifications_users_target_chk
    CHECK (target_type <> 'users' OR (target_user_ids IS NOT NULL AND array_length(target_user_ids, 1) > 0))
);
CREATE INDEX push_notifications_due_idx ON public.push_notifications (status, scheduled_for);

ALTER TABLE public.push_notifications ENABLE ROW LEVEL SECURITY;
-- Composing, viewing history, and canceling a still-pending scheduled send
-- are all admin actions -- same shape as every other admin-gated table here.
CREATE POLICY push_notifications_admin_all ON public.push_notifications
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------- clockout_reminders_sent ----------
-- The "at most one push per open shift per day" guard. Keyed on sent_on (not
-- just user_id+entry_date) so a shift still open three days later gets one
-- reminder per day rather than exactly one ever.
CREATE TABLE public.clockout_reminders_sent (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_date  date NOT NULL,
  sent_on     date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_date, sent_on)
);
-- No policies -- this is internal bookkeeping for check-clockout-reminders,
-- which runs with the service-role key and so bypasses RLS entirely. Enabling
-- RLS with zero policies locks every other role (including authenticated
-- admins) out by default, which is exactly what a table nobody's UI needs
-- to touch should do.
ALTER TABLE public.clockout_reminders_sent ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- Scheduling. pg_cron and pg_net ship enabled on every Supabase project;
-- this just turns them on for this database if they aren't already.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- =====================================================================
-- MANUAL STEP -- run this part yourself, once, after deploying the two
-- Edge Functions. It is not included as executable SQL above because it
-- needs two values that must never be committed to this file: this
-- project's own function URL and its service-role key. Supabase Vault
-- keeps the key out of both git and pg_cron.job's own plaintext command
-- column, which pg_net requests otherwise would not.
--
-- 1. Store the service-role key in Vault (Dashboard -> Project Settings ->
--    API for the key itself; run this once via the SQL Editor):
--
--      select vault.create_secret('<YOUR_SERVICE_ROLE_KEY>', 'service_role_key');
--
-- 2. Schedule the sender to tick every minute -- frequent enough that a
--    "send now" broadcast still feels immediate even if the direct
--    invoke from the admin UI fails, and the only thing that actually
--    delivers a scheduled-for-later broadcast or a reminder:
--
--      select cron.schedule(
--        'send-push-tick', '* * * * *',
--        $$
--        select net.http_post(
--          url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/send-push',
--          headers := jsonb_build_object(
--            'Content-Type', 'application/json',
--            'Authorization', 'Bearer ' || (
--              select decrypted_secret from vault.decrypted_secrets
--              where name = 'service_role_key'
--            )
--          ),
--          body := '{}'::jsonb
--        );
--        $$
--      );
--
-- 3. Schedule the reminder check hourly, same pattern:
--
--      select cron.schedule(
--        'check-clockout-reminders-tick', '0 * * * *',
--        $$
--        select net.http_post(
--          url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/check-clockout-reminders',
--          headers := jsonb_build_object(
--            'Content-Type', 'application/json',
--            'Authorization', 'Bearer ' || (
--              select decrypted_secret from vault.decrypted_secrets
--              where name = 'service_role_key'
--            )
--          ),
--          body := '{}'::jsonb
--        );
--        $$
--      );
--
-- Verify both are running: select * from cron.job;
-- Inspect recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
