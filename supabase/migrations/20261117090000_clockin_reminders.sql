-- The clock-in reminder.
--
-- check-clockout-reminders sends it (see dueClockInReminders in that
-- function): once a day, to someone with notifications on a device, on one of
-- their workdays, when nothing is logged for today 30 minutes after their
-- start time. This adds the two things the function cannot do for itself.

-- ---------- clockin_reminders_sent ----------
-- The "at most one a day" guard, the clock-in half of clockout_reminders_sent.
-- No policies: only the function touches it, with the service-role key, which
-- bypasses RLS. RLS on with no policies (and no grants) locks every other role
-- out, the same treatment its sibling has.
CREATE TABLE IF NOT EXISTS public.clockin_reminders_sent (
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_on  date NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sent_on)
);
ALTER TABLE public.clockin_reminders_sent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clockin_reminders_sent FROM anon, authenticated;

-- ---------- Every fifteen minutes, not every hour ----------
-- The job ran on the hour, so a reminder due at 08:30 went out at 09:00. At a
-- quarter-hour it goes out within fifteen minutes of being due. The clock-out
-- reminders are unaffected apart from the same gain in timing: each is
-- guarded to once per shift per day, however often the job runs.
-- The job itself is not in any migration (it carries the Vault lookup for the
-- service-role key), so only its schedule is changed here.
SELECT cron.alter_job(job_id := jobid, schedule := '*/15 * * * *')
FROM cron.job
WHERE jobname = 'check-clockout-reminders-tick';
