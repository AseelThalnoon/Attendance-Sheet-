-- Clearing a message from the bell, one at a time or all at once.
--
-- A cleared message is a fact about a (person, message) pair, exactly like
-- "read", so it lives on the same row: notification_reads gains dismissed_at.
-- Clearing implies reading -- a cleared message never comes back as unread --
-- so one row carries both, and the existing primary key already guarantees
-- one row per pair.
--
-- Additive and backward compatible: the client before this change never
-- passes anything that touches dismissed_at, and list_my_notifications keeps
-- its exact output shape; it only stops returning cleared rows.

ALTER TABLE public.notification_reads
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- ---------- list_my_notifications ----------
-- Unchanged except for the last WHERE clause: a message the caller cleared
-- is no longer theirs to see.
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
        AND nr.dismissed_at IS NULL
      ORDER BY coalesce(pn.sent_at, pn.created_at) DESC
      LIMIT v_limit
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.list_my_notifications(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_my_notifications(int) TO authenticated;

-- ---------- dismiss_notifications ----------
-- Clears messages for the caller: the ids given, or -- with p_all -- every
-- message they were ever sent, including any older than the 50 the bell
-- loads. "Everything" is its own explicit flag rather than a NULL p_ids, so a
-- client bug that loses its id list cannot clear someone's whole history.
--
-- Same recipient check as mark_notifications_read: ids the caller was not
-- sent are ignored, so this is not an oracle for which ids exist.
CREATE OR REPLACE FUNCTION public.dismiss_notifications(p_ids uuid[] DEFAULT NULL, p_all boolean DEFAULT false)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT coalesce(p_all, false) THEN
    IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
      RETURN 0;
    END IF;
    IF array_length(p_ids, 1) > 200 THEN
      RAISE EXCEPTION 'too many ids in one call';
    END IF;
  END IF;

  INSERT INTO public.notification_reads (user_id, notification_id, dismissed_at)
  SELECT auth.uid(), pn.id, now()
  FROM public.push_notifications pn
  WHERE (coalesce(p_all, false) OR pn.id = ANY(p_ids))
    AND pn.status = 'sent'
    AND (
      pn.target_type = 'all'
      OR (pn.target_type = 'users' AND auth.uid() = ANY(pn.target_user_ids))
    )
  ON CONFLICT (user_id, notification_id)
    DO UPDATE SET dismissed_at = now()
    WHERE public.notification_reads.dismissed_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.dismiss_notifications(uuid[], boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_notifications(uuid[], boolean) TO authenticated;
