-- STATUS: APPLIED to the live project on 2026-08-13.
--
-- Reconstructed on 2026-08-20 from the live schema -- see the note at the top
-- of 20260813204929_admin_db_stats_function.sql for why this file exists.
--
-- admin_set_user_role() is NOT defined here even though it's part of the same
-- "user management" surface -- its current, correct definition lives entirely
-- in 20260815012052_fix_privilege_escalation_and_role_guard.sql, and
-- reconstructing a second copy here would just leave two definitions of the
-- same function sitting in this folder for a future reader to reconcile.

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can list users';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(u ORDER BY u->>'email'), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'email', p.email,
        'full_name', p.full_name,
        'role', p.role,
        'created_at', p.created_at,
        'last_sign_in_at', au.last_sign_in_at,
        'deactivated', (au.banned_until IS NOT NULL AND au.banned_until > now()),
        'entry_count', (SELECT count(*) FROM public.entries e WHERE e.user_id = p.id)
      ) AS u
      FROM public.profiles p
      LEFT JOIN auth.users au ON au.id = p.id
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_users() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;

-- Deactivate/reactivate via auth.users.banned_until rather than a soft-delete
-- flag on profiles, so a deactivated account is actually locked out at the
-- auth layer, not just hidden in the UI.
CREATE OR REPLACE FUNCTION public.admin_set_user_active(target_id uuid, make_active boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_target_email text;
  v_admin_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can change account status';
  END IF;

  IF target_id = v_actor AND NOT make_active THEN
    RAISE EXCEPTION 'You cannot deactivate your own account';
  END IF;

  -- Never allow locking out the last remaining admin.
  IF NOT make_active THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles p
    JOIN auth.users au ON au.id = p.id
    WHERE p.role = 'admin'
      AND (au.banned_until IS NULL OR au.banned_until <= now());
    IF v_admin_count <= 1 AND (SELECT role FROM public.profiles WHERE id = target_id) = 'admin' THEN
      RAISE EXCEPTION 'Cannot deactivate the only active admin';
    END IF;
  END IF;

  UPDATE auth.users
  SET banned_until = CASE WHEN make_active THEN NULL ELSE 'infinity'::timestamptz END
  WHERE id = target_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;
  SELECT email INTO v_target_email FROM public.profiles WHERE id = target_id;

  INSERT INTO public.audit_log(actor_id, actor_email, action, table_name, record_id,
                               target_user_id, target_email, new_values)
  VALUES (v_actor, v_actor_email,
          CASE WHEN make_active THEN 'user_reactivated' ELSE 'user_deactivated' END,
          'auth.users', target_id::text, target_id, v_target_email,
          jsonb_build_object('active', make_active));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_user_active(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_active(uuid, boolean) TO authenticated;
