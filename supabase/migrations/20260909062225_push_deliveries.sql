-- STATUS: APPLIED to the live project on 2026-09-09.
--
-- "3 devices, 1 failed" is a count with no identity behind it.
--
-- push_notifications records recipient_count and failure_count and nothing
-- else, so send-push counted outcomes in two local variables and threw the
-- rest away -- including the statusCode the push service returned and the
-- user_id of the subscription that failed, both of which it had in hand at
-- the moment of the failure. An admin could see that something failed and had
-- no way to learn whose device it was or why, which makes the number
-- unactionable: you cannot go and fix "1".
--
-- One row per delivery attempt fixes that at the source. The admin console
-- reads it behind "Who got it" on each sent notification.
--
-- Deliberately NOT the push endpoint. An endpoint is a capability URL -- it
-- plus the subscription's keys is enough to send a push -- and it belongs in
-- push_subscriptions, which is owner-only. A device label derived from the
-- user agent ("Safari on iPhone") answers "which of my devices" for the person
-- and "whose device" for the admin without moving that capability into an
-- admin-readable table.

CREATE TABLE IF NOT EXISTS public.push_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid NOT NULL REFERENCES public.push_notifications(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device           text,
  -- 'expired' is split out from 'failed' because the admin's next move
  -- differs: an expired subscription has already been deleted and resolves
  -- itself when that person re-enables notifications on that device, while a
  -- failure is a fault to look into.
  status           text NOT NULL CHECK (status IN ('delivered','failed','expired')),
  status_code      int,
  error_detail     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_deliveries_notification_idx
  ON public.push_deliveries (notification_id);

ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;

-- Admin-read only, matching push_notifications itself. Writes come from
-- send-push with the service-role key, which bypasses RLS -- so there is
-- deliberately no INSERT policy: nothing else has any business writing a
-- delivery record.
DROP POLICY IF EXISTS push_deliveries_admin_read ON public.push_deliveries;
CREATE POLICY push_deliveries_admin_read ON public.push_deliveries
  FOR SELECT TO authenticated
  USING (public.is_admin());
