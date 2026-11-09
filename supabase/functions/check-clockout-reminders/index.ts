// Hourly cron only -- never invoked directly. Finds every open shift that
// has passed its owner's own remindAfterHours threshold and enqueues one
// push_notifications row per reminder with a clock_out action. It never sends
// anything itself: send-push's own cron tick (running every minute) picks the
// new row up within a minute or two, so there is exactly one place in the
// whole system that talks to a push service.
//
// At most two reminders per shift:
//   * "Still clocked in" -- the same day, once remindAfterHours have passed.
//   * "You never clocked out" -- once, for a shift still open from an earlier
//     day, at the person's usual start time on their next working day. It
//     used to go out on the first run after midnight (00:00 Riyadh) and again
//     every night until the shift was fixed, however old the shift was.
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

// Everything from here down to Deno.serve is pure -- no I/O, no clock reads --
// and tests/regression/clockout-reminders.js runs it exactly as written.
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const EXCUSED_TYPES = ["leave", "sick", "holiday", "other"];
// Mirrors DEFAULT_SETTINGS in src/constants.js -- kept in sync by hand since
// this function has no access to that file at build time.
const DEFAULT_SETTINGS = {
  remindAfterHours: 9,
  standardIn: "08:00",
  standardOut: "16:00",
  workDays: [0, 1, 2, 3, 4],
  periods: [],
};

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toMinutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}
// Same rule as scheduleFor() in src/schedule.js: the first seasonal period
// covering this date wins; otherwise the person's own standard time.
function scheduleTimeFor(settings: Record<string, any>, date: string, field: "standardIn" | "standardOut"): string {
  const periods = Array.isArray(settings.periods) ? settings.periods : [];
  for (const p of periods) {
    if (p?.start && p?.end && date >= p.start && date <= p.end && p[field]) {
      return p[field];
    }
  }
  return settings[field] || DEFAULT_SETTINGS[field];
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

// Which open shifts get a reminder on this run, and the guard rows recording
// that they did. guardRows must hold every clockout_reminders_sent row for the
// open shifts' dates: a row sent on the shift's own day is the same-day
// reminder, and a row sent on any later day is the one "never clocked out".
function dueReminders(
  openEntries: any[],
  settingsByUser: Map<string, any>,
  orgDefault: Record<string, any>,
  guardRows: any[],
  nowMs: number,
) {
  // Shifted by the offset, so the UTC getters read Riyadh wall-clock time.
  const local = new Date(nowMs + RIYADH_OFFSET_MS);
  const today = dateStr(local);
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const key = (userId: string, date: string) => `${userId}|${date}`;
  const sentToday = new Set(
    guardRows.filter((r) => r.sent_on === today).map((r) => key(r.user_id, r.entry_date)),
  );
  const sentAfterTheDay = new Set(
    guardRows.filter((r) => r.sent_on > r.entry_date).map((r) => key(r.user_id, r.entry_date)),
  );

  const notifications: any[] = [];
  const guards: any[] = [];

  for (const entry of openEntries) {
    if (EXCUSED_TYPES.includes(entry.type)) continue;

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
    if ((nowMs - clockInMs) / 3600000 < settings.remindAfterHours) continue;

    const isToday = entry.date === today;
    if (isToday) {
      if (sentToday.has(key(entry.user_id, entry.date))) continue;
    } else {
      // Once per shift, not once a night.
      if (sentAfterTheDay.has(key(entry.user_id, entry.date))) continue;
      // And when they're starting work, not at midnight or on a day off: the
      // reminder is for fixing a record, which can wait for the morning.
      const workDays = (Array.isArray(settings.workDays) ? settings.workDays : DEFAULT_SETTINGS.workDays).map(Number);
      if (!workDays.includes(local.getUTCDay())) continue;
      if (nowMin < toMinutes(scheduleTimeFor(settings, today, "standardIn"))) continue;
    }

    const standardOut = scheduleTimeFor(settings, entry.date, "standardOut");
    const title = isToday ? "Still clocked in" : "You never clocked out";
    const body = isToday
      ? `You clocked in at ${formatTime12(entry.clock_in)} and haven't clocked out yet.`
      : `You clocked in on ${entry.date} at ${formatTime12(entry.clock_in)} with no clock-out. That day won't count toward your averages until you add one.`;

    notifications.push({
      created_by: null,
      title,
      body,
      target_type: "users",
      target_user_ids: [entry.user_id],
      action: "clock_out",
      action_payload: { date: entry.date, standard_out: standardOut, label: `Clock Out at ${formatTime12(standardOut)}` },
      scheduled_for: new Date(nowMs).toISOString(),
    });
    guards.push({ user_id: entry.user_id, entry_date: entry.date, sent_on: today });
  }

  return { notifications, guards };
}

Deno.serve(async () => {
  const today = dateStr(new Date(Date.now() + RIYADH_OFFSET_MS));

  const [{ data: openEntries, error: entriesErr }, { data: settingsRows }, { data: appSettingsRow }] =
    await Promise.all([
      supabase
        .from("entries")
        .select("id, user_id, date, clock_in, type")
        .not("clock_in", "is", null)
        .is("clock_out", null)
        .lte("date", today),
      supabase.from("user_settings").select("user_id, settings"),
      supabase.from("app_settings").select("default_settings").eq("id", 1).maybeSingle(),
    ]);

  if (entriesErr) {
    return new Response(JSON.stringify({ error: entriesErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const open = openEntries ?? [];
  const dates = [...new Set(open.map((e) => e.date))];
  const { data: guardRows, error: guardErr } = dates.length
    ? await supabase.from("clockout_reminders_sent").select("user_id, entry_date, sent_on").in("entry_date", dates)
    : { data: [], error: null };
  // Without the guard rows every shift would look un-reminded, and this run
  // would send everything again.
  if (guardErr) {
    return new Response(JSON.stringify({ error: guardErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const settingsByUser = new Map((settingsRows ?? []).map((r) => [r.user_id, r.settings || {}]));
  const orgDefault = appSettingsRow?.default_settings || {};
  const { notifications, guards } = dueReminders(open, settingsByUser, orgDefault, guardRows ?? [], Date.now());

  if (notifications.length) {
    const { error: insertErr } = await supabase.from("push_notifications").insert(notifications);
    if (insertErr) {
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Recorded only after the notifications actually queued -- a failed
    // insert above must not silently mark a reminder as "handled".
    // upsert+ignoreDuplicates rather than insert: an overlapping run (this
    // job taking longer than an hour) hitting the same primary key must not
    // throw and skip the rest of the batch's guard rows.
    await supabase.from("clockout_reminders_sent").upsert(guards, {
      onConflict: "user_id,entry_date,sent_on",
      ignoreDuplicates: true,
    });
  }

  return new Response(JSON.stringify({ queued: notifications.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
