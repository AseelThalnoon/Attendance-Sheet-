-- Who can actually be reached by a push notification.
--
-- The admin composer had no way to ask this. push_subscriptions is guarded by
-- push_subscriptions_own (user_id = auth.uid()), which is correct -- one
-- person's devices are nobody else's business, and an admin has no reason to
-- see endpoints or keys -- but it also means a client-side count returns the
-- admin's own devices and nothing else. So "Send to everyone" looked identical
-- whether everyone was subscribed or nobody was, and a send to nobody reported
-- success, because it WAS a success: it delivered to every subscriber there
-- was, and there were none.
--
-- This returns counts only. No endpoints, no keys, no per-person breakdown of
-- who has notifications switched on -- an aggregate is all the composer needs
-- to tell an admin whether pressing Send will reach anyone, and it is the most
-- that can be exposed without turning an RLS-protected table into a roster of
-- who runs what browser.
--
-- Deactivated accounts are excluded on the same rule the rest of the admin
-- surface uses (auth.users.banned_until, not a profiles flag -- see
-- 20260813205030_admin_user_management_functions.sql), because a banned user
-- cannot receive anything and counting them would overstate the reach.

CREATE OR REPLACE FUNCTION public.admin_push_reach()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  active_people int;
  subscribed_people int;
  device_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can read notification reach';
  END IF;

  SELECT count(*)::int INTO active_people
  FROM public.profiles p
  LEFT JOIN auth.users au ON au.id = p.id
  WHERE au.banned_until IS NULL OR au.banned_until <= now();

  SELECT count(DISTINCT s.user_id)::int, count(*)::int
    INTO subscribed_people, device_count
  FROM public.push_subscriptions s
  JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN auth.users au ON au.id = p.id
  WHERE au.banned_until IS NULL OR au.banned_until <= now();

  RETURN jsonb_build_object(
    'people', active_people,
    'subscribed', subscribed_people,
    'devices', device_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_push_reach() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_push_reach() TO authenticated;
