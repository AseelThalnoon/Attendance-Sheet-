-- Applied 2026-09-11. The filename carries the version the remote history
-- actually recorded (20260911143402), not the one this file was written
-- under -- same correction as fb4cdfd and 56f1d61. supabase db push
-- compares filenames against that history, so a file whose name does not
-- match the applied version reads as a migration that never ran.
-- The notification bell: a per-user read path for messages that were actually
-- sent to that person, plus somewhere to record what they have already seen.
--
-- Why an RPC rather than a policy on push_notifications. That table is
-- admin-only today (push_notifications_admin_all, FOR ALL USING is_admin()),
-- and the obvious fix -- a second SELECT policy scoped to the caller -- would
-- hand every employee the whole ROW: created_by, target_user_ids,
-- recipient_count, failure_count, error_detail. target_user_ids in particular
-- is the list of everyone else who got the same message, which is not
-- something a recipient has any business reading. This is the same reasoning
-- list_today_presence() was written for: a narrow read path for exactly what
-- the surface needs, rather than widening the table it reads from.
--
-- Only 'sent' rows are visible. A scheduled message that has not gone out yet
-- is an admin's draft, and showing it early would both spoil it and make the
-- bell disagree with the device notification that arrives later.

-- ---------- notification_reads ----------
-- Per-user, per-notification. Deliberately its own table rather than a column
-- on push_notifications: one row there can be addressed to the whole team, so
-- "read" is a fact about a (person, message) pair and cannot live on either
-- one alone.
--
-- No updated_at and no unread state stored: a row's presence IS "read", its
-- absence is "unread". Nothing ever needs to flip back, so there is no second
-- state to keep consistent.
CREATE TABLE IF NOT EXISTS public.notification_reads (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES public.push_notifications(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;

-- Your own rows, and only ever your own -- including for an admin. Reading
-- whether someone else has opened a message is a different capability from
-- sending it, and nothing in this app asks for it.
DROP POLICY IF EXISTS notification_reads_own_select ON public.notification_reads;
CREATE POLICY notification_reads_own_select ON public.notification_reads
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS notification_reads_own_insert ON public.notification_reads;
CREATE POLICY notification_reads_own_insert ON public.notification_reads
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notification_reads_own_delete ON public.notification_reads;
CREATE POLICY notification_reads_own_delete ON public.notification_reads
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- No UPDATE policy: read_at is set once, when the row is created. Changing it
-- later would only let a client rewrite its own history for no purpose.

-- ---------- list_my_notifications ----------
-- Every sent message addressed to the caller, newest first, with whether they
-- have read it. Columns are allow-listed, not excluded: a future column added
-- to push_notifications does not silently become readable here.
CREATE OR REPLACE FUNCTION public.list_my_notifications(p_limit int DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(n ORDER BY n_sent_at DESC), '[]'::jsonb)
    FROM (
      SELECT
        coalesce(pn.sent_at, pn.created_at) AS n_sent_at,
        jsonb_build_object(
          'id',             pn.id,
          'title',          pn.title,
          'body',           pn.body,
          'action',         pn.action,
          'action_payload', pn.action_payload,
          'sent_at',        coalesce(pn.sent_at, pn.created_at),
          -- null created_by means the scheduler generated it (a clock-out
          -- reminder), which the bell labels differently from something a
          -- person composed. The id itself is not exposed -- only whether one
          -- was there.
          'from_system',    (pn.created_by IS NULL),
          'read',           (nr.user_id IS NOT NULL)
        ) AS n
      FROM public.push_notifications pn
      LEFT JOIN public.notification_reads nr
        ON nr.notification_id = pn.id AND nr.user_id = auth.uid()
      WHERE pn.status = 'sent'
        AND (
          pn.target_type = 'all'
          OR (pn.target_type = 'users' AND auth.uid() = ANY(pn.target_user_ids))
        )
      ORDER BY coalesce(pn.sent_at, pn.created_at) DESC
      LIMIT v_limit
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.list_my_notifications(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_my_notifications(int) TO authenticated;

-- ---------- mark_notifications_read ----------
-- Marks messages read for the caller. Insert-only and idempotent: re-marking
-- something already read is a no-op rather than an error, because the client
-- marks on open and has no reason to track what it already sent.
--
-- Silently ignores ids the caller was not actually sent. A recipient check
-- here is what stops this being an oracle for "does this notification id
-- exist", which a bare insert against the table could not prevent.
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF array_length(p_ids, 1) > 200 THEN
    RAISE EXCEPTION 'too many ids in one call';
  END IF;

  INSERT INTO public.notification_reads (user_id, notification_id)
  SELECT auth.uid(), pn.id
  FROM public.push_notifications pn
  WHERE pn.id = ANY(p_ids)
    AND pn.status = 'sent'
    AND (
      pn.target_type = 'all'
      OR (pn.target_type = 'users' AND auth.uid() = ANY(pn.target_user_ids))
    )
  ON CONFLICT (user_id, notification_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;
