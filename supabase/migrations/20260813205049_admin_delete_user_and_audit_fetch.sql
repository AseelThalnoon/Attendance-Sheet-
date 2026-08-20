-- STATUS: APPLIED to the live project on 2026-08-13.
--
-- Reconstructed on 2026-08-20 from the live schema -- see the note at the top
-- of 20260813204929_admin_db_stats_function.sql for why this file exists.

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_target_email text;
  v_target_role text;
  v_admin_count int;
  v_entry_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can delete users';
  END IF;

  IF target_id = v_actor THEN
    RAISE EXCEPTION 'You cannot delete your own account';
  END IF;

  SELECT email, role INTO v_target_email, v_target_role
  FROM public.profiles WHERE id = target_id;

  IF v_target_email IS NULL THEN
    RAISE EXCEPTION 'That user no longer exists';
  END IF;

  IF v_target_role = 'admin' THEN
    SELECT count(*) INTO v_admin_count FROM public.profiles WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot delete the only admin';
    END IF;
  END IF;

  SELECT count(*) INTO v_entry_count FROM public.entries WHERE user_id = target_id;

  -- Log BEFORE deleting, so the record survives the cascade. target_user_id
  -- has no foreign key back to auth.users for exactly this reason.
  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;
  INSERT INTO public.audit_log(actor_id, actor_email, action, table_name, record_id,
                               target_user_id, target_email, old_values)
  VALUES (v_actor, v_actor_email, 'user_deleted', 'auth.users', target_id::text,
          target_id, v_target_email,
          jsonb_build_object('role', v_target_role, 'entries_removed', v_entry_count));

  DELETE FROM auth.users WHERE id = target_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;

-- Backs the Admin > Activity Log tab. Filters are applied in SQL rather than
-- fetched wholesale, since audit_log grows unbounded and RLS alone would
-- still hand every admin the entire table on every page load.
CREATE OR REPLACE FUNCTION public.admin_audit_log(limit_n integer DEFAULT 100, filter_action text DEFAULT NULL, filter_user uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can view the audit log';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(row_to_json(l)), '[]'::jsonb)
    FROM (
      SELECT id, actor_email, action, table_name, record_id,
             target_email, entry_date, old_values, new_values, created_at
      FROM public.audit_log
      WHERE (filter_action IS NULL OR action = filter_action)
        AND (filter_user IS NULL OR target_user_id = filter_user OR actor_id = filter_user)
      ORDER BY created_at DESC
      LIMIT least(coalesce(limit_n, 100), 500)
    ) l
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_audit_log(integer, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_audit_log(integer, text, uuid) TO authenticated;
