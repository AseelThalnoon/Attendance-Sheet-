-- Admin visibility into another person's registered push devices.
--
-- push_subscriptions is RLS-scoped to its own owner (push_subscriptions_own,
-- see 20260908073920_push_notifications.sql) for a reason stated explicitly
-- in 20260909055532_admin_push_reach.sql: "an admin has no reason to see
-- endpoints or keys." That held while the only admin-facing need was an
-- aggregate reach count for the broadcast composer. It stops holding the
-- moment a real person reports "I'm not getting notified" and the admin
-- looking at their Settings cannot see whether they have a device registered
-- at all, let alone which one is stale and worth clearing -- full parity with
-- what the account owner already sees of their own list, not a second,
-- thinner view of the same table.
--
-- p256dh/auth (the subscription's encryption keys) are still never returned:
-- nothing admin-facing needs them, and they are the one thing here that could
-- actually be misused (forging a push to that endpoint from outside this
-- app). endpoint is returned -- an admin can already act on a person's
-- account far more consequentially than this (deactivate it, delete it,
-- reset its password), and removing one specific stale device requires
-- naming it.

CREATE OR REPLACE FUNCTION public.admin_list_user_push_devices(target_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can view another person''s devices';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(d ORDER BY d->>'created_at' DESC), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'endpoint', s.endpoint,
        'user_agent', s.user_agent,
        'created_at', s.created_at
      ) AS d
      FROM public.push_subscriptions s
      WHERE s.user_id = target_id
    ) sub
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_user_push_devices(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_user_push_devices(uuid) TO authenticated;

-- Removing a device on someone else's behalf -- the same "stop sending here"
-- action the owner already has over their own list, for the support case
-- where they can't reach their own Settings to do it themselves (lost the
-- phone, the app in a broken state, or it's simply easier for whoever is
-- troubleshooting with them to do it directly). Logged like every other
-- admin mutation of another person's data.
CREATE OR REPLACE FUNCTION public.admin_delete_user_push_device(target_id uuid, target_endpoint text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_target_email text;
  v_ua text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can remove another person''s device';
  END IF;

  SELECT user_agent INTO v_ua FROM public.push_subscriptions
  WHERE user_id = target_id AND endpoint = target_endpoint;

  DELETE FROM public.push_subscriptions
  WHERE user_id = target_id AND endpoint = target_endpoint;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor;
  SELECT email INTO v_target_email FROM public.profiles WHERE id = target_id;

  INSERT INTO public.audit_log(actor_id, actor_email, action, table_name, record_id,
                               target_user_id, target_email, new_values)
  VALUES (v_actor, v_actor_email, 'push_device_removed', 'push_subscriptions', target_endpoint,
          target_id, v_target_email, jsonb_build_object('device', v_ua));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_user_push_device(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user_push_device(uuid, text) TO authenticated;
