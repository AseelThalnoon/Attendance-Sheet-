// Hourly cron only -- never invoked directly. Finds every open shift that
// has passed its owner's own remindAfterHours threshold and hasn't already
// been nudged today, and enqueues one push_notifications row per shift with
// a clock_out action. It never sends anything itself: send-push's own
// cron tick (running every minute) picks the new row up within a minute or
// two, so there is exactly one place in the whole system that talks to a
// push service.
//
// "Today" and elapsed time are computed in Asia/Riyadh (fixed UTC+3,
// year-round -- no DST to account for), because entries/user_settings store
// plain date/time strings with no timezone of their own. The client gets
// away with using the browser's local clock; this runs on a server with no
// browser, so the organisation's timezone has to be explicit here.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const EXCUSED_TYPES = ["leave", "sick", "holiday", "other"];
// Mirrors DEFAULT_SETTINGS in app.js -- kept in sync by hand since this
// function has no access to that file at build time.
const DEFAULT_SETTINGS = { remindAfterHours: 9, standardOut: "16:00", periods: [] };

function riyadhNow(): Date {
  return new Date(Date.now() + RIYADH_OFFSET_MS);
}
function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// Same rule as scheduleFor() in app.js: the first seasonal period covering
// this date wins; otherwise the org/person's own standard end time.
function standardOutFor(settings: Record<string, any>, dateStr: string): string {
  const periods = Array.isArray(settings.periods) ? settings.periods : [];
  for (const p of periods) {
    if (p?.start && p?.end && dateStr >= p.start && dateStr <= p.end && p.standardOut) {
      return p.standardOut;
    }
  }
  return settings.standardOut || DEFAULT_SETTINGS.standardOut;
}
// formatTime12 in app.js, restated here so the push's action label reads the
// same way ("4:00 PM") as the in-app banner's, not a bare 24h "16:00".
function formatTime12(t: string): string {
  const [hStr, m] = t.split(":");
  const h = Number(hStr);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${period}`;
}

Deno.serve(async () => {
  const now = riyadhNow();
  const today = dateStr(now);

  const [{ data: openEntries, error: entriesErr }, { data: settingsRows }, { data: appSettingsRow }, { data: alreadySent }] =
    await Promise.all([
      supabase
        .from("entries")
        .select("id, user_id, date, clock_in, type")
        .not("clock_in", "is", null)
        .is("clock_out", null)
        .lte("date", today),
      supabase.from("user_settings").select("user_id, settings"),
      supabase.from("app_settings").select("default_settings").eq("id", 1).maybeSingle(),
      supabase.from("clockout_reminders_sent").select("user_id, entry_date").eq("sent_on", today),
    ]);

  if (entriesErr) {
    return new Response(JSON.stringify({ error: entriesErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const settingsByUser = new Map((settingsRows ?? []).map((r) => [r.user_id, r.settings || {}]));
  const orgDefault = appSettingsRow?.default_settings || {};
  const alreadySentKeys = new Set((alreadySent ?? []).map((r) => `${r.user_id}|${r.entry_date}`));

  const dueNotifications: any[] = [];
  const dueGuardRows: any[] = [];

  for (const entry of openEntries ?? []) {
    if (EXCUSED_TYPES.includes(entry.type)) continue;
    if (alreadySentKeys.has(`${entry.user_id}|${entry.date}`)) continue;

    // A row in user_settings (however empty) beats the org default beats the
    // hardcoded fallback, the same whole-object fallback order isUnconfigured()
    // and scheduleFor() use client-side -- not a field-by-field merge across
    // all three tiers.
    const raw = settingsByUser.has(entry.user_id)
      ? settingsByUser.get(entry.user_id)
      : Object.keys(orgDefault).length
        ? orgDefault
        : {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    // Sliced to "HH:MM" regardless of whether the column round-trips with a
    // :SS component (a plain text "HH:MM" and a Postgres time both reach
    // here fine either way; app.js's own formatTime12 is tolerant of this
    // same ambiguity by the same means -- only ever reading the first two
    // colon-separated parts).
    const clockInMs = Date.parse(`${entry.date}T${entry.clock_in.slice(0, 5)}:00+03:00`);
    if (!isFinite(clockInMs)) continue;
    const elapsedHours = (Date.now() - clockInMs) / 3600000;
    if (elapsedHours < settings.remindAfterHours) continue;

    const isToday = entry.date === today;
    const standardOut = standardOutFor(settings, entry.date);
    const title = isToday ? "Still clocked in" : "You never clocked out";
    const body = isToday
      ? `You clocked in at ${formatTime12(entry.clock_in)} and haven't clocked out yet.`
      : `You clocked in on ${entry.date} at ${formatTime12(entry.clock_in)} with no clock-out. That day won't count toward your averages until you add one.`;

    dueNotifications.push({
      created_by: null,
      title,
      body,
      target_type: "users",
      target_user_ids: [entry.user_id],
      action: "clock_out",
      action_payload: { date: entry.date, standard_out: standardOut, label: `Clock Out at ${formatTime12(standardOut)}` },
      scheduled_for: new Date().toISOString(),
    });
    dueGuardRows.push({ user_id: entry.user_id, entry_date: entry.date, sent_on: today });
  }

  if (dueNotifications.length) {
    const { error: insertErr } = await supabase.from("push_notifications").insert(dueNotifications);
    if (insertErr) {
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Recorded only after the notifications actually queued -- a failed
    // insert above must not silently mark today's reminder as "handled".
    // upsert+ignoreDuplicates rather than insert: an overlapping run (this
    // job taking longer than an hour) hitting the same primary key must not
    // throw and skip the rest of the batch's guard rows.
    await supabase.from("clockout_reminders_sent").upsert(dueGuardRows, {
      onConflict: "user_id,entry_date,sent_on",
      ignoreDuplicates: true,
    });
  }

  return new Response(JSON.stringify({ queued: dueNotifications.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
