// The one place that ever actually talks to a push service. Both an admin's
// broadcast and check-clockout-reminders' automatic nudge do nothing more
// than insert a row into push_notifications -- this function is what turns
// that row into a real Web Push message, and the only thing capable of
// getting delivery wrong.
//
// Invoked two ways, both landing in the same claim-then-send path:
//   - by pg_cron every minute, with no body -- picks up everything due
//   - directly by the admin composer right after inserting a row (body:
//     {id: "<uuid>"}), so a "send now" broadcast doesn't wait out the next
//     cron tick to feel like it went anywhere
//
// Claiming (pending -> sending, in one UPDATE ... RETURNING) is what stops
// those two paths from racing each other into a double send.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  let targetId: string | null = null;
  try {
    const body = await req.json();
    targetId = body?.id ?? null;
  } catch {
    // No body (or not JSON) is the normal cron-tick case, not an error.
  }

  let claim = supabase
    .from("push_notifications")
    .update({ status: "sending" })
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString());
  if (targetId) claim = claim.eq("id", targetId);

  const { data: claimed, error: claimErr } = await claim.select("*");
  if (claimErr) {
    return new Response(JSON.stringify({ error: claimErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = [];
  for (const notification of claimed ?? []) {
    results.push(await sendOne(notification));
  }
  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function sendOne(notification: Record<string, any>) {
  // Deliberately not joined to profiles/auth.users to check for a
  // deactivated or deleted account: a deleted user's rows are already gone
  // (ON DELETE CASCADE from push_subscriptions.user_id), and auth.users
  // (where "deactivated" actually lives, as banned_until) isn't reachable
  // from this client the way public tables are. A still-subscribed but
  // deactivated employee getting one more push is an acceptable gap, not a
  // security issue -- they're already locked out of the app itself.
  let subsQuery = supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth");
  if (notification.target_type === "users") {
    subsQuery = subsQuery.in("user_id", notification.target_user_ids ?? []);
  }
  const { data: subs, error: subsErr } = await subsQuery;

  if (subsErr) {
    await supabase.from("push_notifications").update({
      status: "failed",
      error_detail: subsErr.message,
      sent_at: new Date().toISOString(),
    }).eq("id", notification.id);
    return { id: notification.id, ok: false, error: subsErr.message };
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    action: notification.action || null,
    data: notification.action_payload || {},
  });

  let sent = 0, failed = 0;
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err: any) {
      failed++;
      // The push service itself is saying this subscription is dead -- kept
      // around, it would just fail exactly the same way on every future send.
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        await supabase.from("push_subscriptions").delete().eq("id", sub.id);
      }
    }
  }

  // A subscriptionless target (nobody opted in yet) is not a failure of the
  // send itself -- there was simply nothing to deliver to.
  const status = failed > 0 && sent === 0 && (subs ?? []).length > 0 ? "failed" : "sent";
  await supabase.from("push_notifications").update({
    status,
    sent_at: new Date().toISOString(),
    recipient_count: sent,
    failure_count: failed,
  }).eq("id", notification.id);

  // One audit row per send, not per recipient: the count already says how
  // many, and a thousand identical rows for one broadcast would drown out
  // the log that exists to surface the unusual thing.
  // audit_log's actor_email/target_email are plain columns, resolved once at
  // write time (see log_entry_change()'s own trigger for entries) rather than
  // joined live by admin_audit_log() -- this function is the "trigger" for
  // push_notifications, so it has to do that resolution itself.
  const singleTargetId =
    notification.target_type === "users" && notification.target_user_ids?.length === 1
      ? notification.target_user_ids[0]
      : null;
  const emailLookupIds = [notification.created_by, singleTargetId].filter(Boolean);
  const emailByUserId: Record<string, string> = {};
  if (emailLookupIds.length) {
    const { data: emailRows } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", emailLookupIds);
    for (const row of emailRows ?? []) emailByUserId[row.id] = row.email;
  }

  await supabase.from("audit_log").insert({
    actor_id: notification.created_by,
    actor_email: notification.created_by ? emailByUserId[notification.created_by] ?? null : null,
    action: "notification_sent",
    table_name: "push_notifications",
    record_id: notification.id,
    target_user_id: singleTargetId,
    target_email: singleTargetId ? emailByUserId[singleTargetId] ?? null : null,
    new_values: {
      title: notification.title,
      target_type: notification.target_type,
      recipient_count: sent,
      failure_count: failed,
    },
  });

  return { id: notification.id, ok: sent > 0, sent, failed };
}
