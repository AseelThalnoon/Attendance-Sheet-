-- STATUS: APPLIED to the live project on 2026-08-15.
--
-- Closes the privilege-escalation hole found in the 2026-08-15 audit (C-1).
--
-- The UPDATE policy on public.profiles was created with a USING clause and no
-- WITH CHECK. Postgres reuses USING as WITH CHECK in that case, and the
-- predicate (id = auth.uid()) is satisfied both before and after the write — so
-- any authenticated user could PATCH their own profile row and set role='admin',
-- gaining read/write access to every employee's attendance, the audit log, and
-- user deletion. Verified against the live database and rolled back.

-- 1. Remove the API's ability to touch privileged columns at all.
REVOKE UPDATE ON public.profiles FROM authenticated, anon;
REVOKE INSERT ON public.profiles FROM authenticated, anon;
GRANT  UPDATE (full_name) ON public.profiles TO authenticated;

-- 2. Make the policy explicit rather than relying on the implicit reuse.
DROP POLICY IF EXISTS profiles_update_own_or_admin ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING      (id = (select auth.uid()) OR public.is_admin())
  WITH CHECK (id = (select auth.uid()) OR public.is_admin());

DROP POLICY IF EXISTS profiles_select_own_or_admin ON public.profiles;
CREATE POLICY profiles_select_own_or_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (select auth.uid()) OR public.is_admin());

-- 3. Defence in depth: reject role/id/email rewrites even if a grant regresses.
CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can change a role' USING ERRCODE = '42501';
  END IF;
  NEW.id    := OLD.id;      -- immutable: the auth.users foreign key
  NEW.email := OLD.email;   -- owned by auth.users, not editable here
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_guard_columns ON public.profiles;
CREATE TRIGGER profiles_guard_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_columns();

-- 4. Role changes go through an RPC that enforces the last-admin rule
--    server-side. That rule previously existed only in the browser, so a direct
--    API call could strip the final admin and lock the organisation out.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(target_id uuid, new_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target_role text;
  v_admin_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can change roles' USING ERRCODE = '42501';
  END IF;
  IF new_role NOT IN ('user','admin') THEN
    RAISE EXCEPTION 'Unknown role: %', new_role;
  END IF;

  SELECT role INTO v_target_role FROM public.profiles WHERE id = target_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'That user no longer exists';
  END IF;
  IF v_target_role = new_role THEN
    RETURN;
  END IF;

  IF v_target_role = 'admin' AND new_role <> 'admin' THEN
    SELECT count(*) INTO v_admin_count FROM public.profiles WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot remove the only administrator';
    END IF;
  END IF;

  UPDATE public.profiles SET role = new_role WHERE id = target_id;
END $$;

REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, text) TO authenticated;
