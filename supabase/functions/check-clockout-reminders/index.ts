// Cron only (every 15 minutes since 20261117090000_clockin_reminders; it was
// hourly) -- never invoked directly. Finds every open shift that has passed
// its owner's own remindAfterHours threshold and enqueues one
// push_notifications row per reminder with a clock_out action. It never sends
// anything itself: send-push's own cron tick (running every minute) picks the
// new row up within a minute or two, so there is exactly one place in the
// whole system that talks to a push service.
//
// It also sends the clock-in reminder (dueClockInReminders below): once a day,
// to someone with notifications on a device, on one of their workdays, with
// nothing logged for today 30 minutes after their start time.
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

// "Hourly cron only -- never invoked directly" was a description, not a rule:
// the platform's own gate (verify_jwt) lets in any token this project issued,
// and every signed-in account holds one. The guard rows stop a second run from
// sending a second reminder, so the worst a stranger could do was make the job
// run early -- but a job that reads every open shift and every schedule should
// be started by the scheduler and by nobody else.
//
// The role is read from the token's payload, which is trustworthy only because
// verify_jwt is ON for this function and the platform has checked the
// signature before this code runs. Turn that off and this has to change. (See
// send-push, which carries the same check and the longer explanation.)
function calledByScheduler(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === SERVICE_ROLE_KEY) return true;
  try {
    const part = token.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    return JSON.parse(atob(padded))?.role === "service_role";
  } catch {
    return false;
  }
}

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

// ---------- Clock-in reminder ----------
// The clock-out reminder caught a forgotten punch at the end of a shift; there
// was nothing for one at the start, and on 2026-11-16 eight of sixteen
// accounts had never logged a day. One push, once a day, to:
//   * someone with at least one device registered for notifications (a row in
//     the bell for everybody else would be a daily nag they never asked for),
//   * who has not switched it off (settings.remindClockIn === false),
//   * on one of their own workdays,
//   * with no entry at all for today -- leave, a holiday or a sick day logged
//     ahead counts as logged, and so does a punch on another device,
//   * and no shift still open from yesterday (a night shift is clocked in),
//   * from CLOCKIN_GRACE_MIN after their start time until their end time:
//     after the end of the day it is a record to fix, not a punch to make.
const CLOCKIN_GRACE_MIN = 30;

function dueClockInReminders(
  userIds: string[],
  settingsByUser: Map<string, any>,
  orgDefault: Record<string, any>,
  recentEntries: any[],        // every entry dated yesterday or today
  sentTodayIds: Set<string>,   // clockin_reminders_sent rows for today
  nowMs: number,
) {
  const local = new Date(nowMs + RIYADH_OFFSET_MS);
  const today = dateStr(local);
  const yesterday = dateStr(new Date(nowMs + RIYADH_OFFSET_MS - 86400000));
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const notifications: any[] = [];
  const guards: any[] = [];

  for (const userId of userIds) {
    if (sentTodayIds.has(userId)) continue;
    const raw = settingsByUser.has(userId)
      ? settingsByUser.get(userId)
      : Object.keys(orgDefault).length ? orgDefault : {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    if (settings.remindClockIn === false) continue;

    const workDays = (Array.isArray(settings.workDays) ? settings.workDays : DEFAULT_SETTINGS.workDays).map(Number);
    if (!workDays.includes(local.getUTCDay())) continue;

    const mine = recentEntries.filter((e) => e.user_id === userId);
    if (mine.some((e) => e.date === today)) continue;
    if (mine.some((e) => e.date === yesterday && e.clock_in && !e.clock_out && !EXCUSED_TYPES.includes(e.type))) continue;

    const startIn = scheduleTimeFor(settings, today, "standardIn");
    const endOut = scheduleTimeFor(settings, today, "standardOut");
    const startMin = toMinutes(startIn), endMin = toMinutes(endOut);
    if (!isFinite(startMin) || nowMin < startMin + CLOCKIN_GRACE_MIN) continue;
    // A day that ends after midnight (end before start) has no "too late" here.
    if (isFinite(endMin) && endMin > startMin && nowMin >= endMin) continue;

    notifications.push({
      created_by: null,
      title: "You haven't clocked in",
      body: `Your day started at ${formatTime12(startIn)}. Clock in now, or ignore this if you're off today.`,
      target_type: "users",
      target_user_ids: [userId],
      action: "clock_in",
      action_payload: { date: today, label: "Clock In Now" },
      scheduled_for: new Date(nowMs).toISOString(),
    });
    guards.push({ user_id: userId, sent_on: today });
  }
  return { notifications, guards };
}

Deno.serve(async (req) => {
  if (!calledByScheduler(req)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  // ---- The clock-in reminder ----
  // Any read failing skips it for this run rather than failing the whole job:
  // the clock-out half above has already done its work, and the next run is
  // fifteen minutes away. That includes clockin_reminders_sent not existing
  // yet -- without its rows every run would look un-reminded, so no guard
  // table means no clock-in reminders at all, never one every fifteen minutes.
  let clockInQueued = 0;
  const yesterday = dateStr(new Date(Date.now() + RIYADH_OFFSET_MS - 86400000));
  const [{ data: subs, error: subsErr }, { data: recent, error: recentErr }, { data: sentRows, error: sentErr }] =
    await Promise.all([
      supabase.from("push_subscriptions").select("user_id"),
      supabase.from("entries").select("user_id, date, clock_in, clock_out, type").gte("date", yesterday).lte("date", today),
      supabase.from("clockin_reminders_sent").select("user_id").eq("sent_on", today),
    ]);
  if (!subsErr && !recentErr && !sentErr) {
    const userIds = [...new Set((subs ?? []).map((s) => s.user_id))];
    const sentTodayIds = new Set((sentRows ?? []).map((r) => r.user_id));
    const due = dueClockInReminders(userIds, settingsByUser, orgDefault, recent ?? [], sentTodayIds, Date.now());
    if (due.notifications.length) {
      const { error: inErr } = await supabase.from("push_notifications").insert(due.notifications);
      if (!inErr) {
        await supabase.from("clockin_reminders_sent").upsert(due.guards, {
          onConflict: "user_id,sent_on",
          ignoreDuplicates: true,
        });
        clockInQueued = due.notifications.length;
      }
    }
  }

  return new Response(JSON.stringify({ queued: notifications.length, clockInQueued }), {
    headers: { "Content-Type": "application/json" },
  });
});
