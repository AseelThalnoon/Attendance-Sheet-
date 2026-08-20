-- STATUS: APPLIED to the live project on 2026-08-13.
--
-- Reconstructed on 2026-08-20 from the live schema -- see the note at the top
-- of 20260813204929_admin_db_stats_function.sql for why this file exists.
--
-- The audit trail: every write to `entries` gets a row here, readable only
-- by admins. target_user_id is deliberately NOT foreign-keyed to auth.users
-- (unlike actor_id) -- admin_delete_user() logs the deletion immediately
-- before removing the row, and a log entry that vanished the moment its
-- subject was deleted would defeat the entire point of an audit trail.

CREATE TABLE public.audit_log (
  id             bigserial PRIMARY KEY,
  actor_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email    text,
  action         text NOT NULL,
  table_name     text NOT NULL,
  record_id      text,
  target_user_id uuid,
  target_email   text,
  entry_date     date,
  old_values     jsonb,
  new_values     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_actor_idx   ON public.audit_log (actor_id);
CREATE INDEX audit_log_target_idx  ON public.audit_log (target_user_id);
CREATE INDEX audit_log_created_idx ON public.audit_log (created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select_admin ON public.audit_log
  FOR SELECT TO authenticated USING (public.is_admin());

-- Every insert/update/delete on entries writes its own audit row -- this
-- runs as the definer so an ordinary employee's own RLS grants (which don't
-- include audit_log) never block their own entry from being logged.
CREATE OR REPLACE FUNCTION public.log_entry_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_target uuid;
  v_target_email text;
  v_record_id text;
  v_entry_date date;
BEGIN
  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;

  IF tg_op = 'DELETE' THEN
    v_target := old.user_id;
    v_record_id := old.id::text;
    v_entry_date := old.date;
  ELSE
    v_target := new.user_id;
    v_record_id := new.id::text;
    v_entry_date := new.date;
  END IF;

  SELECT email INTO v_target_email FROM public.profiles WHERE id = v_target;

  INSERT INTO public.audit_log(
    actor_id, actor_email, action, table_name, record_id,
    target_user_id, target_email, entry_date, old_values, new_values
  ) VALUES (
    v_actor, v_actor_email, lower(tg_op), tg_table_name, v_record_id,
    v_target, v_target_email, v_entry_date,
    CASE WHEN tg_op IN ('UPDATE','DELETE') THEN to_jsonb(old) ELSE NULL END,
    CASE WHEN tg_op IN ('INSERT','UPDATE') THEN to_jsonb(new) ELSE NULL END
  );

  IF tg_op = 'DELETE' THEN RETURN old; ELSE RETURN new; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.log_entry_change() FROM public, anon, authenticated;

CREATE TRIGGER entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.entries
  FOR EACH ROW EXECUTE FUNCTION public.log_entry_change();
