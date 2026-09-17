-- Which specific people a push notification can reach.
--
-- Applied to the live project on 2026-09-17. The filename carries the version
-- the remote history actually recorded (20260917135322), not the one this file
-- was drafted under, for the same reason the pending_ file keeps its original
-- name: a migration whose filename does not match the remote row is a
-- migration nobody can tell the status of later.
--
-- Verified after applying: the definition carries subscribed_ids, prosecdef is
-- still true, EXECUTE is granted to authenticated only (anon and public
-- revoked), and calling it without an admin auth.uid() raises
-- "Only admins can read notification reach" from the is_admin() guard.
--
-- 20260909055532_admin_push_reach.sql returned counts only, and said why:
-- "no per-person breakdown of who has notifications switched on -- an
-- aggregate is all the composer needs [...] and it is the most that can be
-- exposed without turning an RLS-protected table into a roster of who runs
-- what browser."
--
-- That reasoning was sound and it has already been superseded, deliberately,
-- by 20260909210000_admin_view_user_push_devices.sql -- which grants an admin
-- admin_list_user_push_devices(target_id), returning a named person's
-- endpoints, user agents and registration dates, plus the power to delete
-- them. Its own header states the retirement in as many words: the
-- counts-only line "held while the only admin-facing need was an aggregate
-- reach count for the broadcast composer. It stops holding the moment a real
-- person reports 'I'm not getting notified'."
--
-- So who-can-be-reached is already admin-visible, one person at a time. What
-- this adds is strictly less than that function already returns: a set of ids,
-- no endpoints, no user agents, no dates, no keys. It is the same question
-- admin_list_user_push_devices answers, asked once for everybody instead of
-- N times one at a time, and it exists because the composer's own count was
-- lying without it.
--
-- The lie: "Send to specific people" reported "2 selected people" whether or
-- not either of them had notifications switched on, so picking two people who
-- cannot receive anything read exactly like picking two who can -- the same
-- defect the reach line was added to fix for "Send to everyone", surviving one
-- branch over.
--
-- Deactivated accounts stay excluded, on the same auth.users.banned_until rule
-- the counts already use: a banned account cannot receive anything, and
-- listing it as reachable would overstate in a new place.
--
-- Additive by design. The existing keys are unchanged and the client treats a
-- missing subscribed_ids as "unknown", not as "nobody" -- the composer is
-- best-effort against this function on purpose, so a project that has not run
-- this migration yet keeps working and simply says less.

CREATE OR REPLACE FUNCTION public.admin_push_reach()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  active_people int;
  subscribed_people int;
  device_count int;
  subscribed_ids jsonb;
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

  SELECT coalesce(jsonb_agg(DISTINCT s.user_id), '[]'::jsonb) INTO subscribed_ids
  FROM public.push_subscriptions s
  JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN auth.users au ON au.id = p.id
  WHERE au.banned_until IS NULL OR au.banned_until <= now();

  RETURN jsonb_build_object(
    'people', active_people,
    'subscribed', subscribed_people,
    'devices', device_count,
    'subscribed_ids', subscribed_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_push_reach() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_push_reach() TO authenticated;
