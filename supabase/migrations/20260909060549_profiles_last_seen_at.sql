-- STATUS: APPLIED to the live project on 2026-09-09.
--
-- "Last sign-in" answered a question nobody was asking.
--
-- auth.users.last_sign_in_at only moves on an actual authentication event.
-- This app holds a persistent session and refreshes tokens silently, so a
-- person who signed in once and never signed out uses it every day while that
-- column stays frozen on the day they first authenticated. The People list
-- read "27d ago" for someone who had written an entry that morning, which is
-- what prompted this.
--
-- The column itself was never wrong; it was being read as activity when it
-- measures authentication. last_seen_at is the fact the admin console was
-- actually trying to show. Both are kept: "signed in 27 days ago, last used it
-- today" describes a perfectly ordinary person on a phone that never signs out.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- So the column is never worse than what the list already displayed: a person
-- who has not been seen since this shipped still reports their real sign-in.
UPDATE public.profiles p
SET last_seen_at = au.last_sign_in_at
FROM auth.users au
WHERE au.id = p.id AND p.last_seen_at IS NULL;

-- Deliberately an RPC rather than a column GRANT. The write is
-- last_seen_at = now() for auth.uid() and nothing else, so the value is
-- server-set and a client cannot backdate or forge it, and profiles gains no
-- second writable column beyond full_name (see
-- 20260815012052_fix_privilege_escalation_and_role_guard.sql, which exists
-- because a writable profiles column was a privilege-escalation hole once).
--
-- The profiles audit trigger returns early when neither role nor full_name
-- changed, so this does not write an audit row -- which matters, because it
-- runs for every person on every device roughly hourly.
CREATE OR REPLACE FUNCTION public.touch_last_seen()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.profiles SET last_seen_at = now() WHERE id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.touch_last_seen() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;

-- Carries last_seen_at alongside last_sign_in_at rather than replacing it:
-- they are different facts, and the admin console shows one and offers the
-- other on hover.
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
        'last_seen_at', p.last_seen_at,
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
