// Attendance Ledger — application module.
//
// Extracted from index.html so the page can ship a real Content-Security-Policy:
// an inline module would require script-src 'unsafe-inline', which defeats most
// of the point of having a policy at all. Deployment is still a static file copy;
// there is no build step.
// The one runtime dependency is vendored (vendor/supabase-js.min.js, pinned to
// 2.58.0) rather than fetched from a third-party CDN on every load. Previously
// a CDN outage, a blocking proxy, or simply opening the installed PWA with no
// connection left a pixel-perfect sign-in screen with no listeners attached and
// no error of any kind — the app looked fine and silently ignored you. Vendoring
// also removes an unpinned, unhashed third-party script that ran with full
// access to the session tokens in localStorage.
//
// Loaded dynamically so that failing to load is a state we can actually report,
// rather than a module that never executes.
function showBootFailure(){
  var warn = document.getElementById("authConfigWarning");
  if(!warn) return;
  warn.textContent = "Couldn't load the application. Check your connection and " +
    "reload the page. If you're offline, this app needs a connection to sign in.";
  warn.style.display = "block";
  var btn = document.getElementById("signInBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Unavailable"; }
  var reg = document.getElementById("registerBtn");
  if(reg){ reg.disabled = true; }
}

let createClient;
try {
  ({ createClient } = await import("./vendor/supabase-js.min.js"));
} catch (err) {
  showBootFailure();
  throw err;
}

// ============================================================================
// SUPABASE CONFIG — fill these in from your project's Settings > API page,
// then run supabase-schema.sql in the SQL Editor before first use.
// ============================================================================
const SUPABASE_URL = "https://lxnfiszrlgddpcbwavfw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lYQoZGV53IT-ExJ7xd8ZPw_GILZCWBq";

const supabaseConfigured =
  SUPABASE_URL.indexOf("YOUR_SUPABASE") === -1 &&
  SUPABASE_ANON_KEY.indexOf("YOUR_SUPABASE") === -1;

const supabase = supabaseConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

(function(){
  "use strict";

  var DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var DAY_FULL  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var TYPE_LABELS = {
    regular:"Regular", wfh:"WFH", halfleave:"Half Day Leave", leave:"Annual Leave",
    sick:"Sick Leave", trip:"Business Trip", training:"Training", holiday:"Public Holiday", other:"Other"
  };
  // An entry's type can be anything the database holds. Indexing TYPE_LABELS
  // directly rendered the literal string "undefined" in the log, the calendar
  // tooltip, the print report and the audit detail for any unrecognised value.
  function typeLabel(t){ return TYPE_LABELS[t] || (t ? String(t) : "Regular"); }

  var CAL_STATUS_LABELS = {
    met:"met target", under:"under target", excused:"leave or excused",
    open:"still clocked in", missing:"no entry", off:"day off", future:"upcoming"
  };

  // "other" is a catch-all excused absence — real usage is things like
  // marriage or bereavement leave that don't fit the named categories, always
  // logged with no clock times. It's excused in exactly the same way Sick
  // Leave is: no work target owed, and (per the person who owns this ledger)
  // no annual-leave-balance impact either — see the leave-balance calc below,
  // which only deducts for "leave"/"halfleave".
  var EXCUSED_TYPES = ["leave","sick","holiday","other"];
  // Half days expect half the normal target rather than being fully excused.
  var HALF_TYPES = ["halfleave"];
  // Day types whose hours count toward averages, totals and the overtime bank.
  // WFH, business trip and training carry no fixed target (see NO_TARGET_TYPES
  // below) and are meant to be neutral: logging 10 hours or 0 on one of these
  // days must not move the average, the bank or the target-accomplished rate
  // either way, so they're excluded here the same as leave/sick/holiday.
  var WORKED_TYPES = ["regular","halfleave"];
  function countsAsWorked(type){ return WORKED_TYPES.indexOf(type || "regular") !== -1; }

  // These are excused from a fixed daily target — a day working from home, at
  // a client site or in training doesn't carry the same 9-to-5 expectation a
  // Regular day does, and (per WORKED_TYPES above) doesn't roll into the
  // totals/bank at all, so there is nothing to fall short of or gain credit
  // for, whatever gets logged and whether or not clock times are recorded.
  var NO_TARGET_TYPES = ["wfh","trip","training"];

  var DISMISS_KEY  = "attendance_ledger_dismissed_v1";
  var SNOOZE_KEY   = "attendance_ledger_backup_snooze_v1";
  var BACKUP_KEY   = "attendance_ledger_lastbackup_v1";
  var BACKUP_REMIND_DAYS = 14;

  var DEFAULT_SETTINGS = {
    workDays:[0,1,2,3,4],
    targetMin:480,
    graceMin:10,
    lateOnlyIfShort:true,
    periods:[],
    standardIn:"08:00",
    standardOut:"16:00",
    remindAfterHours:9,
    annualLeaveDays:21
  };

  // ---------- Auth / multi-user state ----------
  var currentUser = null;      // {id, email} — the signed-in Supabase auth user
  var currentProfile = null;   // {id, email, full_name, role}
  var viewedUserId = null;     // whose data is currently loaded (self, unless admin switched)
  var viewedProfile = null;
  var allProfiles = [];        // admin only: every registered user, for the switcher + Team tab
  var isAdmin = false;
  var isOwnData = true;

  var entries = [];
  var settings = Object.assign({}, DEFAULT_SETTINGS);

  // Persisted across reloads. These were plain in-memory values, so "Dismiss" on
  // an open-shift reminder and "Later" on the backup prompt both reset on every
  // refresh — which on an installed PWA meant the banner was effectively
  // undismissable. Entries older than 30 days are pruned on load so the key
  // cannot grow without bound.
  var dismissedReminders = (function(){
    try{
      var raw = JSON.parse(safeGet(DISMISS_KEY) || "{}");
      var cutoff = dateToStr(new Date(Date.now() - 30*24*60*60*1000));
      var out = {};
      Object.keys(raw).forEach(function(d){ if(d >= cutoff) out[d] = true; });
      return out;
    }catch(err){ return {}; }
  })();
  function persistDismissals(){
    safeSet(DISMISS_KEY, JSON.stringify(dismissedReminders));
  }

  // ---------- Storage ----------
  function safeGet(key){
    try{ return localStorage.getItem(key); }catch(err){ return null; }
  }
  function safeSet(key, val){
    try{ localStorage.setItem(key, val); return true; }
    catch(err){
      document.getElementById("storageNote").textContent =
        "Auto-save isn't available in this browser. Export a JSON backup before closing the page.";
      return false;
    }
  }
  // Accepts settings from storage or an imported backup and returns a valid object.
  // Older versions stored a decimal `targetHours`; convert it to minutes.
  function normalizeSettings(raw){
    raw = raw || {};
    var out = Object.assign({}, DEFAULT_SETTINGS, raw);
    // Check `raw`, not `out` — the default targetMin would otherwise mask the migration.
    if(raw.targetMin == null && raw.targetHours != null){
      out.targetMin = Math.round(parseFloat(raw.targetHours) * 60);
    }
    delete out.targetHours;
    out.targetMin = Math.round(Number(out.targetMin));
    if(!isFinite(out.targetMin) || out.targetMin < 0 || out.targetMin > 24*60){
      out.targetMin = DEFAULT_SETTINGS.targetMin;
    }
    if(!Array.isArray(out.workDays) || !out.workDays.length){
      out.workDays = DEFAULT_SETTINGS.workDays.slice();
    }
    out.workDays = out.workDays
      .map(Number)
      .filter(function(d){ return d >= 0 && d <= 6; })
      .filter(function(d, i, a){ return a.indexOf(d) === i; })
      .sort(function(a, b){ return a - b; });
    if(!out.workDays.length) out.workDays = DEFAULT_SETTINGS.workDays.slice();
    var r = Number(out.remindAfterHours);
    out.remindAfterHours = (isFinite(r) && r > 0 && r <= 24) ? r : DEFAULT_SETTINGS.remindAfterHours;

    var g = Math.round(Number(out.graceMin));
    out.graceMin = (isFinite(g) && g >= 0 && g <= 240) ? g : DEFAULT_SETTINGS.graceMin;

    var lv = Number(out.annualLeaveDays);
    out.annualLeaveDays = (isFinite(lv) && lv >= 0 && lv <= 365) ? lv : DEFAULT_SETTINGS.annualLeaveDays;

    out.lateOnlyIfShort = out.lateOnlyIfShort !== false;

    // Seasonal periods: keep only entries with a valid, ordered date range.
    out.periods = (Array.isArray(out.periods) ? out.periods : [])
      .map(function(p){
        p = p || {};
        var tm = Math.round(Number(p.targetMin));
        return {
          id: p.id || ("p" + Math.random().toString(36).slice(2,8)),
          name: String(p.name || "").trim() || "Seasonal hours",
          start: /^\d{4}-\d{2}-\d{2}$/.test(p.start) ? p.start : "",
          end: /^\d{4}-\d{2}-\d{2}$/.test(p.end) ? p.end : "",
          targetMin: (isFinite(tm) && tm > 0 && tm <= 24*60) ? tm : out.targetMin,
          standardIn: /^\d{2}:\d{2}$/.test(p.standardIn) ? p.standardIn : out.standardIn,
          standardOut: /^\d{2}:\d{2}$/.test(p.standardOut) ? p.standardOut : out.standardOut
        };
      })
      .filter(function(p){ return p.start && p.end && p.start <= p.end; })
      .sort(function(a,b){ return a.start.localeCompare(b.start); })
      // Drop any period that overlaps one already kept. Sorted by start date, so
      // an overlap can only be with the immediately preceding survivor.
      .filter(function(p, i, arr){
        for(var j=0;j<i;j++){ if(arr[j] && arr[j].end >= p.start && arr[j].start <= p.end) return false; }
        return true;
      });

    return out;
  }

  // ---------- Row <-> app-object mapping ----------
  function rowToEntry(row){
    return {
      id: row.id,
      user_id: row.user_id,
      date: row.date,
      clockIn: row.clock_in || "",
      clockOut: row.clock_out || "",
      type: row.type || "regular",
      note: row.note || ""
    };
  }
  function entryToRow(entry, userId){
    return {
      user_id: userId,
      date: entry.date,
      clock_in: entry.clockIn || null,
      clock_out: entry.clockOut || null,
      type: entry.type || "regular",
      note: entry.note || ""
    };
  }

  // ---------- Supabase data access ----------
  async function sbFetchEntries(userId){
    var res = await supabase.from("entries").select("*").eq("user_id", userId).order("date");
    if(res.error) throw res.error;
    return (res.data || []).map(rowToEntry);
  }

  async function sbFetchSettings(userId){
    var res = await supabase.from("user_settings").select("settings").eq("user_id", userId).maybeSingle();
    if(res.error) throw res.error;
    return normalizeSettings(res.data ? res.data.settings : null);
  }

  async function sbSaveSettings(userId, settingsObj){
    var res = await supabase.from("user_settings")
      .upsert({user_id: userId, settings: settingsObj}, {onConflict:"user_id"});
    if(res.error) throw res.error;
  }

  // Saves one entry: updates by primary key if existingDbId is given,
  // otherwise inserts a new row. Returns the app-shaped saved entry.
  async function sbUpsertEntry(userId, entry, existingDbId){
    var row = entryToRow(entry, userId);
    var res;
    if(existingDbId){
      res = await supabase.from("entries").update(row).eq("id", existingDbId).select().single();
    } else {
      res = await supabase.from("entries").insert(row).select().single();
    }
    if(res.error){
      if(res.error.code === "23505"){
        throw new Error("Another entry already exists for that date.");
      }
      throw res.error;
    }
    return rowToEntry(res.data);
  }

  // Writes many entries in a single request instead of one round trip per row.
  // Import, range-apply and apply-to-everyone previously looped with `await` on
  // a single-row call: 250 rows meant 250 sequential round trips, 30–50 seconds
  // during which closing the tab or losing the connection left a half-written
  // timesheet that looked complete. Chunked so one request never gets unwieldy.
  async function sbBulkUpsertEntries(rows){
    var CHUNK = 200, saved = 0;
    for(var i=0;i<rows.length;i+=CHUNK){
      var res = await supabase.from("entries")
        .upsert(rows.slice(i, i+CHUNK), {onConflict:"user_id,date"})
        .select("id");
      if(res.error) throw res.error;
      saved += (res.data || []).length;
    }
    return saved;
  }

  async function sbDeleteEntry(dbId){
    var res = await supabase.from("entries").delete().eq("id", dbId);
    if(res.error) throw res.error;
  }

  async function sbDeleteAllEntries(userId){
    var res = await supabase.from("entries").delete().eq("user_id", userId);
    if(res.error) throw res.error;
  }

  // Loads entries + settings for whoever is currently being viewed (self,
  // or — for an admin — the person selected in the viewer switcher).
  // Shows shimmer placeholders in the hero card, the 4 compact stat cards,
  // and the log table while data is in flight, instead of letting the old
  // (possibly stale, possibly zeroed) values sit there or pop in abruptly
  // once the fetch resolves.
  function setLoadingSkeletons(on){
    var targets = [document.getElementById("formatCard"), document.getElementById("logTableWrap")]
      .concat(Array.prototype.slice.call(document.querySelectorAll("#statsRow .stat-card")));
    targets.forEach(function(el){
      if(!el) return;
      el.classList.toggle("is-loading", on);
      // Screen readers got no loading feedback at all: silence, then values.
      el.setAttribute("aria-busy", on ? "true" : "false");
    });
    var live = document.getElementById("loadingLive");
    if(live) live.textContent = on ? "Loading attendance data" : "Attendance data loaded";
  }

  async function loadDataForViewedUser(){
    setLoadingSkeletons(true);
    try{
      var results = await Promise.all([
        sbFetchEntries(viewedUserId),
        sbFetchSettings(viewedUserId)
      ]);
      entries = results[0];
      settings = results[1];
    }catch(err){
      console.error(err);
      showToast("Couldn't load attendance data: " + friendlyError(err), "error");
      entries = [];
      settings = Object.assign({}, DEFAULT_SETTINGS);
    }
    isOwnData = viewedUserId === currentUser.id;
    updateViewingBanner();
    renderAll();
    setLoadingSkeletons(false);
  }

  // ---------- Helpers ----------
  function uid(){ return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function pad2(n){ return String(n).padStart(2,"0"); }

  function timeToMinutes(t){
    if(!t) return null;
    var p = t.split(":");
    return (+p[0])*60 + (+p[1]);
  }
  // Display-only. Values stay in 24h "HH:MM" because <input type="time"> requires it.
  function formatTime12(t){
    if(!t) return "";
    var p = t.split(":");
    var h = +p[0];
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if(h12 === 0) h12 = 12;
    return h12 + ":" + p[1] + " " + period;
  }
  function minutesToHoursStr(mins){
    if(mins === null || mins === undefined || isNaN(mins)) return "—";
    var sign = mins < 0 ? "-" : "";
    var v = Math.abs(Math.round(mins));
    var h = Math.floor(v/60), m = v%60;
    return sign + h + "h" + (m ? " " + m + "m" : "");
  }
  // For values that are naturally small and minutes-only (how late, how early) —
  // "0h 31m" reads like a typo; "31m" is what it actually is. Still falls back
  // to "Xh Ym" past 60 so an unusually late day doesn't show "95m".
  function minutesOnlyStr(mins){
    if(mins === null || mins === undefined || isNaN(mins)) return "—";
    var sign = mins < 0 ? "-" : "";
    var v = Math.abs(Math.round(mins));
    if(v < 60) return sign + v + "m";
    return minutesToHoursStr(mins);
  }
  function signed(mins){
    if(mins === null || isNaN(mins)) return "—";
    return (mins >= 0 ? "+" : "") + minutesToHoursStr(mins);
  }
  function dateFromStr(s){
    var p = s.split("-");
    return new Date(+p[0], +p[1]-1, +p[2]);
  }
  function dateToStr(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
  function todayStr(){ return dateToStr(new Date()); }
  function fmtDate(s){
    return dateFromStr(s).toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"});
  }
  function fmtDateLong(s){
    return dateFromStr(s).toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric", year:"numeric"});
  }
  function isScheduled(dateStr){
    return settings.workDays.indexOf(dateFromStr(dateStr).getDay()) !== -1;
  }
  // A generic single-day fallback for charts/labels that need *some* target
  // before any entries exist to average from. Resolves today's seasonal
  // period (Ramadan, summer hours) rather than the flat org default, so it
  // doesn't quietly show 8h while a 5h period is actually in force.
  function targetMinPerDay(){ return scheduleFor(todayStr()).targetMin; }

  // Resolves the schedule in force on a given date. Seasonal periods (Ramadan,
  // summer hours) override the base schedule for the dates they cover.
  function scheduleFor(dateStr){
    var list = settings.periods || [];
    for(var i=0;i<list.length;i++){
      var p = list[i];
      if(p.start && p.end && dateStr >= p.start && dateStr <= p.end){
        return {
          targetMin: p.targetMin != null ? p.targetMin : settings.targetMin,
          standardIn: p.standardIn || settings.standardIn,
          standardOut: p.standardOut || settings.standardOut,
          name: p.name || "Seasonal hours"
        };
      }
    }
    return {
      targetMin: settings.targetMin,
      standardIn: settings.standardIn,
      standardOut: settings.standardOut,
      name: ""
    };
  }

  function scheduleSummary(){
    var days = settings.workDays.slice().sort(function(a,b){return a-b;});
    var label;
    // Show as a range when the days are contiguous, otherwise list them.
    var contiguous = days.every(function(d,i){ return i === 0 || d === days[i-1]+1; });
    if(days.length === 1) label = DAY_FULL[days[0]];
    else if(contiguous) label = DAY_NAMES[days[0]] + "–" + DAY_NAMES[days[days.length-1]];
    else label = days.map(function(d){ return DAY_NAMES[d]; }).join(", ");

    var today = scheduleFor(todayStr());
    var base = formatTime12(today.standardIn) + "–" + formatTime12(today.standardOut) +
               " · " + label + " · Target " + minutesToHoursStr(today.targetMin) + "/day";
    return today.name ? base + " · " + today.name : base;
  }

  function computeEntry(e){
    var excused = EXCUSED_TYPES.indexOf(e.type) !== -1;
    // Leave/sick/holiday plus WFH/trip/training: none of these owe a fixed
    // daily target, so there is nothing for a blank row to fall short of.
    var noTarget = excused || NO_TARGET_TYPES.indexOf(e.type) !== -1;
    var half = HALF_TYPES.indexOf(e.type) !== -1;
    var scheduled = isScheduled(e.date);
    var sched = scheduleFor(e.date);

    var targetMin = 0;
    if(scheduled && !noTarget){
      targetMin = half ? Math.round(sched.targetMin / 2) : sched.targetMin;
    }

    // Worked hours first — punctuality can depend on whether the target was met.
    var workedMin = null;
    if(e.clockIn && e.clockOut){
      var gross = timeToMinutes(e.clockOut) - timeToMinutes(e.clockIn);
      if(gross < 0) gross += 24*60; // overnight shift
      workedMin = Math.max(0, gross);
    } else if(noTarget && !e.clockIn){
      // Nothing clocked and nothing owed: zero, not a shortfall. A clock-in
      // with no clock-out yet still falls through to the open-day handling
      // below regardless of type — a running WFH/trip/training shift is an
      // open day like any other, not a free pass to look closed.
      workedMin = 0;
    }

    // Punctuality is only meaningful on a scheduled, non-excused day.
    var lateMin = 0, earlyMin = 0;
    var grace = settings.graceMin || 0;
    var countable = scheduled && !excused;

    // When "only if short" is on, making up the hours clears the flag. A day
    // that's still open can't be judged yet, so it isn't flagged either way —
    // but it must not be counted as *on time* either. `pending` marks that
    // distinction so the On Time tab can exclude the day rather than silently
    // score it clean and then flip it to late once the user clocks out.
    var metTarget = workedMin !== null && workedMin >= targetMin;
    var pending = settings.lateOnlyIfShort && workedMin === null && !!e.clockIn && countable;
    var forgiven = settings.lateOnlyIfShort && (metTarget || workedMin === null);

    if(countable && e.clockIn && !forgiven){
      var lm = timeToMinutes(e.clockIn) - timeToMinutes(sched.standardIn);
      if(lm > grace) lateMin = lm;
    }
    // A half day is meant to end early, so leaving early isn't a departure flag.
    if(countable && !half && e.clockIn && e.clockOut && !forgiven){
      var em = timeToMinutes(sched.standardOut) - timeToMinutes(e.clockOut);
      if(em > grace) earlyMin = em;
    }

    // An off-day (weekend, or any day outside the configured work days) is
    // neutral the same way an excused/no-target day is: whatever gets logged
    // — 20 hours or nothing — must not read as credit or a shortfall.
    var neutral = noTarget || !scheduled;

    if(workedMin !== null && !(noTarget && !e.clockIn)){
      return {
        workedMin:workedMin, targetMin:targetMin,
        diffMin: neutral ? 0 : workedMin - targetMin,
        excused:excused, half:half, scheduled:scheduled, open:false,
        lateMin:lateMin, earlyMin:earlyMin, sched:sched, pending:false
      };
    }
    return {
      workedMin: noTarget ? 0 : null, targetMin:targetMin,
      diffMin: noTarget ? 0 : null, excused:excused, half:half, scheduled:scheduled,
      open: !!(e.clockIn && !e.clockOut),
      lateMin:lateMin, earlyMin:0, sched:sched, pending:pending
    };
  }

  // The week starts on the first configured working day rather than always
  // Sunday. Hardcoding Sunday was right for the Sun–Thu default but split every
  // week in half for a Mon–Fri organisation, so weekly cards straddled two
  // working weeks and the "vs. last week" trend compared mismatched periods.
  function weekStartDow(){
    var days = (settings.workDays || []).slice().sort(function(a,b){ return a-b; });
    if(!days.length) return 0;
    // Contiguous runs that wrap the week boundary (e.g. Sat–Wed) should start at
    // the run's beginning, not at the lowest numeric day.
    for(var i=0;i<days.length;i++){
      var prev = days[(i - 1 + days.length) % days.length];
      if(((days[i] - prev + 7) % 7) !== 1) return days[i];
    }
    return days[0];
  }
  function weekStartDate(dateStr){
    var d = dateFromStr(dateStr);
    var offset = (d.getDay() - weekStartDow() + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }
  function weekKey(dateStr){ return dateToStr(weekStartDate(dateStr)); }
  function monthKey(dateStr){ var d = dateFromStr(dateStr); return d.getFullYear()+"-"+pad2(d.getMonth()+1); }
  function yearKey(dateStr){ return String(dateFromStr(dateStr).getFullYear()); }
  function monthLabel(key){
    var p = key.split("-");
    return new Date(+p[0], +p[1]-1, 1).toLocaleDateString(undefined,{month:"long", year:"numeric"});
  }
  function monthShortLabel(key){
    var p = key.split("-");
    return new Date(+p[0], +p[1]-1, 1).toLocaleDateString(undefined,{month:"short"}) + " '" + String(+p[0]).slice(-2);
  }
  // Strips the bidirectional-override control characters. Left in place they
  // visually reverse the rest of a line in the log table AND in the printed,
  // signed report — a spoofing vector on a document someone puts their name to,
  // not merely a rendering quirk.
  var BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g;
  function stripBidi(s){ return s == null ? "" : String(s).replace(BIDI_CONTROLS, ""); }

  function escapeHtml(s){
    var d = document.createElement("div");
    d.textContent = stripBidi(s);
    return d.innerHTML;
  }
  // textContent -> innerHTML escapes &, < and > but NOT quotes, so escapeHtml()
  // alone is unsafe for a value interpolated into an HTML attribute: a seasonal
  // period named  x" onfocus="…  broke straight out of value="…". Use this for
  // anything landing inside quotes.
  function escapeAttr(s){
    return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function cssVar(name){
    return getComputedStyle(document.body).getPropertyValue(name).trim() || "#888";
  }

  // ---------- Error presentation ----------
  // Backend errors were surfaced verbatim, so users saw strings like
  // 'new row violates row-level security policy for table "entries"'. Map the
  // ones we understand to a sentence that says what to do; fall back to the raw
  // text rather than hiding a failure we didn't anticipate.
  function friendlyError(err){
    if(!err) return "Something went wrong.";
    var code = err.code || "";
    var msg  = err.message || String(err);

    if(code === "23505" || /duplicate key/i.test(msg))
      return "There's already an entry for that date.";
    if(code === "42501" || /row-level security|permission denied|Only admin/i.test(msg))
      return "You don't have permission to do that.";
    if(code === "23514" || /violates check constraint/i.test(msg)){
      if(/clock_(in|out)/.test(msg)) return "That clock time isn't a valid time of day.";
      if(/entries_type/.test(msg))   return "That day type isn't recognised.";
      if(/entries_note/.test(msg))   return "That note is too long (500 characters maximum).";
      if(/entries_date/.test(msg))   return "That date is outside the range this app accepts.";
      return "That entry didn't pass validation.";
    }
    if(code === "23503" || /foreign key/i.test(msg))
      return "That record no longer exists — try reloading the page.";
    if(code === "PGRST301" || /JWT|token is expired/i.test(msg))
      return "Your session expired. Sign in again to continue.";
    if(/Failed to fetch|NetworkError|network/i.test(msg))
      return "Couldn't reach the server. Check your connection and try again.";
    return msg;
  }

  // ---------- Bulk-operation guard ----------
  // Multi-row writes used to be abandonable without a word: closing the tab or
  // navigating away mid-import left part of the data written and no record of
  // where it stopped. The browser now asks first.
  var bulkOpsInFlight = 0;
  function onBeforeUnload(ev){
    if(bulkOpsInFlight <= 0) return;
    ev.preventDefault();
    ev.returnValue = "";
    return "";
  }
  function beginBulkOperation(){
    if(bulkOpsInFlight === 0) window.addEventListener("beforeunload", onBeforeUnload);
    bulkOpsInFlight++;
  }
  function endBulkOperation(){
    bulkOpsInFlight = Math.max(0, bulkOpsInFlight - 1);
    if(bulkOpsInFlight === 0) window.removeEventListener("beforeunload", onBeforeUnload);
  }

  // ---------- In-app dialogs (replace native alert()/confirm()) ----------
  function dialogRoot(){
    var root = document.getElementById("dialogRoot");
    if(!root){
      root = document.createElement("div");
      root.id = "dialogRoot";
      document.body.appendChild(root);
    }
    return root;
  }

  // Marks a field invalid alongside its showToast() announcement — the toast
  // is heard, but a sighted mouse user still needs to see which field to fix,
  // and a screen-reader user tabbing back in needs aria-invalid on it.
  function markFieldInvalid(id, focus){
    var el = typeof id === "string" ? document.getElementById(id) : id;
    if(!el) return;
    el.classList.add("field-invalid");
    el.setAttribute("aria-invalid", "true");
    if(focus !== false) el.focus();
  }
  function clearFieldInvalid(id){
    var el = typeof id === "string" ? document.getElementById(id) : id;
    if(!el) return;
    el.classList.remove("field-invalid");
    el.removeAttribute("aria-invalid");
  }
  document.addEventListener("input", function(ev){
    if(ev.target.classList && ev.target.classList.contains("field-invalid")) clearFieldInvalid(ev.target);
  });

  var TOAST_ICONS = {
    error:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
    success:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
    info:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>'
  };

  // Non-blocking notification. Replaces informational/error alert() calls.
  function showToast(message, type){
    type = (type === "error" || type === "success") ? type : "info";
    var stack = document.getElementById("toastStack");
    if(!stack){
      stack = document.createElement("div");
      stack.id = "toastStack";
      stack.className = "toast-stack";
      dialogRoot().appendChild(stack);
    }
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.innerHTML =
      '<span class="toast-icon">'+TOAST_ICONS[type]+'</span>' +
      '<span class="toast-msg"></span>' +
      '<button type="button" class="toast-close" aria-label="Dismiss">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
      '</button>';
    el.querySelector(".toast-msg").textContent = message;
    stack.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add("show"); });

    var timer = setTimeout(dismiss, type === "error" ? 7000 : 4200);
    function dismiss(){
      clearTimeout(timer);
      el.classList.add("hiding");
      el.classList.remove("show");
      setTimeout(function(){ el.remove(); }, 200);
    }
    el.querySelector(".toast-close").addEventListener("click", dismiss);
  }

  // Promise-based modal. Resolves true/false. Replaces confirm().
  function showConfirm(message, opts){
    opts = opts || {};
    return new Promise(function(resolve){
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      // Without aria-labelledby/aria-describedby the dialog had no accessible
      // name at all whenever opts.title was omitted — which is most of them
      // ("Delete this entry?", "Replace it?").
      var mid = "mdl" + Math.random().toString(36).slice(2,8);
      overlay.innerHTML =
        '<div class="modal-card" role="alertdialog" aria-modal="true" ' +
             (opts.title ? 'aria-labelledby="'+mid+'-t" ' : '') + 'aria-describedby="'+mid+'-m">' +
          (opts.title ? '<h3 class="modal-title" id="'+mid+'-t">'+escapeHtml(opts.title)+'</h3>' : '') +
          '<p class="modal-msg" id="'+mid+'-m"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn ghost modal-cancel">'+escapeHtml(opts.cancelText || "Cancel")+'</button>' +
            '<button type="button" class="btn '+(opts.danger ? 'danger-solid' : '')+' modal-confirm">'+escapeHtml(opts.confirmText || "Confirm")+'</button>' +
          '</div>' +
        '</div>';
      overlay.querySelector(".modal-msg").textContent = message;
      dialogRoot().appendChild(overlay);
      requestAnimationFrame(function(){ overlay.classList.add("show"); });

      var bgRoot = document.getElementById("appShell").style.display !== "none"
        ? document.getElementById("appShell") : document.getElementById("authScreen");
      bgRoot.setAttribute("aria-hidden", "true");

      // Focus trap: Tab/Shift+Tab cycle only among elements inside the modal,
      // and focus returns to whatever triggered it once the modal closes —
      // without this, Tab can walk focus out into the page behind the overlay.
      var previouslyFocused = document.activeElement;
      var card = overlay.querySelector(".modal-card");
      function focusable(){
        return Array.from(card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          .filter(function(el){ return !el.disabled && el.offsetParent !== null; });
      }

      // A back-gesture/hardware back button had no handler here at all, so it
      // backgrounded the whole app instead of closing the dialog in front of
      // it — unlike Escape, which already closes it correctly. Pushing one
      // history entry on open lets popstate reuse that same Escape close path.
      var closed = false;
      history.pushState({ledgerModal:true}, "");
      function onPopState(){ close(false, true); }
      window.addEventListener("popstate", onPopState);

      function close(result, fromPopState){
        if(closed) return;
        closed = true;
        window.removeEventListener("popstate", onPopState);
        document.removeEventListener("keydown", onKey);
        bgRoot.removeAttribute("aria-hidden");
        overlay.classList.remove("show");
        setTimeout(function(){
          overlay.remove();
          if(previouslyFocused && typeof previouslyFocused.focus === "function"){
            previouslyFocused.focus();
          }
        }, 180);
        // The back button already consumed the pushed entry itself; closing
        // any other way (Escape, Cancel, Confirm, overlay click) still has to
        // consume it so a second back press doesn't just reopen this dialog.
        if(fromPopState){
          resolve(result);
        } else {
          // history.back() is asynchronous — its popstate fires on a later
          // task, not immediately. If we resolved right away, an awaiting
          // caller could open a second showConfirm (as CSV import does:
          // date-order prompt then an import-confirm prompt) and push a new
          // history entry before this back() actually lands. That leaves the
          // stray popstate to land on the NEW dialog instead of this one,
          // silently closing it as "cancelled" before the user ever sees it.
          // Waiting for our own popstate before resolving keeps the two in
          // sync. The fallback timer guards against back() never firing.
          var settled = false;
          function settle(){
            if(settled) return;
            settled = true;
            window.removeEventListener("popstate", onOwnBack);
            clearTimeout(fallback);
            resolve(result);
          }
          function onOwnBack(){ settle(); }
          window.addEventListener("popstate", onOwnBack);
          var fallback = setTimeout(settle, 1000);
          history.back();
        }
      }
      function onKey(ev){
        if(ev.key === "Escape"){ close(false); return; }
        if(ev.key === "Enter"){
          // Respect whichever button actually has focus — a danger dialog
          // deliberately starts focus on Cancel, and Enter must not silently
          // override that safety default by always confirming.
          close(document.activeElement !== overlay.querySelector(".modal-cancel"));
          return;
        }
        if(ev.key === "Tab"){
          var els = focusable();
          if(!els.length) return;
          var first = els[0], last = els[els.length - 1];
          if(ev.shiftKey && document.activeElement === first){
            ev.preventDefault(); last.focus();
          } else if(!ev.shiftKey && document.activeElement === last){
            ev.preventDefault(); first.focus();
          } else if(!card.contains(document.activeElement)){
            // Focus somehow ended up outside the modal (e.g. programmatic
            // focus elsewhere) — pull it back in rather than let Tab escape.
            ev.preventDefault(); first.focus();
          }
        }
      }
      overlay.querySelector(".modal-cancel").addEventListener("click", function(){ close(false); });
      overlay.querySelector(".modal-confirm").addEventListener("click", function(){ close(true); });
      overlay.addEventListener("click", function(ev){ if(ev.target === overlay) close(false); });
      document.addEventListener("keydown", onKey);
      setTimeout(function(){
        overlay.querySelector(opts.danger ? ".modal-cancel" : ".modal-confirm").focus();
      }, 40);
    });
  }

  // Rolls a list of entries into one summary object.
  function summarize(list){
    var workedSum=0, loggedDays=0, targetSum=0, diffSum=0, openDays=0;
    var incompleteDays=0, pendingDays=0;
    var shortDays=0, shortSum=0, metDays=0, missedDays=0, ratedDays=0;
    list.forEach(function(e){
      var c = computeEntry(e);
      // Every day type that represents actual work rolls up here (see
      // WORKED_TYPES). Leave, sick days and public holidays are excused and
      // contribute nothing, which is correct — they aren't shortfalls.
      //
      // The three figures below are printed side by side on the same card, so
      // they must reconcile: workedSum - targetSum === diffSum, always.
      //
      // Incomplete data — a clock-in with no clock-out (whether it's still
      // running today or was left open on a past day), or a row with no clock
      // times at all — carries no real information about what was worked, so
      // it must not move the bank either way: it's surfaced via
      // incompleteDays so it stays visible, but contributes nothing to
      // workedSum, targetSum or diffSum, the same as a day with no entry at
      // all (which never even reaches this function).
      var runningToday = c.open && e.date === todayStr();
      // An off-day (weekend, or any day outside the configured work days)
      // must not move the average, the bank or the target-accomplished rate
      // either way — logging 20 hours on a Saturday or nothing must have the
      // same effect on these totals: none.
      if(countsAsWorked(e.type) && isScheduled(e.date)){
        if(c.workedMin !== null){
          workedSum += c.workedMin;
          loggedDays++;
          targetSum += c.targetMin;
          diffSum   += (c.diffMin !== null ? c.diffMin : 0);
        } else if(!runningToday){
          incompleteDays++;
        }
      }
      if(c.open) openDays++;

      // The Shortfall tab cares about one thing: did the day reach its target
      // hours — not when the person clocked in or out. A day still running
      // right now can't be judged yet, so it's held out as pending rather
      // than scored, using the same runningToday rule as the bank above.
      // Unlike the old late-arrival check this replaced, it doesn't require a
      // clock-in either: a scheduled day nobody logged at all is the
      // clearest shortfall there is, not an invisible one.
      if(c.targetMin > 0){
        if(runningToday){
          pendingDays++;
        } else {
          ratedDays++;
          var worked = c.workedMin !== null ? c.workedMin : 0;
          var short = c.targetMin - worked;
          if(short > 0){
            shortDays++; shortSum += short;
            if(worked === 0) missedDays++; // nothing logged at all, not just short
          } else metDays++;
        }
      }
    });
    return {
      workedSum:workedSum, loggedDays:loggedDays, targetSum:targetSum,
      diffSum:diffSum, openDays:openDays, incompleteDays:incompleteDays,
      avgMin: loggedDays ? workedSum/loggedDays : 0,
      shortDays:shortDays, shortSum:shortSum, metDays:metDays, missedDays:missedDays,
      ratedDays:ratedDays, pendingDays:pendingDays,
      metRate: ratedDays ? (metDays/ratedDays)*100 : null,
      avgShortMin: shortDays ? shortSum/shortDays : 0
    };
  }
  function groupBy(list, keyFn){
    var out = {};
    list.forEach(function(e){
      var k = keyFn(e.date);
      if(!out[k]) out[k] = [];
      out[k].push(e);
    });
    return out;
  }

  // ---------- Header Admin button ----------
  // Not a tab: the tab strip is views of attendance, and this manages the
  // organisation. Employees never see the button, and renderAdmin() refuses to
  // paint for a non-admin regardless of how the panel was opened.
  document.getElementById("adminBtn").addEventListener("click", function(){
    if(!isAdmin) return;
    activateTab("admin");
    var card = document.getElementById("tabContentCard");
    if(card) card.scrollIntoView({behavior:"smooth", block:"start"});
  });

  // ---------- Settings UI ----------
  function buildDayPicker(){
    var wrap = document.getElementById("dayPicker");
    wrap.innerHTML = DAY_NAMES.map(function(name, i){
      return '<input type="checkbox" id="wd'+i+'" value="'+i+'"><label for="wd'+i+'">'+DAY_FULL[i]+'</label>';
    }).join("");
  }
  function fillSettingsForm(){
    DAY_NAMES.forEach(function(_, i){
      var box = document.getElementById("wd"+i);
      if(box) box.checked = settings.workDays.indexOf(i) !== -1;
    });
    document.getElementById("sTargetH").value = Math.floor(settings.targetMin / 60);
    document.getElementById("sTargetM").value = settings.targetMin % 60;
    document.getElementById("sIn").value = settings.standardIn;
    document.getElementById("sOut").value = settings.standardOut;
    document.getElementById("sRemind").value = settings.remindAfterHours;
    document.getElementById("sGrace").value = settings.graceMin;
    document.getElementById("sLeaveDays").value = settings.annualLeaveDays;
    document.getElementById("sLateOnlyShort").checked = settings.lateOnlyIfShort;
    renderPeriodRows(settings.periods);

    // Open sections that already have non-default content, so nothing
    // configured gets hidden behind a collapsed accordion by surprise.
    var seasonalSection = document.querySelector('.accordion-section[data-section="seasonal"]');
    if(seasonalSection) seasonalSection.classList.toggle("open", settings.periods.length > 0);
    var punctSection = document.querySelector('.accordion-section[data-section="punctuality"]');
    if(punctSection) punctSection.classList.toggle("open", !settings.lateOnlyIfShort);
  }

  // Collapsible sections. The open/closed state was conveyed by a rotated
  // chevron alone, so a screen reader had no way to know whether a heading's
  // content was showing — which matters more now the Admin console is eight of
  // these stacked.
  document.querySelectorAll(".accordion-head").forEach(function(head, i){
    var section = head.closest(".accordion-section");
    var body = section.querySelector(".accordion-body");
    if(body){
      if(!body.id) body.id = "acc-body-" + (section.getAttribute("data-section") || i);
      head.setAttribute("aria-controls", body.id);
    }
    head.setAttribute("aria-expanded", section.classList.contains("open") ? "true" : "false");
    head.addEventListener("click", function(){
      var open = section.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  // The period editor works on the DOM rows directly; nothing is committed to
  // settings until Save is pressed, so Close always discards edits.
  function periodRowHtml(p){
    return '<div class="period-row" data-period>' +
      '<div><label>Name</label><input type="text" data-p="name" value="'+escapeAttr(p.name)+'" placeholder="Ramadan"></div>' +
      '<div><label>From</label><input type="date" data-p="start" value="'+escapeAttr(p.start)+'"></div>' +
      '<div><label>To</label><input type="date" data-p="end" value="'+escapeAttr(p.end)+'"></div>' +
      '<div><label>Hours</label><input type="number" data-p="th" min="0" max="24" step="1" value="'+Math.floor(p.targetMin/60)+'"></div>' +
      '<div><label>Mins</label><input type="number" data-p="tm" min="0" max="59" step="1" value="'+(p.targetMin%60)+'"></div>' +
      '<div><label>Start / End</label>' +
        '<div class="period-time-row">' +
          '<input type="time" data-p="in" value="'+escapeAttr(p.standardIn)+'">' +
          '<input type="time" data-p="out" value="'+escapeAttr(p.standardOut)+'">' +
        '</div>' +
      '</div>' +
      '<button type="button" class="period-del" data-remove-period>Remove</button>' +
    '</div>';
  }

  function renderPeriodRows(list, containerId){
    var wrap = document.getElementById(containerId || "periodsList");
    if(!list.length){
      wrap.innerHTML = '<p class="periods-empty">No seasonal hours set. Standard hours apply all year.</p>';
      return;
    }
    wrap.innerHTML = list.map(periodRowHtml).join("");
  }

  function readPeriodRows(containerId){
    var out = [];
    document.querySelectorAll("#"+(containerId || "periodsList")+" [data-period]").forEach(function(row){
      function val(k){
        var el = row.querySelector('[data-p="'+k+'"]');
        return el ? el.value : "";
      }
      var th = parseInt(val("th"), 10); if(isNaN(th)) th = 0;
      var tm = parseInt(val("tm"), 10); if(isNaN(tm)) tm = 0;
      out.push({
        name: val("name"),
        start: val("start"),
        end: val("end"),
        targetMin: th*60 + tm,
        standardIn: val("in"),
        standardOut: val("out")
      });
    });
    return out;
  }

  // Shared between personal Schedule Settings and Admin > Organisation
  // Defaults — both edit a list of seasonal periods and must reject the same
  // mistakes before saving rather than let normalizeSettings() silently drop
  // a bad row later. Returns an error string, or null when everything's valid.
  function validatePeriods(rawPeriods){
    for(var i=0;i<rawPeriods.length;i++){
      var p = rawPeriods[i], where = "Seasonal period " + (i+1) + (p.name ? ' ("'+p.name+'")' : "");
      if(!p.start || !p.end) return where + " needs both a start and end date.";
      if(p.start > p.end) return where + " ends before it starts.";
      if(p.targetMin <= 0) return where + " needs a daily target greater than zero.";
      if(p.targetMin > 24*60) return where + " has a target over 24 hours.";
      for(var j=0;j<i;j++){
        var q = rawPeriods[j];
        if(p.start <= q.end && q.start <= p.end) return where + " overlaps another period. Date ranges can't overlap.";
      }
    }
    return null;
  }

  // Expected Ramadan windows (Umm al-Qura). The actual start depends on the
  // moon sighting and can shift a day, so these are a starting point to edit.
  var RAMADAN_DATES = [
    {year:2027, start:"2027-02-08", end:"2027-03-08"},
    {year:2028, start:"2028-01-28", end:"2028-02-25"},
    {year:2029, start:"2029-01-16", end:"2029-02-14"},
    {year:2030, start:"2030-01-06", end:"2030-02-03"},
    {year:2031, start:"2030-12-26", end:"2031-01-24"}
  ];

  document.getElementById("addRamadanBtn").addEventListener("click", function(){
    var current = readPeriodRows();
    var today = todayStr();

    // Next Ramadan that hasn't ended and isn't already in the list.
    var next = RAMADAN_DATES.find(function(r){
      if(r.end < today) return false;
      return !current.some(function(p){ return p.start === r.start; });
    });
    if(!next){
      showToast("Ramadan is already set up for the years available. Use \"+ Add Period\" to add another range manually.", "info");
      return;
    }

    // Saudi labour law caps Ramadan at 6 hours a day for Muslim employees.
    var ramadanMin = 360;
    var startMin = timeToMinutes(settings.standardIn);
    var endMin = (startMin + ramadanMin) % (24*60);

    current.push({
      name: "Ramadan " + next.year,
      start: next.start,
      end: next.end,
      targetMin: ramadanMin,
      standardIn: settings.standardIn,
      standardOut: pad2(Math.floor(endMin/60)) + ":" + pad2(endMin%60)
    });
    renderPeriodRows(current);

    var rows = document.querySelectorAll("#periodsList [data-period]");
    if(rows.length) rows[rows.length-1].scrollIntoView({behavior:"smooth", block:"nearest"});
  });

  document.getElementById("addPeriodBtn").addEventListener("click", function(){
    var wrap = document.getElementById("periodsList");
    var current = readPeriodRows();
    var year = new Date().getFullYear();
    current.push({
      name:"", start:year+"-01-01", end:year+"-01-31",
      targetMin: Math.round(settings.targetMin * 0.75),
      standardIn: settings.standardIn, standardOut: settings.standardOut
    });
    renderPeriodRows(current);
    var rows = wrap.querySelectorAll("[data-period]");
    if(rows.length) rows[rows.length-1].querySelector('[data-p="name"]').focus();
  });

  document.getElementById("periodsList").addEventListener("click", function(ev){
    var btn = ev.target.closest("[data-remove-period]");
    if(!btn) return;
    var row = btn.closest("[data-period]");
    var rows = Array.prototype.slice.call(document.querySelectorAll("#periodsList [data-period]"));
    var idx = rows.indexOf(row);
    var current = readPeriodRows();
    if(idx !== -1) current.splice(idx, 1);
    renderPeriodRows(current);
  });

  // Admin > Organisation Defaults' own seasonal-periods editor — same
  // component, same validation, wired to the defaults form's own fields
  // instead of the viewer's personal `settings` (this edits what a brand new
  // account starts with, not anyone's live schedule).
  function currentDefaultsSchedule(){
    var th = parseInt(document.getElementById("dTargetH").value, 10);
    var tm = parseInt(document.getElementById("dTargetM").value, 10);
    return {
      targetMin: (isNaN(th)?8:th)*60 + (isNaN(tm)?0:tm),
      standardIn: document.getElementById("dIn").value || DEFAULT_SETTINGS.standardIn,
      standardOut: document.getElementById("dOut").value || DEFAULT_SETTINGS.standardOut
    };
  }

  document.getElementById("addDefaultsRamadanBtn").addEventListener("click", function(){
    var current = readPeriodRows("defaultsPeriodsList");
    var today = todayStr();
    var next = RAMADAN_DATES.find(function(r){
      if(r.end < today) return false;
      return !current.some(function(p){ return p.start === r.start; });
    });
    if(!next){
      showToast("Ramadan is already set up for the years available. Use \"+ Add Period\" to add another range manually.", "info");
      return;
    }
    var base = currentDefaultsSchedule();
    var ramadanMin = 360; // Saudi labour law caps Ramadan at 6 hours a day.
    var startMin = timeToMinutes(base.standardIn);
    var endMin = (startMin + ramadanMin) % (24*60);
    current.push({
      name: "Ramadan " + next.year,
      start: next.start,
      end: next.end,
      targetMin: ramadanMin,
      standardIn: base.standardIn,
      standardOut: pad2(Math.floor(endMin/60)) + ":" + pad2(endMin%60)
    });
    renderPeriodRows(current, "defaultsPeriodsList");
    var rows = document.querySelectorAll("#defaultsPeriodsList [data-period]");
    if(rows.length) rows[rows.length-1].scrollIntoView({behavior:"smooth", block:"nearest"});
  });

  document.getElementById("addDefaultsPeriodBtn").addEventListener("click", function(){
    var wrap = document.getElementById("defaultsPeriodsList");
    var current = readPeriodRows("defaultsPeriodsList");
    var base = currentDefaultsSchedule();
    var year = new Date().getFullYear();
    current.push({
      name:"", start:year+"-01-01", end:year+"-01-31",
      targetMin: Math.round(base.targetMin * 0.75),
      standardIn: base.standardIn, standardOut: base.standardOut
    });
    renderPeriodRows(current, "defaultsPeriodsList");
    var rows = wrap.querySelectorAll("[data-period]");
    if(rows.length) rows[rows.length-1].querySelector('[data-p="name"]').focus();
  });

  document.getElementById("defaultsPeriodsList").addEventListener("click", function(ev){
    var btn = ev.target.closest("[data-remove-period]");
    if(!btn) return;
    var row = btn.closest("[data-period]");
    var rows = Array.prototype.slice.call(document.querySelectorAll("#defaultsPeriodsList [data-period]"));
    var idx = rows.indexOf(row);
    var current = readPeriodRows("defaultsPeriodsList");
    if(idx !== -1) current.splice(idx, 1);
    renderPeriodRows(current, "defaultsPeriodsList");
  });
  document.getElementById("settingsBtn").addEventListener("click", function(){
    var card = document.getElementById("settingsCard");
    var opening = !card.classList.contains("open");
    card.classList.toggle("open", opening);
    if(opening){
      document.getElementById("settingsForLabel").textContent = isOwnData
        ? "Editing your own schedule."
        : "Editing the schedule for " + (viewedProfile ? (viewedProfile.full_name || viewedProfile.email) : "this user") + ".";
      // "Apply to everyone" is an admin-only bulk action.
      var applyAllRow = document.getElementById("sApplyAll").closest(".check-row");
      if(applyAllRow) applyAllRow.style.display = isAdmin ? "" : "none";
      document.getElementById("sApplyAll").checked = false;
      fillSettingsForm();
      card.scrollIntoView({behavior:"smooth", block:"nearest"});
    }
    updateStickyClockVisibility();
  });
  document.getElementById("closeSettingsBtn").addEventListener("click", function(){
    document.getElementById("settingsCard").classList.remove("open");
    updateStickyClockVisibility();
  });
  document.getElementById("saveSettingsBtn").addEventListener("click", async function(){
    // You may always edit your own schedule; editing someone else's requires
    // admin. The database enforces the same rule, so this is a courtesy check
    // that produces a clear message rather than a raw RLS rejection.
    if(!isAdmin && !isOwnData){
      showToast("You can only change your own schedule settings.", "error");
      return;
    }
    var days = [];
    DAY_NAMES.forEach(function(_, i){
      var box = document.getElementById("wd"+i);
      if(box && box.checked) days.push(i);
    });
    if(!days.length){ showToast("Pick at least one working day.", "error"); return; }

    var th = parseInt(document.getElementById("sTargetH").value, 10);
    var tm = parseInt(document.getElementById("sTargetM").value, 10);
    if(isNaN(th)) th = 0;
    if(isNaN(tm)) tm = 0;
    if(th < 0 || tm < 0 || tm > 59){
      showToast("Minutes must be between 0 and 59.", "error");
      markFieldInvalid(th < 0 ? "sTargetH" : "sTargetM");
      return;
    }
    var targetMin = th*60 + tm;
    if(targetMin <= 0){ showToast("Set a daily target greater than zero.", "error"); return; }
    if(targetMin > 24*60){ showToast("A daily target can't exceed 24 hours.", "error"); return; }

    var remind = parseFloat(document.getElementById("sRemind").value);
    if(isNaN(remind) || remind <= 0 || remind > 24) remind = DEFAULT_SETTINGS.remindAfterHours;

    var grace = parseInt(document.getElementById("sGrace").value, 10);
    if(isNaN(grace) || grace < 0 || grace > 240) grace = DEFAULT_SETTINGS.graceMin;

    var leaveDays = parseFloat(document.getElementById("sLeaveDays").value);
    if(isNaN(leaveDays) || leaveDays < 0 || leaveDays > 365){
      showToast("Annual leave days must be between 0 and 365.", "error");
      markFieldInvalid("sLeaveDays");
      return;
    }

    // Validate the seasonal rows before saving so mistakes surface immediately.
    var rawPeriods = readPeriodRows();
    var periodsErr = validatePeriods(rawPeriods);
    if(periodsErr){ showToast(periodsErr, "error"); return; }

    var updated = Object.assign({}, settings, {
      workDays: days,
      targetMin: targetMin,
      standardIn: document.getElementById("sIn").value || DEFAULT_SETTINGS.standardIn,
      standardOut: document.getElementById("sOut").value || DEFAULT_SETTINGS.standardOut,
      remindAfterHours: remind,
      graceMin: grace,
      annualLeaveDays: leaveDays,
      lateOnlyIfShort: document.getElementById("sLateOnlyShort").checked,
      periods: rawPeriods
    });
    updated = normalizeSettings(updated);

    var applyAll = document.getElementById("sApplyAll").checked;
    var btn = this;

    if(applyAll){
      if(!allProfiles.length){ showToast("No team members to apply this to yet.", "error"); return; }
      var confirmed = await showConfirm(
        "This will overwrite the schedule settings for all " + allProfiles.length +
        " team member" + (allProfiles.length===1?"":"s") + " with what's currently in this form.",
        {title:"Apply to everyone?", confirmText:"Apply to " + allProfiles.length}
      );
      if(!confirmed) return;

      btn.disabled = true;
      var done = 0, failed = 0;
      for(var k=0;k<allProfiles.length;k++){
        try{
          await sbSaveSettings(allProfiles[k].id, updated);
          done++;
        }catch(err){ failed++; }
        btn.textContent = "Applying " + (k+1) + " of " + allProfiles.length + "…";
      }
      btn.disabled = false;
      btn.textContent = "Save Settings";

      if(allProfiles.some(function(p){ return p.id === viewedUserId; })) settings = updated;
      document.getElementById("settingsCard").classList.remove("open");
      updateStickyClockVisibility();
      renderAll();
      showToast(
        "Applied to " + done + " of " + allProfiles.length + " team members." + (failed ? " " + failed + " failed." : ""),
        failed === 0 ? "success" : "error"
      );
      return;
    }

    btn.disabled = true; btn.textContent = "Saving…";
    try{
      await sbSaveSettings(viewedUserId, updated);
      settings = updated;
      document.getElementById("settingsCard").classList.remove("open");
      updateStickyClockVisibility();
      renderAll();
    }catch(err){
      showToast("Couldn't save settings: " + friendlyError(err), "error");
    }finally{
      btn.disabled = false; btn.textContent = "Save Settings";
    }
  });

  // ---------- Filters ----------
  function getMonthFilter(){ return document.getElementById("monthFilterSelect").value; }
  function getYearFilter(){ return document.getElementById("yearFilterSelect").value; }
  function getLogYearFilter(){ return document.getElementById("logYearSelect").value; }
  function getMonthlyYearFilter(){ return document.getElementById("monthlyYearSelect").value; }

  function populateFilters(){
    var todayYear = String(new Date().getFullYear());
    var todayMonthKey = monthKey(todayStr());

    // The current year/month are always offered as options, even with zero
    // entries yet, so filters can default to "now" instead of "All".
    var allYearKeys = Object.keys(groupBy(entries, yearKey));
    if(allYearKeys.indexOf(todayYear) === -1) allYearKeys.push(todayYear);
    allYearKeys.sort().reverse();

    // Log/Weekly: Year narrows which months are offered, same pattern as Punctuality.
    var lySel = document.getElementById("logYearSelect");
    var lyPrev = lySel.value;
    lySel.innerHTML = '<option value="all">All Years</option>' +
      allYearKeys.map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join("");
    lySel.value = lyPrev && (lyPrev === "all" || allYearKeys.indexOf(lyPrev) !== -1) ? lyPrev : todayYear;

    var mSel = document.getElementById("monthFilterSelect");
    var mPrev = mSel.value;
    var logYear = lySel.value;
    var mKeys = Object.keys(groupBy(entries, monthKey))
      .filter(function(k){ return logYear === "all" || k.indexOf(logYear + "-") === 0; });
    if((logYear === "all" || logYear === todayYear) && mKeys.indexOf(todayMonthKey) === -1){
      mKeys.push(todayMonthKey);
    }
    mKeys.sort().reverse();
    mSel.innerHTML = '<option value="all">All Months</option>' +
      mKeys.map(function(k){
        var label = logYear === "all" ? monthLabel(k)
          : new Date(+k.split("-")[0], +k.split("-")[1]-1, 1).toLocaleDateString(undefined,{month:"long"});
        return '<option value="'+k+'">'+label+'</option>';
      }).join("");
    var logDefaultMonth = (logYear === "all" || logYear === todayYear) && mKeys.indexOf(todayMonthKey) !== -1
      ? todayMonthKey : "all";
    // "all" is a real selection, not an absent one. mKeys only ever holds
    // "YYYY-MM" keys, so treating it as unmatched snapped the filter back to
    // the current month after every save, import and delete — and made the
    // Clear button undo half its own work.
    mSel.value = (mPrev === "all" || (mPrev && mKeys.indexOf(mPrev) !== -1)) ? mPrev : logDefaultMonth;

    // Monthly tab: just a Year filter, since the whole point of the tab is the trend across months.
    var mySel = document.getElementById("monthlyYearSelect");
    var myPrev = mySel.value;
    mySel.innerHTML = '<option value="all">All Years</option>' +
      allYearKeys.map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join("");
    mySel.value = myPrev && (myPrev === "all" || allYearKeys.indexOf(myPrev) !== -1) ? myPrev : todayYear;

    var ySel = document.getElementById("yearFilterSelect");
    var yPrev = ySel.value;
    var yKeys = allYearKeys.slice();
    ySel.innerHTML = yKeys.map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join("");
    ySel.value = yKeys.indexOf(yPrev) !== -1 ? yPrev : (yKeys.indexOf(todayYear) !== -1 ? todayYear : yKeys[0]);

    // Every day type is always offered, even ones not used yet — otherwise
    // there's no way to filter for a type until at least one exists.
    var tSel = document.getElementById("typeFilterSelect");
    var tPrev = tSel.value;
    var tKeys = Object.keys(TYPE_LABELS);
    tSel.innerHTML = '<option value="all">All Types</option>' +
      tKeys.map(function(k){ return '<option value="'+k+'">'+TYPE_LABELS[k]+'</option>'; }).join("");
    tSel.value = (tPrev === "all" || tKeys.indexOf(tPrev) !== -1) ? tPrev : "all";

    populatePunctFilters();
  }

  // Punctuality has its own year + month pair; months are scoped to the year.
  // Also defaults to the current year/month rather than "All".
  function populatePunctFilters(){
    var todayYear = String(new Date().getFullYear());
    var todayMonthKey = monthKey(todayStr());

    var ySel = document.getElementById("punctYearSelect");
    var mSel = document.getElementById("punctMonthSelect");
    var yPrev = ySel.value, mPrev = mSel.value;

    var yKeys = Object.keys(groupBy(entries, yearKey));
    if(yKeys.indexOf(todayYear) === -1) yKeys.push(todayYear);
    yKeys.sort().reverse();
    ySel.innerHTML = '<option value="all">All Years</option>' +
      yKeys.map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join("");
    ySel.value = yPrev && (yPrev === "all" || yKeys.indexOf(yPrev) !== -1) ? yPrev : todayYear;

    var year = ySel.value;
    var mKeys = Object.keys(groupBy(entries, monthKey))
      .filter(function(k){ return year === "all" || k.indexOf(year + "-") === 0; });
    if((year === "all" || year === todayYear) && mKeys.indexOf(todayMonthKey) === -1){
      mKeys.push(todayMonthKey);
    }
    mKeys.sort().reverse();
    mSel.innerHTML = '<option value="all">All Months</option>' +
      mKeys.map(function(k){
        var label = year === "all" ? monthLabel(k)
          : new Date(+k.split("-")[0], +k.split("-")[1]-1, 1).toLocaleDateString(undefined,{month:"long"});
        return '<option value="'+k+'">'+label+'</option>';
      }).join("");
    var punctDefaultMonth = (year === "all" || year === todayYear) && mKeys.indexOf(todayMonthKey) !== -1
      ? todayMonthKey : "all";
    mSel.value = (mPrev === "all" || (mPrev && mKeys.indexOf(mPrev) !== -1)) ? mPrev : punctDefaultMonth;
  }

  function punctEntries(){
    var year = document.getElementById("punctYearSelect").value;
    var month = document.getElementById("punctMonthSelect").value;
    return entries.filter(function(e){
      if(month !== "all") return monthKey(e.date) === month;
      if(year !== "all") return yearKey(e.date) === year;
      return true;
    });
  }
  function punctScopeLabel(){
    var year = document.getElementById("punctYearSelect").value;
    var month = document.getElementById("punctMonthSelect").value;
    if(month !== "all") return monthLabel(month);
    if(year !== "all") return year;
    return "all time";
  }

  // Year + Month filter — used by the log table and the weekly view.
  // Month wins when set; otherwise Year narrows the range on its own.
  function filteredEntries(){
    var yf = getLogYearFilter();
    var mf = getMonthFilter();
    if(mf !== "all") return entries.filter(function(e){ return monthKey(e.date) === mf; });
    if(yf !== "all") return entries.filter(function(e){ return yearKey(e.date) === yf; });
    return entries.slice();
  }

  function getSearchFilters(){
    return {
      text: (document.getElementById("searchInput").value || "").trim().toLowerCase(),
      type: document.getElementById("typeFilterSelect").value,
      from: document.getElementById("fromDate").value,
      to: document.getElementById("toDate").value
    };
  }
  // Compares against the DEFAULT selection, not against "all". The year filter
  // defaults to the current year, so the old test was true on a completely
  // untouched view and the log permanently read "Showing 18 of 340" — implying
  // the user had narrowed something they had never touched.
  function anyFilterActive(){
    var f = getSearchFilters();
    var todayYear = String(new Date().getFullYear());
    var yearNarrowed  = getLogYearFilter() !== "all" && getLogYearFilter() !== todayYear;
    var monthNarrowed = getMonthFilter() !== "all" && getMonthFilter() !== monthKey(todayStr());
    return !!(f.text || f.from || f.to || f.type !== "all" || yearNarrowed || monthNarrowed);
  }

  // Month filter plus the search bar — used by the log table.
  function searchedEntries(){
    var f = getSearchFilters();
    return filteredEntries().filter(function(e){
      if(f.type !== "all" && (e.type || "regular") !== f.type) return false;
      if(f.from && e.date < f.from) return false;
      if(f.to && e.date > f.to) return false;
      if(f.text){
        var hay = ((e.note || "") + " " + typeLabel(e.type)).toLowerCase();
        if(hay.indexOf(f.text) === -1) return false;
      }
      return true;
    });
  }

  // ---------- Chart ----------
  // data: [{label, value (minutes), targetMin, hasEntry, excused}]
  function renderBarChart(container, data, opts){
    if(!container) return;
    opts = opts || {};
    var h = opts.height || 150;
    if(!data.length){ container.innerHTML = '<div class="empty-state">Nothing to chart yet.</div>'; return; }

    var w = Math.max(container.clientWidth || 0, 260);
    var padL = 10, padR = 10, padTop = 22;
    var slot = (w - padL - padR) / data.length;
    var barW = Math.max(6, Math.min(34, slot * 0.52));

    // Scale label text with the available slot rather than dropping labels.
    // "8h 30m" runs longer than a plain decimal, so this scales a notch
    // smaller than the axis-label font at the same slot width to keep it fitting.
    var valueFont = slot >= 46 ? 10.5 : (slot >= 36 ? 9.5 : (slot >= 28 ? 8.5 : (slot >= 20 ? 7 : 6)));
    var axisFont  = slot >= 42 ? 10   : (slot >= 32 ? 9.5 : (slot >= 24 ? 8.5 : (slot >= 18 ? 7.5 : 6.5)));

    // Rotate axis labels when the widest one wouldn't fit its slot horizontally.
    var longest = data.reduce(function(m, d){ return Math.max(m, String(d.label).length); }, 0);
    var estWidth = longest * axisFont * 0.55;
    var rotate = estWidth > slot - 2;
    var padBottom = rotate ? Math.min(estWidth * 0.72, 46) + 8 : 22;

    // Fallback only — for a bucket without its own d.targetMin (e.g. seasonal
    // periods weren't averaged in for it). Each bar's real reference is drawn
    // as its own segment below, not this one flat number for the whole chart.
    var targetMin = opts.targetMin != null ? opts.targetMin : targetMinPerDay();
    var maxVal = Math.max(targetMin, 1);
    data.forEach(function(d){
      if(d.value) maxVal = Math.max(maxVal, d.value);
      if(d.targetMin) maxVal = Math.max(maxVal, d.targetMin);
    });
    maxVal = maxVal * 1.12;
    var scale = (h - padTop - padBottom) / maxVal;

    var cPos = cssVar("--positive"), cUnder = cssVar("--negative"),
        cLine = cssVar("--line"),
        // The target reference line is meaningful graphics, not decoration, so
        // it takes the dark step of the accent: --gold is lime and measures
        // 1.35:1 on a white card, which WCAG 1.4.11 (3:1) fails and the eye
        // simply loses. --gold-deep is the same hue family at 5.89:1.
        cGold = cssVar("--gold-deep");

    function valueText(mins){
      // Same "8h 2m" style used everywhere else on the page, so a chart label
      // and its matching stat-card figure always read identically. Charts that
      // plot something other than worked hours (e.g. minutes late) can pass
      // their own opts.formatter instead.
      return (opts.formatter || minutesToHoursStr)(mins);
    }

    // An accessible name plus a spoken summary of the series. role="img" with
    // no name was announced as an unlabelled "image", making every chart opaque.
    var chartName = opts.name || "Bar chart";
    var described = data.map(function(d){ return d.label + " " + valueText(d.value || 0); }).join(", ");
    var titleId = "cht" + Math.random().toString(36).slice(2,8);
    var svg = '<svg class="chart-wrap" viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" ' +
      'role="img" aria-labelledby="'+titleId+'">' +
      '<title id="'+titleId+'">'+escapeHtml(chartName)+'</title>' +
      '<desc>'+escapeHtml(described)+'</desc>';
    // A step, not one flat line: each bar's own target (a seasonal period can
    // put a 5h day right next to an 8h one) gets its own dashed segment,
    // instead of implying a single constant target across the whole chart.
    data.forEach(function(d, i){
      var t = d.targetMin != null ? d.targetMin : targetMin;
      if(t > 0){
        var segL = padL + slot*i, segR = padL + slot*(i+1);
        var ty = h - padBottom - t*scale;
        svg += '<line x1="'+segL.toFixed(1)+'" y1="'+ty.toFixed(1)+'" x2="'+segR.toFixed(1)+'" y2="'+ty.toFixed(1)+'" stroke="'+cGold+'" stroke-width="1.2" stroke-dasharray="4 3"/>';
      }
    });
    data.forEach(function(d, i){
      var cx = padL + slot*i + slot/2;
      var val = d.value || 0;
      var barH = Math.max(val*scale, val > 0 ? 2 : 1);
      var y = h - padBottom - barH;
      var color = !d.hasEntry ? cLine : (val >= (d.targetMin != null ? d.targetMin : targetMin) ? cPos : cUnder);
      // Capped stagger: a 30-bar yearly chart shouldn't take a full second to
      // finish appearing, so the delay ramp stops growing past ~10 bars.
      var delay = Math.min(i, 10) * 28;
      var delayStyle = "animation-delay:" + delay + "ms;";

      svg += '<rect x="'+(cx-barW/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+barH.toFixed(1)+'" fill="'+color+'" rx="2" class="bar-rect" style="'+delayStyle+'">'+
             '<title>'+escapeHtml(d.label)+': '+valueText(val)+'</title></rect>';

      // Value label: above the bar, or tucked inside when the bar reaches the top.
      if(val > 0){
        var above = y - 5 >= padTop;
        var ty2 = above ? y - 5 : y + valueFont + 3;
        var fill = above ? "" : ' fill="#fff"';
        svg += '<text x="'+cx.toFixed(1)+'" y="'+ty2.toFixed(1)+'" text-anchor="middle" class="bar-value" '+
               'style="font-size:'+valueFont+'px;'+delayStyle+'"'+fill+'>'+valueText(val)+'</text>';
      } else {
        svg += '<text x="'+cx.toFixed(1)+'" y="'+(h-padBottom-6)+'" text-anchor="middle" class="bar-value bar-empty" '+
               'style="font-size:'+valueFont+'px;'+delayStyle+'">–</text>';
      }

      if(rotate){
        var lx = cx.toFixed(1), ly = (h - padBottom + 12).toFixed(1);
        svg += '<text x="'+lx+'" y="'+ly+'" text-anchor="end" class="bar-label" '+
               'transform="rotate(-45 '+lx+' '+ly+')" style="font-size:'+axisFont+'px;'+delayStyle+'">'+escapeHtml(d.label)+'</text>';
      } else {
        svg += '<text x="'+cx.toFixed(1)+'" y="'+(h-7)+'" text-anchor="middle" class="bar-label" '+
               'style="font-size:'+axisFont+'px;'+delayStyle+'">'+escapeHtml(d.label)+'</text>';
      }
    });
    svg += '</svg>';
    container.innerHTML = svg;
  }

  // A gently-smoothed line through a series of points: each segment is a cubic
  // Bezier whose control points sit at the segment's horizontal midpoint, at
  // the same height as their own endpoint. That keeps the curve monotonic
  // between points (no vertical overshoot) without the complexity of a real
  // spline — plenty smooth for a handful of weekly/monthly values.
  function smoothPathD(pts){
    if(!pts.length) return "";
    var d = "M" + pts[0].x.toFixed(1) + "," + pts[0].y.toFixed(1);
    for(var i=0;i<pts.length-1;i++){
      var p0 = pts[i], p1 = pts[i+1];
      var dx = (p1.x - p0.x) / 2;
      d += " C" + (p0.x+dx).toFixed(1) + "," + p0.y.toFixed(1) + " " +
                   (p1.x-dx).toFixed(1) + "," + p1.y.toFixed(1) + " " +
                   p1.x.toFixed(1) + "," + p1.y.toFixed(1);
    }
    return d;
  }

  // ---------- Trend chart ----------
  // A line/area chart for anything read as a trajectory over many points
  // (hours per day, by week/month) rather than a handful of categories to
  // compare — a bar repeated 12-30 times reads as noise, where a line reads
  // as a shape. Categorical comparisons (Year over Year) still use
  // renderBarChart above. data: [{label, value (minutes), targetMin,
  // hasEntry, met}]. `met` (value >= that point's target) colors the point's
  // dot; set hasEntry:false for a gap the line breaks around instead of
  // drawing through, so a future or unlogged period never looks like a real
  // zero. opts.accent overrides the line/area color (default --teal-600) —
  // the Shortfall tab's chart passes --negative, since every point there is
  // already a bad-news number and green dots would say the opposite.
  function renderTrendChart(container, data, opts){
    if(!container) return;
    opts = opts || {};
    var h = opts.height || 150;
    if(!data.length){ container.innerHTML = '<div class="empty-state">Nothing to chart yet.</div>'; return; }

    var w = Math.max(container.clientWidth || 0, 260);
    var padL = 12, padR = 12, padTop = 22;
    var slot = (w - padL - padR) / Math.max(data.length - 1, 1);

    var axisFont  = slot >= 42 ? 10 : (slot >= 32 ? 9.5 : (slot >= 24 ? 8.5 : (slot >= 18 ? 7.5 : 6.5)));
    var valueFont = slot >= 46 ? 10.5 : (slot >= 36 ? 9.5 : (slot >= 28 ? 8.5 : (slot >= 20 ? 7 : 6)));
    // A single point has no slot to derive spacing from, so the line/dot
    // still needs somewhere to sit — center it.
    if(data.length === 1) slot = w - padL - padR;

    var longest = data.reduce(function(m, d){ return Math.max(m, String(d.label).length); }, 0);
    var estWidth = longest * axisFont * 0.55;
    var rotate = data.length > 1 && estWidth > slot - 2;
    var padBottom = rotate ? Math.min(estWidth * 0.72, 46) + 8 : 22;

    // Fallback only — for a point without its own d.targetMin. Each point's
    // real reference is drawn as its own segment below, not this one flat
    // number for the whole chart.
    var targetMin = opts.targetMin != null ? opts.targetMin : targetMinPerDay();
    var maxVal = Math.max(targetMin, 1);
    data.forEach(function(d){
      if(d.value) maxVal = Math.max(maxVal, d.value);
      if(d.targetMin) maxVal = Math.max(maxVal, d.targetMin);
    });
    maxVal = maxVal * 1.15;
    var scale = (h - padTop - padBottom) / maxVal;
    function yOf(val){ return h - padBottom - Math.max(val, 0) * scale; }
    function xOf(i){ return data.length === 1 ? padL + slot/2 : padL + slot*i; }

    var cPos = cssVar("--positive"), cUnder = cssVar("--negative"),
        cLine = cssVar("--line"),
        cGold = cssVar("--gold-deep"), // see the note in renderBarChart
        cAccent = opts.accent || cssVar("--teal-600");

    function valueText(mins){ return (opts.formatter || minutesToHoursStr)(mins); }

    var chartName = opts.name || "Trend chart";
    var described = data.map(function(d){ return d.label + " " + (d.hasEntry === false ? "no data" : valueText(d.value || 0)); }).join(", ");
    var titleId = "cht" + Math.random().toString(36).slice(2,8);
    var gradId  = "chg" + Math.random().toString(36).slice(2,8);

    var svg = '<svg class="chart-wrap trend-chart" viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" ' +
      'role="img" aria-labelledby="'+titleId+'">' +
      '<title id="'+titleId+'">'+escapeHtml(chartName)+'</title>' +
      '<desc>'+escapeHtml(described)+'</desc>' +
      '<defs><linearGradient id="'+gradId+'" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="'+cAccent+'" stop-opacity=".22"/>' +
        '<stop offset="100%" stop-color="'+cAccent+'" stop-opacity="0"/>' +
      '</linearGradient></defs>';

    // A step, not one flat line: each point's own target (a seasonal period
    // can put a 5h week/month right next to an 8h one) gets its own dashed
    // segment, spanning the midpoints to its neighbors, instead of implying a
    // single constant target across the whole chart.
    data.forEach(function(d, i){
      var t = d.targetMin != null ? d.targetMin : targetMin;
      if(t > 0){
        var segL = i === 0 ? padL : (xOf(i-1) + xOf(i)) / 2;
        var segR = i === data.length-1 ? (w - padR) : (xOf(i) + xOf(i+1)) / 2;
        var ty = yOf(t);
        svg += '<line x1="'+segL.toFixed(1)+'" y1="'+ty.toFixed(1)+'" x2="'+segR.toFixed(1)+'" y2="'+ty.toFixed(1)+'" stroke="'+cGold+'" stroke-width="1.2" stroke-dasharray="4 3"/>';
      }
    });

    // Break the line/area into runs of consecutive hasEntry points, so a gap
    // (a future month, a week nobody logged) opens the line rather than
    // dipping to a misleading zero.
    var runs = [], current = [];
    data.forEach(function(d, i){
      if(d.hasEntry === false){ if(current.length){ runs.push(current); current = []; } return; }
      current.push({x: xOf(i), y: yOf(d.value || 0)});
    });
    if(current.length) runs.push(current);

    runs.forEach(function(pts){
      if(pts.length > 1){
        var areaD = smoothPathD(pts) +
          " L" + pts[pts.length-1].x.toFixed(1) + "," + (h-padBottom).toFixed(1) +
          " L" + pts[0].x.toFixed(1) + "," + (h-padBottom).toFixed(1) + " Z";
        svg += '<path d="'+areaD+'" fill="url(#'+gradId+')" class="trend-area"/>';
        svg += '<path d="'+smoothPathD(pts)+'" fill="none" stroke="'+cAccent+'" stroke-width="2.25" ' +
               'pathLength="1" stroke-linecap="round" stroke-linejoin="round" class="trend-line"/>';
      } else if(pts.length === 1 && data.length === 1){
        // One point, nothing to connect: still show the accent as a short
        // baseline tick so the chart doesn't read as broken.
        svg += '<line x1="'+padL+'" y1="'+pts[0].y.toFixed(1)+'" x2="'+(w-padR)+'" y2="'+pts[0].y.toFixed(1)+'" ' +
               'stroke="'+cAccent+'" stroke-width="1.5" stroke-dasharray="1 5" stroke-linecap="round" opacity=".5"/>';
      }
    });

    data.forEach(function(d, i){
      var cx = xOf(i), val = d.value || 0;
      var delay = Math.min(i, 10) * 32;
      var delayStyle = "animation-delay:" + delay + "ms;";
      var hasEntry = d.hasEntry !== false;
      var met = d.met != null ? d.met : (val >= (d.targetMin != null ? d.targetMin : targetMin));
      // A label centered on the first or last point overhangs the SVG's own
      // edge by half its width and gets clipped. Anchoring it to grow inward
      // instead — start at the first point, end at the last — keeps every
      // label fully inside the viewBox without needing extra side padding.
      var edgeAnchor = i === 0 ? "start" : (i === data.length-1 ? "end" : "middle");

      if(hasEntry){
        var cy = yOf(val);
        var dotColor = met ? cPos : cUnder;
        svg += '<circle cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="4" fill="'+dotColor+'" stroke="var(--card)" stroke-width="1.5" class="trend-dot" style="'+delayStyle+'">'+
               '<title>'+escapeHtml(d.label)+': '+valueText(val)+'</title></circle>';
        var above = cy - 8 >= padTop;
        var ty2 = above ? cy - 8 : cy + valueFont + 8;
        svg += '<text x="'+cx.toFixed(1)+'" y="'+ty2.toFixed(1)+'" text-anchor="'+edgeAnchor+'" class="bar-value" '+
               'style="font-size:'+valueFont+'px;'+delayStyle+'">'+valueText(val)+'</text>';
      } else {
        svg += '<circle cx="'+cx.toFixed(1)+'" cy="'+(h-padBottom).toFixed(1)+'" r="3" fill="none" stroke="'+cLine+'" stroke-width="1.5" class="trend-dot" style="'+delayStyle+'">'+
               '<title>'+escapeHtml(d.label)+': no data</title></circle>';
      }

      if(rotate){
        var lx = cx.toFixed(1), ly = (h - padBottom + 12).toFixed(1);
        svg += '<text x="'+lx+'" y="'+ly+'" text-anchor="end" class="bar-label" '+
               'transform="rotate(-45 '+lx+' '+ly+')" style="font-size:'+axisFont+'px;'+delayStyle+'">'+escapeHtml(d.label)+'</text>';
      } else {
        svg += '<text x="'+cx.toFixed(1)+'" y="'+(h-7)+'" text-anchor="'+edgeAnchor+'" class="bar-label" '+
               'style="font-size:'+axisFont+'px;'+delayStyle+'">'+escapeHtml(d.label)+'</text>';
      }
    });

    svg += '</svg>';
    container.innerHTML = svg;
  }

  // A tiny inline sparkline for one week's seven days — small bars rather
  // than a line, since a handful of discrete days reads better as bars at
  // this size than as a wobble too thin to follow. Deliberately minimal: no
  // axis, no value labels, just shape and status color, with the real
  // numbers carried in the accessible name for anyone who can't see it.
  function renderSparkline(container, days, opts){
    if(!container) return;
    opts = opts || {};
    var w = opts.width || 76, h = opts.height || 28;
    if(!days.length){ container.innerHTML = ""; return; }

    var padX = 2, padTop = 2, padBottom = 2;
    var slot = (w - padX*2) / days.length;
    var barW = Math.max(3, Math.min(12, slot * 0.6));
    var maxVal = Math.max.apply(null, days.map(function(d){ return d.value || 0; }).concat([1]));
    var scale = (h - padTop - padBottom) / (maxVal * 1.1);

    var cPos = cssVar("--positive"), cUnder = cssVar("--negative"), cLine = cssVar("--line");
    var titleId = "spk" + Math.random().toString(36).slice(2,8);
    var described = days.map(function(d){ return d.label + " " + (d.hasEntry ? minutesToHoursStr(d.value||0) : "no entry"); }).join(", ");

    var svg = '<svg class="chart-wrap sparkline" viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" ' +
      'role="img" aria-labelledby="'+titleId+'"><title id="'+titleId+'">'+escapeHtml(opts.name || "Days worked")+'</title>' +
      '<desc>'+escapeHtml(described)+'</desc>';
    days.forEach(function(d, i){
      var cx = padX + slot*i + slot/2;
      var val = d.value || 0;
      var barH = d.hasEntry ? Math.max(val*scale, val > 0 ? 1.5 : 1) : 1;
      var y = h - padBottom - barH;
      var color = !d.hasEntry ? cLine : (d.met ? cPos : cUnder);
      svg += '<rect x="'+(cx-barW/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+barH.toFixed(1)+'" fill="'+color+'" rx="1" class="spark-rect">'+
             '<title>'+escapeHtml(d.label)+': '+(d.hasEntry ? minutesToHoursStr(val) : "no entry")+'</title></rect>';
    });
    svg += '</svg>';
    container.innerHTML = svg;
  }

  // ---------- Stats ----------
  // Renders a neutral up/down/flat trend indicator into a stat card.
  // current/previous are in minutes; pass null when there's no prior period to compare.
  function renderTrend(elId, current, previous, label, isSigned){
    var el = document.getElementById(elId);
    if(!el) return;
    if(current === null || previous === null){
      el.innerHTML = "";
      el.className = "stat-trend";
      return;
    }
    var diff = Math.round(current - previous);
    if(Math.abs(diff) < 1){
      el.className = "stat-trend trend-flat";
      el.innerHTML = "Same as " + label;
      return;
    }
    var up = diff > 0;
    el.className = "stat-trend " + (up ? "trend-up" : "trend-down");
    var arrowPath = up ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M5 12l7 7 7-7";
    var amount = isSigned ? signed(diff) : minutesToHoursStr(Math.abs(diff));
    el.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="'+arrowPath+'"/></svg>' +
      amount + ' vs. ' + label;
  }

  function renderStats(){
    var today = todayStr();
    var mk = monthKey(today);

    var ms = summarize(entries.filter(function(e){ return monthKey(e.date) === mk; }));

    document.getElementById("monthAvg").textContent = ms.loggedDays ? minutesToHoursStr(ms.avgMin) : "0h";
    document.getElementById("monthAvgDetail").textContent =
      ms.loggedDays + " workday" + (ms.loggedDays===1?"":"s") + " logged this month" +
      (ms.incompleteDays ? " · " + ms.incompleteDays + " incomplete" : "");

    document.getElementById("heroMonthLabel").textContent = new Date().toLocaleDateString(undefined, {month:"long", year:"numeric"});
    // A flat single-day target would misrepresent a month that mixes, say,
    // Ramadan's 5h days with regular 8h ones — averaging the logged days'
    // own targets (ms.targetSum) keeps this in step with the Diff/bank figure,
    // which is summed the same way.
    var targetPerDay = ms.loggedDays ? (ms.targetSum / ms.loggedDays) : (targetMinPerDay() || 1);
    // Floored, not rounded — see the note by pMetRate: 99.6% rounding up to
    // "100%" would claim the target was fully met when it's still short.
    var progressPct = ms.loggedDays ? Math.max(0, Math.min(100, Math.floor((ms.avgMin / targetPerDay) * 100))) : 0;
    var progressFill = document.getElementById("heroProgressFill");
    progressFill.style.transform = "scaleX(" + (progressPct / 100) + ")";
    // Unclamped ratio for the Velocity cluster's tachometer, published here
    // so the gauge reads the figure this function already computed rather
    // than deriving its own. The bar above stays clamped to 100%; the gauge
    // deliberately wants the overshoot, because its redline band is exactly
    // the over-target zone.
    progressFill.setAttribute("data-ratio",
      ms.loggedDays ? (ms.avgMin / targetPerDay).toFixed(4) : "0");
    // Published for the Velocity cluster's target readout to mirror, so it
    // can't drift onto its own flat-constant computation of the same figure.
    progressFill.setAttribute("data-target-min", targetPerDay);
    document.getElementById("heroProgressLabel").textContent = ms.loggedDays
      ? progressPct + "% of " + minutesToHoursStr(targetPerDay) + " target"
      : "No regular workdays logged yet this month";

    var otEl = document.getElementById("otBank");
    otEl.textContent = signed(ms.diffSum);
    otEl.className = "stat-value " + (ms.diffSum > 0 ? "positive" : (ms.diffSum < 0 ? "negative" : ""));
    document.getElementById("otBankDetail").textContent =
      new Date().toLocaleDateString(undefined, {month:"long"}) + " vs. target";

    // Trend vs. the previous month — purely informational, no "good/bad"
    // judgement attached, since more hours isn't inherently positive.
    var thisMonthDate = dateFromStr(today);
    var prevMonthDate = new Date(thisMonthDate.getFullYear(), thisMonthDate.getMonth()-1, 1);
    var pms = summarize(entries.filter(function(e){ return monthKey(e.date) === monthKey(dateToStr(prevMonthDate)); }));
    renderTrend("monthTrend", ms.loggedDays ? ms.avgMin : null, pms.loggedDays ? pms.avgMin : null, "last month");
    renderTrend("otBankTrend", ms.loggedDays ? ms.diffSum : null, pms.loggedDays ? pms.diffSum : null, "last month", true);

    // Streak: consecutive scheduled workdays with worked time logged.
    //
    // Any scheduled day without worked minutes breaks the streak, including
    // leave, sick and holiday days — this counts actual days worked in a row,
    // not "days not disqualified." A vacation is a real break in the streak.
    //
    // Today is deliberately skipped while it is still in progress. Starting the
    // scan at today meant that every working morning — before the first punch,
    // and all day while clocked in but not yet out — the scan hit a day with no
    // usable hours and broke immediately, so a 40-day streak displayed as 0
    // precisely when the user opened the app to start work.
    var streak = 0, cursor = new Date(), scanned = 0;
    var todayRec = entries.find(function(e){ return e.date === todayStr(); });
    var todayComplete = !!(todayRec && computeEntry(todayRec).workedMin > 0);
    if(!todayComplete) cursor.setDate(cursor.getDate()-1);
    while(scanned < 400){
      scanned++;
      var dStr = dateToStr(cursor);
      if(settings.workDays.indexOf(cursor.getDay()) !== -1){
        var rec = entries.find(function(e){ return e.date === dStr; });
        if(!rec) break;
        var c = computeEntry(rec);
        if(c.workedMin && c.workedMin > 0) streak++;
        else break;
      }
      cursor.setDate(cursor.getDate()-1);
    }
    document.getElementById("streak").textContent = streak;
    // Marks a genuine milestone the day the streak reaches it — never
    // permanent, since tomorrow it's just one more day and the exact match
    // stops firing on its own. Kept to the ledger's own quiet register: no
    // exclamation marks, no badge, nothing that reads as a second ornament
    // alongside the seal (see DESIGN.md's one-ornament rule).
    var STREAK_MILESTONES = {
      7: "a full week unbroken", 14: "two weeks unbroken", 30: "a month unbroken",
      50: "fifty days unbroken", 100: "a hundred days unbroken",
      200: "two hundred days unbroken", 365: "a full year unbroken"
    };
    var streakDetailEl = document.querySelector("#streak + .stat-detail");
    var streakBase = todayComplete || !isScheduled(todayStr())
      ? "Consecutive workdays logged"
      : "Consecutive workdays · clock out today to extend it";
    var milestone = STREAK_MILESTONES[streak];
    streakDetailEl.textContent = milestone ? streakBase + " — " + milestone : streakBase;
    streakDetailEl.classList.toggle("milestone", !!milestone);

    var todayEntry = entries.find(function(e){ return e.date === today; });
    var seal = document.getElementById("todaySeal");
    var sealValue = document.getElementById("sealValue");
    seal.className = "seal";
    var sealText;
    if(todayEntry){
      var tc = computeEntry(todayEntry);
      if(tc.excused){ sealText = typeLabel(todayEntry.type); }
      else if(tc.workedMin !== null){
        sealText = minutesToHoursStr(tc.workedMin);
        seal.classList.add(tc.diffMin >= 0 ? "status-over" : "status-under");
      }
      else if(tc.open){ sealText = "Clocked in"; }
      else { sealText = "Not logged"; }
    } else {
      sealText = isScheduled(today) ? "Not logged" : "Day off";
    }
    sealValue.textContent = sealText;
    // Short figures like "8h" get the big number treatment; longer status
    // words shrink so they never wrap inside the small circle.
    sealValue.classList.toggle("long", sealText.length > 6);

    renderBnClock(todayEntry);

    renderLeaveBalance();
  }

  // Annual Leave Days is a per-year entitlement. "Used" counts Annual Leave
  // entries as a full day and Half Day Leave as half a day, within the
  // current calendar year for whoever's data is currently loaded.
  function renderLeaveBalance(){
    var year = new Date().getFullYear();
    var used = 0;
    entries.forEach(function(e){
      if(yearKey(e.date) !== String(year)) return;
      // Only scheduled workdays consume entitlement. "Apply to Everyone" writes
      // every calendar day in its range, so a Sun–Sat leave block used to bill
      // 7 days against a 5-day working week — quietly costing the employee two
      // days of statutory leave per range.
      if(!isScheduled(e.date)) return;
      if(e.type === "leave") used += 1;
      else if(e.type === "halfleave") used += 0.5;
    });
    var entitlement = settings.annualLeaveDays;
    var remaining = entitlement - used;

    function fmtDays(n){
      var rounded = Math.round(n * 2) / 2; // nearest half-day
      return (rounded % 1 === 0) ? String(rounded) : rounded.toFixed(1);
    }

    var el = document.getElementById("leaveBalance");
    if(remaining < 0){
      el.textContent = "Over by " + fmtDays(Math.abs(remaining)) + "d";
      el.className = "stat-value negative";
    } else {
      el.textContent = fmtDays(remaining) + "d";
      el.className = "stat-value";
    }
    document.getElementById("leaveBalanceDetail").textContent =
      fmtDays(used) + " of " + fmtDays(entitlement) + " days used in " + year + " · working days only";
  }

  // ---------- Reminder ----------
  function renderReminder(){
    var banner = document.getElementById("reminderBanner");
    var today = todayStr();
    var now = new Date();
    var nowMin = now.getHours()*60 + now.getMinutes();

    // Oldest unclosed day first, so nothing gets buried.
    var open = entries
      .filter(function(e){ return e.clockIn && !e.clockOut && EXCUSED_TYPES.indexOf(e.type) === -1; })
      .sort(function(a,b){ return a.date.localeCompare(b.date); });

    var target = null, isPast = false;
    for(var i=0;i<open.length;i++){
      var e = open[i];
      if(e.date < today){ target = e; isPast = true; break; }
      if(e.date === today){
        var elapsed = nowMin - timeToMinutes(e.clockIn);
        if(elapsed >= settings.remindAfterHours*60){ target = e; isPast = false; break; }
      }
    }

    if(!target || dismissedReminders[target.date]){
      banner.classList.remove("show");
      return;
    }

    var elapsedMin = isPast ? null : (nowMin - timeToMinutes(target.clockIn));
    document.getElementById("reminderTitle").textContent =
      isPast ? "You never clocked out on " + fmtDate(target.date) : "Still clocked in";
    document.getElementById("reminderText").textContent =
      isPast
        ? "Clocked in at " + formatTime12(target.clockIn) + " with no clock-out. That day won't count toward your averages until you add one."
        : "You clocked in at " + formatTime12(target.clockIn) + " — that's " + minutesToHoursStr(elapsedMin) + " ago.";

    var actions = document.getElementById("reminderActions");
    actions.innerHTML = "";

    if(!isPast){
      var outBtn = document.createElement("button");
      outBtn.className = "btn small";
      outBtn.textContent = "Clock Out Now";
      outBtn.addEventListener("click", function(){ punchClock("out"); });
      actions.appendChild(outBtn);
    }

    var fixBtn = document.createElement("button");
    fixBtn.className = "btn ghost small";
    fixBtn.textContent = isPast ? "Add Clock-Out Time" : "Edit Entry";
    fixBtn.addEventListener("click", function(){ loadEntryIntoForm(target.id); });
    actions.appendChild(fixBtn);

    var dismissBtn = document.createElement("button");
    dismissBtn.className = "btn ghost small";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", function(){
      dismissedReminders[target.date] = true;
      persistDismissals();
      renderReminder();
    });
    actions.appendChild(dismissBtn);

    banner.classList.add("show");
  }

  // ---------- Log ----------
  function pillFor(c){
    if(c.open) return '<span class="pill open">Open</span>';
    if(c.excused) return '<span class="pill excused">Excused</span>';
    if(c.diffMin === null) return "—";
    if(Math.abs(c.diffMin) < 1) return '<span class="pill onit">On target</span>';
    return c.diffMin > 0
      ? '<span class="pill over">'+signed(c.diffMin)+'</span>'
      : '<span class="pill under">'+minutesToHoursStr(c.diffMin)+'</span>';
  }

  // The log rendered every matching row as DOM. With the default current-month
  // filter that's ~22 rows, but "All Years" on a long history built thousands of
  // rows in a single synchronous loop and froze the tab. Render a page at a time.
  var LOG_PAGE_SIZE = 200;
  var logVisibleCount = LOG_PAGE_SIZE;

  function renderLog(){
    var body = document.getElementById("logBody");
    var allRows = searchedEntries().sort(function(a,b){ return b.date.localeCompare(a.date); });
    var rows = allRows.slice(0, logVisibleCount);
    body.innerHTML = "";

    var empty = document.getElementById("logEmpty");
    if(entries.length === 0){
      empty.innerHTML =
        '<div class="first-run-empty">' +
          '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3.2 2"/></svg>' +
          '<p class="first-run-title">No attendance logged yet</p>' +
          '<p class="first-run-sub">Tap <strong>Clock In Now</strong> above to log today, or add a day by hand using the form.</p>' +
        '</div>';
    } else {
      empty.textContent = "No days match these filters.";
    }
    empty.style.display = allRows.length ? "none" : "block";

    var countEl = document.getElementById("filterCount");
    countEl.textContent = anyFilterActive()
      ? "Showing " + allRows.length + " of " + entries.length
      : (entries.length ? entries.length + " day" + (entries.length===1?"":"s") + " logged" : "");

    rows.forEach(function(e){
      var c = computeEntry(e);
      // Flag arrivals and departures that fall outside the grace period.
      var inCell = e.clockIn
        ? (c.lateMin > 0
            ? "<span class='late-cell' title='"+minutesToHoursStr(c.lateMin)+" late'>"+formatTime12(e.clockIn)+"</span>"
            : formatTime12(e.clockIn))
        : "—";
      var outCell = e.clockOut
        ? (c.earlyMin > 0
            ? "<span class='late-cell' title='Left "+minutesToHoursStr(c.earlyMin)+" early'>"+formatTime12(e.clockOut)+"</span>"
            : formatTime12(e.clockOut))
        : "—";
      var tr = document.createElement("tr");
      var rowStatus = c.open ? "open" : c.excused ? "excused"
        : (c.diffMin === null ? "" : (Math.abs(c.diffMin) < 1 ? "onit" : (c.diffMin > 0 ? "over" : "under")));
      if(rowStatus) tr.className = "row-" + rowStatus;
      var selectCell = selectModeActive
        ? "<td class='select-col' data-label=''><input type='checkbox' class='row-select' data-id='"+e.id+"'"+(selectedEntryIds.has(e.id)?" checked":"")+"></td>"
        : "";
      tr.innerHTML =
        selectCell +
        "<td data-label='Date'><span class=\"cell-label\">Date</span>"+fmtDate(e.date)+"</td>"+
        "<td data-label='Day'><span class=\"cell-label\">Day</span>"+DAY_NAMES[dateFromStr(e.date).getDay()]+"</td>"+
        "<td data-label='In'><span class=\"cell-label\">In</span>"+inCell+"</td>"+
        "<td data-label='Out'><span class=\"cell-label\">Out</span>"+outCell+"</td>"+
        "<td class='num' data-label='Worked'><span class=\"cell-label\">Worked</span>"+minutesToHoursStr(c.workedMin)+"</td>"+
        "<td class='num' data-label='Target'><span class=\"cell-label\">Target</span>"+(c.targetMin ? minutesToHoursStr(c.targetMin) : "—")+"</td>"+
        "<td class='num' data-label='Status'><span class=\"cell-label\">Status</span>"+pillFor(c)+"</td>"+
        "<td data-label='Type'><span class=\"cell-label\">Type</span>"+escapeHtml(typeLabel(e.type))+"</td>"+
        "<td class='note-cell' dir='auto' data-label='Note'><span class=\"cell-label\">Note</span>"+escapeHtml(e.note)+"</td>"+
        // Each row repeats "Edit"/"Delete"; without the date in the accessible
        // name a screen-reader user hears the same two words over and over with
        // no way to tell which day they are about to delete.
        "<td class='row-actions'>"+
          "<button type='button' data-edit='"+e.id+"' aria-label='Edit entry for "+escapeAttr(fmtDate(e.date))+"'>Edit</button>"+
          "<button type='button' data-del='"+e.id+"' aria-label='Delete entry for "+escapeAttr(fmtDate(e.date))+"'>Delete</button>"+
        "</td>";
      body.appendChild(tr);
    });

    // Paging control. Uses a real table row so it sits inside the table and
    // survives the mobile card layout.
    var remaining = allRows.length - rows.length;
    if(remaining > 0){
      var moreRow = document.createElement("tr");
      moreRow.className = "log-more-row";
      var cell = document.createElement("td");
      cell.colSpan = 12;
      var moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "btn ghost small";
      moreBtn.textContent = "Show " + Math.min(remaining, LOG_PAGE_SIZE) + " more (" + remaining + " remaining)";
      moreBtn.addEventListener("click", function(){
        logVisibleCount += LOG_PAGE_SIZE;
        renderLog();
      });
      cell.appendChild(moreBtn);
      moreRow.appendChild(cell);
      body.appendChild(moreRow);
    }
  }

  // ---------- Weekly ----------
  // One overview trend chart (avg hours/day, by week) plus a dense table —
  // the same two-piece shape Monthly and Yearly already use. Used to be a
  // full-height bar chart repeated once per week, which meant a handful of
  // bars and a lot of empty chart padding, over and over, down the page.
  // Each week keeps its own day-by-day shape as an inline sparkline instead.
  function renderWeekly(){
    var groups = groupBy(filteredEntries(), weekKey);
    // Only weeks with at least one Regular-type day are shown — a week that's
    // entirely WFH/leave/trip/etc. has nothing feeding the average, so a row
    // full of "0h" figures would just be confusing rather than informative.
    var keys = Object.keys(groups).sort()
      .filter(function(k){ return summarize(groups[k]).loggedDays > 0; });

    var empty = document.getElementById("weeklyEmpty");
    empty.textContent = (getMonthFilter() === "all" && getLogYearFilter() === "all")
      ? "No entries yet." : "No regular workdays logged for this period.";
    empty.style.display = keys.length ? "none" : "block";

    var weeks = keys.map(function(k){
      var s = summarize(groups[k]);
      var ws = dateFromStr(k), we = new Date(ws); we.setDate(we.getDate()+6);
      var byDate = {};
      groups[k].forEach(function(e){ byDate[e.date] = computeEntry(e); });

      // Working days only. An off-day still appears if it was worked, so
      // overtime on a weekend never silently disappears from the sparkline.
      var days = [];
      for(var i=0;i<7;i++){
        var d = new Date(ws); d.setDate(d.getDate()+i);
        var dStr = dateToStr(d);
        var c = byDate[dStr];
        var isWorkDay = settings.workDays.indexOf(d.getDay()) !== -1;
        if(!isWorkDay && !(c && c.workedMin)) continue;
        var val = c ? (c.workedMin || 0) : 0;
        // Reuse the entry's own computed target when there is one — it already
        // accounts for the seasonal period and half-day rules in force on that
        // exact date, which a flat per-day constant can't. Only fall back to
        // resolving the schedule directly for a scheduled day with no entry.
        var dayTarget = c ? c.targetMin : (isWorkDay ? scheduleFor(dStr).targetMin : 0);
        days.push({
          label: DAY_NAMES[d.getDay()],
          value: val, hasEntry: !!c,
          met: dayTarget ? val >= dayTarget : true
        });
      }

      return {
        key: k, s: s, days: days,
        range: ws.toLocaleDateString(undefined,{month:"short", day:"numeric"}) + " – " +
               we.toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"})
      };
    });

    document.getElementById("weeklyChartMeta").textContent =
      weeks.length ? weeks.length + " week" + (weeks.length===1?"":"s") + " tracked" : "";

    renderTrendChart(document.getElementById("weeklyChart"), weeks.map(function(wk){
      // Each week's own average target, not a flat constant — a week that
      // mixes 5h seasonal days with regular 8h ones would otherwise be judged
      // "under" or "over" against the wrong number.
      return {
        label:"Wk of "+wk.range.split(" – ")[0], value:wk.s.avgMin, hasEntry:wk.s.loggedDays > 0,
        targetMin: wk.s.loggedDays ? (wk.s.targetSum / wk.s.loggedDays) : null
      };
    }), {name:"Average hours per day, by week"});

    var body = document.getElementById("weeklyBody");
    body.innerHTML = "";
    weeks.slice().reverse().forEach(function(wk){
      var s = wk.s;
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td data-label='Week'><span class=\"cell-label\">Week</span>Week of "+wk.range+"</td>"+
        "<td class='num' data-label='Days'><span class=\"cell-label\">Days</span>"+s.loggedDays+
          (s.incompleteDays ? " <span class='muted-inline'>("+s.incompleteDays+" incomplete)</span>" : "")+"</td>"+
        "<td class='num' data-label='Total'><span class=\"cell-label\">Total</span>"+minutesToHoursStr(s.workedSum)+"</td>"+
        "<td class='num' data-label='Avg / Day'><span class=\"cell-label\">Avg / Day</span>"+(s.loggedDays?minutesToHoursStr(s.avgMin):"—")+"</td>"+
        "<td class='num' data-label='Diff' style='color:"+(s.diffSum>0?cssVar("--positive"):s.diffSum<0?cssVar("--negative"):"inherit")+"'><span class=\"cell-label\">Diff</span>"+signed(s.diffSum)+"</td>"+
        "<td data-label='Days worked'><span class=\"cell-label\">Days worked</span><span class='spark-holder'></span></td>";
      body.appendChild(tr);
      renderSparkline(tr.querySelector(".spark-holder"), wk.days, {name:"Hours worked each day, week of "+wk.range});
    });
  }

  // ---------- Monthly ----------
  function monthStats(list){
    var groups = groupBy(list, monthKey);
    // Only months with at least one Regular-type day are included — a month
    // that's entirely non-regular has no average to show.
    return Object.keys(groups).sort()
      .map(function(k){
        var s = summarize(groups[k]);
        s.key = k; s.label = monthLabel(k); s.shortLabel = monthShortLabel(k);
        return s;
      })
      .filter(function(s){ return s.loggedDays > 0; });
  }

  function renderMonthly(){
    var yf = getMonthlyYearFilter();
    var scope = yf === "all" ? entries : entries.filter(function(e){ return yearKey(e.date) === yf; });
    var stats = monthStats(scope);

    var monthlyEmptyEl = document.getElementById("monthlyEmpty");
    monthlyEmptyEl.textContent = scope.length
      ? "No regular workdays logged for this period."
      : "No entries yet.";
    monthlyEmptyEl.style.display = stats.length ? "none" : "block";
    document.getElementById("monthlyChartMeta").textContent =
      stats.length ? stats.length + " month" + (stats.length===1?"":"s") + " tracked" : "";
    document.getElementById("monthlyCount").textContent =
      yf === "all" ? "" : "Showing " + yf + " only";

    renderTrendChart(document.getElementById("monthlyChart"), stats.map(function(m){
      return {
        label:m.shortLabel, value:m.avgMin, hasEntry:m.loggedDays > 0,
        targetMin: m.loggedDays ? (m.targetSum / m.loggedDays) : null
      };
    }), {name:"Average hours per day, by month"});

    var body = document.getElementById("monthlyBody");
    body.innerHTML = "";
    stats.slice().reverse().forEach(function(m){
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td data-label='Month'><span class=\"cell-label\">Month</span>"+m.label+"</td>"+
        "<td class='num' data-label='Days'><span class=\"cell-label\">Days</span>"+m.loggedDays+"</td>"+
        "<td class='num' data-label='Total'><span class=\"cell-label\">Total</span>"+minutesToHoursStr(m.workedSum)+"</td>"+
        "<td class='num' data-label='Avg / Day'><span class=\"cell-label\">Avg / Day</span>"+(m.loggedDays?minutesToHoursStr(m.avgMin):"—")+"</td>"+
        "<td class='num' data-label='Target'><span class=\"cell-label\">Target</span>"+minutesToHoursStr(m.targetSum)+"</td>"+
        "<td class='num' data-label='Diff' style='color:"+(m.diffSum>0?cssVar("--positive"):m.diffSum<0?cssVar("--negative"):"inherit")+"'><span class=\"cell-label\">Diff</span>"+signed(m.diffSum)+"</td>";
      body.appendChild(tr);
    });
  }

  // ---------- Yearly ----------
  function yearStats(){
    var groups = groupBy(entries, yearKey);
    // Only years with at least one Regular-type day feed the year-over-year
    // comparison — a year with none has no average to compare.
    return Object.keys(groups).sort()
      .map(function(k){
        var s = summarize(groups[k]);
        s.key = k;
        return s;
      })
      .filter(function(s){ return s.loggedDays > 0; });
  }

  function renderYearly(){
    var stats = yearStats();
    var yearlyEmptyEl = document.getElementById("yearlyEmpty");
    yearlyEmptyEl.textContent = entries.length ? "No regular workdays logged yet." : "No entries yet.";
    yearlyEmptyEl.style.display = stats.length ? "none" : "block";

    var yr = getYearFilter();
    var yearEntries = entries.filter(function(e){ return yearKey(e.date) === yr; });
    var ys = summarize(yearEntries);

    document.getElementById("yearTitle").textContent = yr;
    document.getElementById("yearMeta").textContent =
      ys.loggedDays + " workday" + (ys.loggedDays===1?"":"s") + " logged" +
      (ys.openDays ? " · " + ys.openDays + " open" : "");

    document.getElementById("yearFigures").innerHTML =
      '<div class="period-figure"><div class="label">Total Hours</div><div class="value">'+minutesToHoursStr(ys.workedSum)+'</div></div>'+
      '<div class="period-figure"><div class="label">Avg / Day</div><div class="value">'+(ys.loggedDays?minutesToHoursStr(ys.avgMin):"—")+'</div></div>'+
      '<div class="period-figure"><div class="label">Target</div><div class="value">'+minutesToHoursStr(ys.targetSum)+'</div></div>'+
      '<div class="period-figure"><div class="label">Overtime / Under</div><div class="value" style="color:'+
        (ys.diffSum>0?cssVar("--positive"):ys.diffSum<0?cssVar("--negative"):"inherit")+'">'+signed(ys.diffSum)+'</div></div>';

    // Full 12 months so gaps in the year stay visible.
    var byMonth = groupBy(yearEntries, monthKey);
    var monthData = [];
    for(var m=0;m<12;m++){
      var k = yr+"-"+pad2(m+1);
      var s = byMonth[k] ? summarize(byMonth[k]) : null;
      monthData.push({
        label: new Date(+yr, m, 1).toLocaleDateString(undefined,{month:"short"}),
        value: s ? s.avgMin : 0,
        hasEntry: !!(s && s.loggedDays),
        targetMin: (s && s.loggedDays) ? (s.targetSum / s.loggedDays) : null
      });
    }
    renderTrendChart(document.getElementById("yearChart"), monthData, {height:160, name:"Average hours per day in "+yr+", by month"});

    // A single year has nothing to compare against — a lone bar reads as a
    // broken chart, not a comparison — so the whole card sits out until
    // there's a second year to set it against.
    var yoyCard = document.getElementById("yoyCard");
    yoyCard.style.display = stats.length > 1 ? "" : "none";
    if(stats.length > 1){
      renderBarChart(document.getElementById("yoyChart"), stats.map(function(y){
        return {
          label:y.key, value:y.avgMin, hasEntry:y.loggedDays > 0,
          targetMin: y.loggedDays ? (y.targetSum / y.loggedDays) : null
        };
      }), {height:140, name:"Average hours per day, year over year"});
    }

    var body = document.getElementById("yearlyBody");
    body.innerHTML = "";
    stats.slice().reverse().forEach(function(y, idx, arr){
      var prev = arr[idx+1]; // next in reversed list = previous year
      var delta = (prev && prev.loggedDays && y.loggedDays) ? (y.avgMin - prev.avgMin) : null;
      var deltaCell = delta === null
        ? "—"
        : "<span style='color:"+(delta>0?cssVar("--positive"):delta<0?cssVar("--negative"):"inherit")+"'>"+signed(delta)+" / day</span>";
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td data-label='Year'><span class=\"cell-label\">Year</span>"+y.key+"</td>"+
        "<td class='num' data-label='Days'><span class=\"cell-label\">Days</span>"+y.loggedDays+"</td>"+
        "<td class='num' data-label='Total'><span class=\"cell-label\">Total</span>"+minutesToHoursStr(y.workedSum)+"</td>"+
        "<td class='num' data-label='Avg / Day'><span class=\"cell-label\">Avg / Day</span>"+(y.loggedDays?minutesToHoursStr(y.avgMin):"—")+"</td>"+
        "<td class='num' data-label='Target'><span class=\"cell-label\">Target</span>"+minutesToHoursStr(y.targetSum)+"</td>"+
        "<td class='num' data-label='Diff' style='color:"+(y.diffSum>0?cssVar("--positive"):y.diffSum<0?cssVar("--negative"):"inherit")+"'><span class=\"cell-label\">Diff</span>"+signed(y.diffSum)+"</td>"+
        "<td class='num' data-label='vs. Prev Year'><span class=\"cell-label\">vs. Prev Year</span>"+deltaCell+"</td>";
      body.appendChild(tr);
    });
  }

  // ---------- Calendar ----------
  var calendarViewDate = new Date(); // tracks which month is currently shown

  // One badge per day: what actually happened, in priority order.
  function calendarDayStatus(dateStr){
    var entry = entries.find(function(e){ return e.date === dateStr; });
    var scheduled = isScheduled(dateStr);
    if(!entry){
      if(!scheduled) return "off";
      return dateStr > todayStr() ? "future" : "missing";
    }
    var c = computeEntry(entry);
    if(c.open) return "open";
    if(c.excused) return "excused";
    if(c.workedMin === null) return scheduled && dateStr <= todayStr() ? "missing" : "off";
    if(c.diffMin !== null && c.diffMin >= 0) return "met";
    return "under";
  }

  function renderCalendar(){
    var y = calendarViewDate.getFullYear(), m = calendarViewDate.getMonth();
    document.getElementById("calMonthLabel").textContent =
      calendarViewDate.toLocaleDateString(undefined, {month:"long", year:"numeric"});

    var firstOfMonth = new Date(y, m, 1);
    var startDow = firstOfMonth.getDay();
    var daysInMonth = new Date(y, m+1, 0).getDate();

    var html = DAY_NAMES.map(function(d){ return '<div class="cal-dow">'+d+'</div>'; }).join("");
    for(var i=0;i<startDow;i++) html += '<div class="cal-cell cal-empty"></div>';

    for(var day=1; day<=daysInMonth; day++){
      var dStr = y+"-"+pad2(m+1)+"-"+pad2(day);
      var status = calendarDayStatus(dStr);
      var isToday = dStr === todayStr();
      var entry = entries.find(function(e){ return e.date === dStr; });
      var title = entry ? (typeLabel(entry.type) + (entry.clockIn ? " · " + formatTime12(entry.clockIn) : "")) : "No entry";
      // Status was previously carried by background colour and a coloured dot
      // alone — indistinguishable for colour-blind users and invisible to a
      // screen reader, whose only cue was the bare day number.
      var statusWord = CAL_STATUS_LABELS[status] || status;
      var calLabel = fmtDateLong(dStr) + ", " + statusWord +
        (entry ? ", " + title : "") + (isToday ? ", today" : "");
      // Row-by-row reveal on month navigation; capped so a 5-6 week month
      // doesn't drag the animation out past a quick, routine transition.
      var gridIndex = startDow + day - 1;
      var cellDelay = Math.min(gridIndex, 20) * 12;
      html +=
        '<button type="button" class="cal-cell cal-'+status+(isToday?' cal-today':'')+'" data-date="'+dStr+'" ' +
          'title="'+escapeAttr(title)+'" aria-label="'+escapeAttr(calLabel)+'"' +
          (isToday ? ' aria-current="date"' : '') +
          ' style="animation-delay:'+cellDelay+'ms">' +
          '<span class="cal-daynum" aria-hidden="true">'+day+'</span>' +
          '<span class="cal-dot" aria-hidden="true"></span>' +
        '</button>';
    }
    document.getElementById("calendarGrid").innerHTML = html;
  }

  // ---------- Week timeline ----------
  // Month view answers "which days went well". This answers "when did I
  // actually work", which a grid of coloured day cells cannot show: each entry
  // is a bar spanning its real clock-in to clock-out.
  var calMode = "month";               // "month" | "week"
  var WL_DEFAULT_START = 6, WL_DEFAULT_END = 22;

  function startOfWeek(d){
    var out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    out.setDate(out.getDate() - out.getDay()); // Sunday-first, matching DAY_NAMES
    return out;
  }

  function renderWeekLine(){
    var host = document.getElementById("weekLine");
    if(!host) return;
    var start = startOfWeek(calendarViewDate);

    var days = [];
    for(var i=0;i<7;i++){
      days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate()+i));
    }
    function dstr(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }

    // The window adapts to the week's own data. A fixed 6am-10pm frame is right
    // for office hours, but this app explicitly supports overnight shifts
    // (computeEntry adds 24h to a negative span), and those would otherwise
    // collapse into an unreadable sliver clamped against the bottom edge.
    var WL_START_HOUR = WL_DEFAULT_START, WL_END_HOUR = WL_DEFAULT_END;
    days.forEach(function(d){
      var e = entries.find(function(x){ return x.date === dstr(d); });
      if(!e || !e.clockIn) return;
      var from = timeToMinutes(e.clockIn);
      var to = e.clockOut ? timeToMinutes(e.clockOut) : from;
      if(to < from) to += 24*60; // overnight
      WL_START_HOUR = Math.min(WL_START_HOUR, Math.floor(from/60));
      WL_END_HOUR   = Math.max(WL_END_HOUR, Math.ceil(to/60));
    });
    if(WL_END_HOUR - WL_START_HOUR > 24){ WL_START_HOUR = 0; WL_END_HOUR = 24; }
    var span = (WL_END_HOUR - WL_START_HOUR) * 60;

    var html = '<div class="wl-dayhead"></div>';
    days.forEach(function(d){
      var isToday = dstr(d) === todayStr();
      html += '<div class="wl-dayhead'+(isToday?' is-today':'')+'">'+
        DAY_NAMES[d.getDay()]+'<b>'+d.getDate()+'</b></div>';
    });

    // Hour axis. Labelled every two hours so the column does not become a
    // stack of touching numerals on a phone.
    var axis = '<div class="wl-axis" style="grid-row:2;">';
    var tickStep = (WL_END_HOUR - WL_START_HOUR) > 18 ? 3 : 2;
    for(var h=WL_START_HOUR; h<=WL_END_HOUR; h+=tickStep){
      var pct = ((h - WL_START_HOUR) * 60 / span) * 100;
      axis += '<span style="top:'+pct.toFixed(2)+'%">'+formatTime12(pad2(h)+":00")+'</span>';
    }
    html += axis + '</div>';

    var any = false;
    days.forEach(function(d){
      var ds = dstr(d);
      var isToday = ds === todayStr();
      var cell = '<div class="wl-col'+(isToday?' is-today':'')+'" style="grid-row:2;">';
      var entry = entries.find(function(e){ return e.date === ds; });
      if(entry){
        any = true;
        var c = computeEntry(entry);
        if(entry.clockIn){
          var from = timeToMinutes(entry.clockIn);
          // An open shift is still running: draw it to now, so the bar grows
          // through the day instead of showing nothing until you clock out.
          var toRaw = entry.clockOut ? timeToMinutes(entry.clockOut)
                    : (isToday ? (new Date().getHours()*60 + new Date().getMinutes()) : from + 30);
          // Overnight: match computeEntry's rule (a negative span means the
          // shift crossed midnight) so the bar length equals the hours the
          // rest of the app credits for that day.
          if(toRaw < from) toRaw += 24*60;
          var top = Math.max(0, Math.min(100, ((from - WL_START_HOUR*60) / span) * 100));
          var bot = Math.max(0, Math.min(100, ((toRaw - WL_START_HOUR*60) / span) * 100));
          var height = Math.max(2.2, bot - top);
          var cls = c.open ? "is-open" : (c.diffMin !== null && c.diffMin >= 0 ? "is-met" : "is-under");
          var label = formatTime12(entry.clockIn) + (entry.clockOut ? "–" + formatTime12(entry.clockOut) : "");
          cell += '<div class="wl-bar '+cls+'" style="top:'+top.toFixed(2)+'%; height:'+height.toFixed(2)+'%" '+
            'title="'+escapeAttr(typeLabel(entry.type)+" · "+label)+'">'+escapeHtml(label)+'</div>';
        } else {
          cell += '<div class="wl-chip" title="'+escapeAttr(typeLabel(entry.type))+'">'+
            escapeHtml(typeLabel(entry.type))+'</div>';
        }
      }
      cell += '</div>';
      html += cell;
    });

    if(!any){
      html += '<p class="wl-empty" style="grid-row:3;">Nothing logged this week yet.</p>';
    }
    host.innerHTML = html;
  }

  // One entry point so every caller (nav, Today, tab activation, data reload)
  // paints whichever view is currently selected.
  function renderCalendarView(){
    var grid = document.getElementById("calendarGrid");
    var week = document.getElementById("weekLine");
    var label = document.getElementById("calMonthLabel");
    if(calMode === "week"){
      grid.hidden = true; grid.style.display = "none";
      week.hidden = false;
      renderWeekLine();
      var s = startOfWeek(calendarViewDate);
      var e = new Date(s.getFullYear(), s.getMonth(), s.getDate()+6);
      var sameMonth = s.getMonth() === e.getMonth();
      // Composed by hand: asking toLocaleDateString for {day, year} alone lets
      // the runtime render "2026 (day: 22)", which is not a date range.
      var left = s.toLocaleDateString(undefined,{month:"short", day:"numeric"});
      var right = sameMonth
        ? String(e.getDate())
        : e.toLocaleDateString(undefined,{month:"short", day:"numeric"});
      label.textContent = left + " – " + right + ", " + e.getFullYear();
    } else {
      week.hidden = true;
      grid.hidden = false; grid.style.display = "";
      renderCalendar();
    }
  }

  document.querySelectorAll("[data-cal-mode]").forEach(function(btn){
    btn.addEventListener("click", function(){
      calMode = btn.getAttribute("data-cal-mode");
      document.querySelectorAll("[data-cal-mode]").forEach(function(b){
        var on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderCalendarView();
    });
  });

  // Nav steps by whichever unit is on screen: a month at a time in month view,
  // a week at a time in week view.
  function stepCalendar(dir){
    if(calMode === "week") calendarViewDate.setDate(calendarViewDate.getDate() + dir*7);
    else calendarViewDate.setMonth(calendarViewDate.getMonth() + dir);
    renderCalendarView();
  }
  document.getElementById("calPrevBtn").addEventListener("click", function(){ stepCalendar(-1); });
  document.getElementById("calNextBtn").addEventListener("click", function(){ stepCalendar(1); });
  document.getElementById("calTodayBtn").addEventListener("click", function(){
    calendarViewDate = new Date();
    renderCalendarView();
  });

  function openNewEntryForm(dateStr){
    // resetForm() closes the dialog, so it has to run before the open — not
    // after, or the dialog opens and immediately shuts again.
    resetForm();
    if(dateStr){
      document.getElementById("fDate").value = dateStr;
      document.getElementById("fToDate").value = dateStr;
    }
    openEntryModal();
  }

  document.getElementById("calendarGrid").addEventListener("click", function(ev){
    var cell = ev.target.closest(".cal-cell[data-date]");
    if(!cell) return;
    var dStr = cell.getAttribute("data-date");
    var entry = entries.find(function(e){ return e.date === dStr; });
    if(entry){
      loadEntryIntoForm(entry.id);
    } else {
      openNewEntryForm(dStr);
    }
  });

  // Keyboard accelerators. Before this, only modals trapped Tab/Escape/Enter —
  // the two most repeated actions (paging through a month, opening the manual-
  // entry form) had no accelerator at all.
  function isEditableTarget(t){
    var tag = t && t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);
  }
  document.getElementById("tab-calendar").addEventListener("keydown", function(ev){
    if(ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if(isEditableTarget(ev.target)) return;
    ev.preventDefault();
    document.getElementById(ev.key === "ArrowLeft" ? "calPrevBtn" : "calNextBtn").click();
  });
  document.getElementById("tab-team").addEventListener("keydown", function(ev){
    if(ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if(isEditableTarget(ev.target)) return;
    ev.preventDefault();
    var btn = document.getElementById(ev.key === "ArrowLeft" ? "teamPrevMonth" : "teamNextMonth");
    if(btn && !btn.disabled) btn.click();
  });
  // "n" jumps straight to the manual-entry form from anywhere in the app —
  // the same destination a fresh calendar-day tap opens, just without
  // needing to first navigate to Calendar and find an empty day.
  document.addEventListener("keydown", function(ev){
    if(ev.key !== "n" && ev.key !== "N") return;
    if(ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if(isEditableTarget(ev.target)) return;
    if(document.querySelector(".modal-overlay")) return;
    ev.preventDefault();
    document.querySelector('.tab-btn[data-tab="overview"]').click();
    openNewEntryForm();
    document.getElementById("fDate").focus();
  });

  // ---------- Punctuality ----------
  function renderPunctuality(){
    var scope = punctEntries();
    document.getElementById("punctRule").textContent =
      "Every scheduled day that finished short of its target hours, regardless of when you clocked in or out — " +
      "arrive late or leave early and still make the hours up, and the day isn't flagged. Showing " + punctScopeLabel() + ".";
    var s = summarize(scope);

    document.getElementById("punctCount").textContent =
      (s.ratedDays ? s.ratedDays + " day" + (s.ratedDays===1?"":"s") + " assessed" : "") +
      (s.pendingDays ? (s.ratedDays ? " · " : "") + s.pendingDays + " still in progress" : "");

    // What share of the period's target hours actually got worked — a
    // continuous read on accomplishment (89%, not just "4 of 5 days"), and
    // it can run past 100% the same way the overtime bank can. Floored, not
    // rounded: 84h58m of a 85h15m target is 99.67%, seventeen minutes short
    // — rounding that to "100%" would claim the target was fully met when
    // it wasn't.
    var rateEl = document.getElementById("pMetRate");
    if(s.targetSum){
      var accomplishedPct = Math.floor((s.workedSum / s.targetSum) * 100);
      rateEl.textContent = accomplishedPct + "%";
      rateEl.className = "stat-value " + (accomplishedPct >= 100 ? "positive" : (accomplishedPct < 70 ? "negative" : ""));
      document.getElementById("pMetRateDetail").textContent =
        minutesToHoursStr(s.workedSum) + " of " + minutesToHoursStr(s.targetSum) + " target";
    } else {
      rateEl.textContent = "—";
      rateEl.className = "stat-value";
      document.getElementById("pMetRateDetail").textContent = "No scheduled days yet";
    }

    document.getElementById("pShortDays").textContent = s.shortDays;
    document.getElementById("pShortDaysDetail").textContent = s.shortDays
      ? (s.missedDays
          ? s.missedDays + " with nothing logged at all"
          : "All partial — some hours were logged")
      : "Nothing flagged";

    document.getElementById("pShortTotal").textContent = s.shortDays ? minutesToHoursStr(s.shortSum) : "—";
    document.getElementById("pShortTotalDetail").textContent = s.shortDays
      ? "Across " + s.shortDays + " day" + (s.shortDays===1?"":"s")
      : "Nothing owed this period";

    document.getElementById("pAvgShort").textContent = s.shortDays ? minutesToHoursStr(s.avgShortMin) : "—";
    document.getElementById("pAvgShortDetail").textContent = s.shortDays
      ? "Per day that fell short"
      : "Nothing flagged";

    // Average shortfall per short day, by month. Follows the year filter but
    // ignores the month one, so the chart still gives context around the
    // month being inspected.
    var chartYear = document.getElementById("punctYearSelect").value;
    var chartSource = chartYear === "all"
      ? entries
      : entries.filter(function(e){ return yearKey(e.date) === chartYear; });
    var byMonth = groupBy(chartSource, monthKey);
    var mKeys = Object.keys(byMonth).sort();
    renderTrendChart(document.getElementById("punctChart"), mKeys.map(function(k){
      var ms = summarize(byMonth[k]);
      return {
        label: chartYear === "all"
          ? monthShortLabel(k)
          : new Date(+k.split("-")[0], +k.split("-")[1]-1, 1).toLocaleDateString(undefined,{month:"short"}),
        value: ms.avgShortMin,
        // Every plotted point here is already a bad number — there's no
        // "met target" reading of a shortfall, so force the red dot rather
        // than let the default value>=0 comparison paint it green.
        met: false,
        hasEntry: ms.shortDays > 0
      };
    }), {height:140, targetMin:0, formatter:minutesOnlyStr, accent:cssVar("--negative"), name:"Average shortfall per short day, by month"});

    // Table of every day that fell short, most recent first. A day still
    // running today is excluded — it hasn't ended, so there's nothing to
    // judge yet — same rule summarize() uses for the stats above.
    var flagged = scope.filter(function(e){
      var c = computeEntry(e);
      if(!c.targetMin) return false;
      if(c.open && e.date === todayStr()) return false;
      var worked = c.workedMin !== null ? c.workedMin : 0;
      return (c.targetMin - worked) > 0;
    }).sort(function(a,b){ return b.date.localeCompare(a.date); });

    var body = document.getElementById("punctBody");
    body.innerHTML = "";
    var empty = document.getElementById("punctEmpty");
    empty.textContent = s.ratedDays
      ? "No shortfalls in this period. Every scheduled day met its target."
      : "No attendance recorded for this period yet.";
    empty.style.display = flagged.length ? "none" : "block";

    flagged.forEach(function(e){
      var c = computeEntry(e);
      var worked = c.workedMin !== null ? c.workedMin : 0;
      var shortMin = c.targetMin - worked;
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td data-label='Date'><span class=\"cell-label\">Date</span>"+fmtDate(e.date)+"</td>"+
        "<td data-label='Day'><span class=\"cell-label\">Day</span>"+DAY_NAMES[dateFromStr(e.date).getDay()]+"</td>"+
        "<td class='num' data-label='Worked'><span class=\"cell-label\">Worked</span>"+minutesToHoursStr(c.workedMin)+"</td>"+
        "<td class='num' data-label='Target'><span class=\"cell-label\">Target</span>"+minutesToHoursStr(c.targetMin)+"</td>"+
        "<td class='num' data-label='Short By'><span class=\"cell-label\">Short By</span><span class='late-cell'>"+minutesToHoursStr(shortMin)+"</span></td>"+
        "<td class='note-cell' dir='auto' data-label='Note'><span class=\"cell-label\">Note</span>"+escapeHtml(e.note)+"</td>";
      body.appendChild(tr);
    });
  }

  function renderCharts(){
    renderWeekly();
    renderMonthly();
    renderYearly();
    renderPunctuality();
  }

  function renderAll(){
    populateFilters();
    renderStats();
    renderReminder();
    renderBackupReminder();
    renderLog();
    renderCharts();
    renderPersonCard();
    renderWorkingFormat();
    // Fire-and-forget: it is one row-per-person query for today only, and a
    // failure inside it must not stop the rest of the repaint. Non-admins
    // return immediately without touching the network.
    renderTodayTeam().catch(function(){});
    fitOverview();
    // Repaint the calendar only when it is the visible tab: it is not part of
    // the default view, and rendering a hidden panel on every data change is
    // work nobody sees.
    if(document.querySelector('.tab-btn[data-tab="calendar"].active')) renderCalendarView();
  }

  // ---------- Backup reminder ----------
  var backupSnoozed = (function(){
    var until = parseInt(safeGet(SNOOZE_KEY) || "", 10);
    return isFinite(until) && Date.now() < until;
  })();

  function markBackedUp(){
    safeSet(BACKUP_KEY, String(Date.now()));
    renderBackupReminder();
  }

  function renderBackupReminder(){
    var banner = document.getElementById("backupBanner");
    if(backupSnoozed || !entries.length){ banner.classList.remove("show"); return; }

    var last = parseInt(safeGet(BACKUP_KEY) || "", 10);
    var now = Date.now();
    var dayMs = 24*60*60*1000;

    if(isFinite(last)){
      var days = Math.floor((now - last) / dayMs);
      if(days < BACKUP_REMIND_DAYS){ banner.classList.remove("show"); return; }
      document.getElementById("backupTitle").textContent = "Time for a backup";
      document.getElementById("backupText").textContent =
        "Your last backup was " + days + " days ago. You've logged " + entries.length +
        " days. Your data is saved to your account, but an export gives you your own copy to keep.";
    } else {
      // Never backed up: wait until there's enough logged to be worth protecting.
      if(entries.length < 5){ banner.classList.remove("show"); return; }
      document.getElementById("backupTitle").textContent = "You haven't backed up yet";
      document.getElementById("backupText").textContent =
        "You've logged " + entries.length + " days. Your data is saved to your account — " +
        "an export just gives you your own copy to keep or hand over.";
    }
    banner.classList.add("show");
  }

  document.getElementById("backupNowBtn").addEventListener("click", function(){
    exportJson();
  });
  document.getElementById("backupLaterBtn").addEventListener("click", function(){
    backupSnoozed = true;
    safeSet(SNOOZE_KEY, String(Date.now() + 7*24*60*60*1000));
    renderBackupReminder();
  });

  // ---------- Print report ----------
  // suppressDialog is set when we're building in response to the browser's own
  // beforeprint — the print dialog is already opening, so calling window.print()
  // again would loop.
  function buildPrintReport(period, suppressDialog){
    var rows, title, subtitle;
    if(period === "year"){
      var yr = getYearFilter();
      rows = entries.filter(function(e){ return yearKey(e.date) === yr; });
      title = "Attendance Report — " + yr;
      subtitle = "January 1 – December 31, " + yr;
    } else {
      var mf = getMonthFilter(), yf = getLogYearFilter();
      rows = filteredEntries();
      var scopeLabel = mf !== "all" ? monthLabel(mf) : (yf !== "all" ? yf : "");
      title = "Attendance Report" + (scopeLabel ? " — " + scopeLabel : "");
      subtitle = scopeLabel ? scopeLabel : "All recorded days";
    }
    rows = rows.slice().sort(function(a,b){ return a.date.localeCompare(b.date); });
    var s = summarize(rows);

    var html =
      '<p class="p-eyebrow">Personal Time Record</p>' +
      '<h1>'+escapeHtml(title)+'</h1>' +
      '<p class="p-meta">'+escapeHtml(subtitle)+'</p>' +
      '<p class="p-meta">Schedule: '+escapeHtml(scheduleSummary())+'</p>' +
      '<p class="p-meta">Generated '+escapeHtml(fmtDateLong(todayStr()))+'</p>' +
      '<hr class="p-rule">' +
      '<h2>Summary</h2>' +
      '<div class="p-summary">' +
        '<div><span class="k">Days Logged</span><span class="v">'+s.loggedDays+'</span></div>' +
        '<div><span class="k">Total Hours</span><span class="v">'+minutesToHoursStr(s.workedSum)+'</span></div>' +
        '<div><span class="k">Average / Day</span><span class="v">'+(s.loggedDays?minutesToHoursStr(s.avgMin):"—")+'</span></div>' +
        '<div><span class="k">Target Hours</span><span class="v">'+minutesToHoursStr(s.targetSum)+'</span></div>' +
        '<div><span class="k">Overtime / Under</span><span class="v">'+signed(s.diffSum)+'</span></div>' +
      '</div>';

    if(period === "year"){
      var byMonth = groupBy(rows, monthKey);
      var mKeys = Object.keys(byMonth).sort();
      html += '<h2>Monthly Breakdown</h2><table><thead><tr>' +
        '<th>Month</th><th class="num">Days</th><th class="num">Total</th><th class="num">Avg / Day</th><th class="num">Target</th><th class="num">Diff</th>' +
        '</tr></thead><tbody>';
      mKeys.forEach(function(k){
        var ms = summarize(byMonth[k]);
        html += '<tr><td>'+escapeHtml(monthLabel(k))+'</td>' +
          '<td class="num">'+ms.loggedDays+'</td>' +
          '<td class="num">'+minutesToHoursStr(ms.workedSum)+'</td>' +
          '<td class="num">'+(ms.loggedDays?minutesToHoursStr(ms.avgMin):"—")+'</td>' +
          '<td class="num">'+minutesToHoursStr(ms.targetSum)+'</td>' +
          '<td class="num">'+signed(ms.diffSum)+'</td></tr>';
      });
      html += '</tbody></table>';
    }

    html += '<h2>Daily Record</h2>';
    if(!rows.length){
      html += '<p class="p-meta">No entries in this period.</p>';
    } else {
      html += '<table><thead><tr>' +
        '<th>Date</th><th>Day</th><th>In</th><th>Out</th>' +
        '<th class="num">Worked</th><th class="num">Target</th><th class="num">Diff</th><th>Type</th><th>Note</th>' +
        '</tr></thead><tbody>';
      rows.forEach(function(e){
        var c = computeEntry(e);
        html += '<tr>' +
          '<td>'+escapeHtml(fmtDate(e.date))+'</td>' +
          '<td>'+DAY_NAMES[dateFromStr(e.date).getDay()]+'</td>' +
          '<td>'+(e.clockIn?escapeHtml(formatTime12(e.clockIn)):"—")+'</td>' +
          '<td>'+(e.clockOut?escapeHtml(formatTime12(e.clockOut)):"—")+'</td>' +
          '<td class="num">'+minutesToHoursStr(c.workedMin)+'</td>' +
          '<td class="num">'+(c.targetMin?minutesToHoursStr(c.targetMin):"—")+'</td>' +
          '<td class="num">'+(c.diffMin===null?"—":signed(c.diffMin))+'</td>' +
          '<td>'+escapeHtml(typeLabel(e.type))+'</td>' +
          '<td>'+escapeHtml(e.note)+'</td></tr>';
      });
      html += '</tbody></table>';
    }

    html += '<div class="p-sign"><div>Employee signature &amp; date</div><div>Manager signature &amp; date</div></div>';
    document.getElementById("printArea").innerHTML = html;
    if(!suppressDialog) window.print();
  }

  document.getElementById("printBtn").addEventListener("click", function(){ buildPrintReport("month"); });
  document.getElementById("printYearBtn").addEventListener("click", function(){ buildPrintReport("year"); });

  // The print stylesheet hides the header, main and footer unconditionally and
  // shows only #printArea, which was populated only by the buttons above. So
  // Ctrl+P — the obvious thing to try — printed a blank page, and after using
  // Print Report once it printed a stale report for a period the user was no
  // longer looking at. Build on demand, and clear afterwards so nothing goes
  // out of date.
  var printAreaBuilt = false;
  window.addEventListener("beforeprint", function(){
    var area = document.getElementById("printArea");
    if(area && !area.innerHTML.trim()){
      buildPrintReport("month", true);
      printAreaBuilt = true;
    }
  });
  window.addEventListener("afterprint", function(){
    var area = document.getElementById("printArea");
    if(area) area.innerHTML = "";
    printAreaBuilt = false;
  });

  // ---------- Form ----------
  var editingId = null;
  var selectModeActive = false;
  var selectedEntryIds = new Set();
  var form = document.getElementById("entryForm");

  document.getElementById("fillStandardBtn").addEventListener("click", function(){
    // Resolve against the date being edited, not the base schedule — a seasonal
    // period (Ramadan, summer hours) overrides the standard start/end for the
    // dates it covers.
    var sched = scheduleFor(document.getElementById("fDate").value || todayStr());
    document.getElementById("fIn").value = sched.standardIn;
    document.getElementById("fOut").value = sched.standardOut;
  });

  // ---------- Entry dialog ----------
  // The add/edit form used to sit open on the Overview under the clock panel.
  // It is a dialog now, opened from the + in the Log toolbar, from an Edit
  // action in the log, and from an empty day in the calendar.
  var entryModalReturn = null;
  // The [hidden] flip is deferred until the fade-out finishes. Reopening
  // inside that window — which every "reset then open" caller does — has to
  // cancel the pending flip, or the dialog opens and then vanishes 180ms later
  // when the stale timer lands.
  var entryModalHideTimer = null;

  function openEntryModal(focusId){
    var modal = document.getElementById("entryModal");
    if(!modal) return;
    var wasOpen = !modal.hidden && modal.classList.contains("show");
    clearTimeout(entryModalHideTimer);
    entryModalHideTimer = null;
    if(!wasOpen) entryModalReturn = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(function(){ modal.classList.add("show"); });
    document.removeEventListener("keydown", onEntryModalKey);
    document.addEventListener("keydown", onEntryModalKey);
    // After the open transition, so focus doesn't land mid-flight and scroll
    // the card while it is still being transformed.
    setTimeout(function(){
      var target = modal.querySelector("#" + (focusId || "fDate"));
      if(target) target.focus();
    }, 60);
  }

  function closeEntryModal(){
    var modal = document.getElementById("entryModal");
    if(!modal || modal.hidden) return;
    modal.classList.remove("show");
    document.removeEventListener("keydown", onEntryModalKey);
    clearTimeout(entryModalHideTimer);
    entryModalHideTimer = setTimeout(function(){ modal.hidden = true; }, 180);
    if(entryModalReturn && typeof entryModalReturn.focus === "function") entryModalReturn.focus();
    entryModalReturn = null;
  }

  function onEntryModalKey(ev){
    // A confirm dialog opens ON TOP of this one ("replace it?", "is that shift
    // right?") and installs its own document-level Escape handler. Both would
    // fire, and this one first, closing the form out from under a confirmation
    // the user was still answering.
    if(document.querySelector(".modal-overlay")) return;
    var modal = document.getElementById("entryModal");
    if(!modal || modal.hidden) return;
    if(ev.key === "Escape"){ closeEntryModal(); return; }
    if(ev.key !== "Tab") return;
    var els = Array.prototype.slice.call(modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function(el){ return !el.disabled && el.offsetParent !== null; });
    if(!els.length) return;
    var first = els[0], last = els[els.length - 1];
    if(ev.shiftKey && document.activeElement === first){ ev.preventDefault(); last.focus(); }
    else if(!ev.shiftKey && document.activeElement === last){ ev.preventDefault(); first.focus(); }
    else if(!modal.contains(document.activeElement)){ ev.preventDefault(); first.focus(); }
  }

  document.getElementById("entryModal").addEventListener("click", function(ev){
    if(ev.target === this) closeEntryModal();
  });
  document.getElementById("entryModalClose").addEventListener("click", closeEntryModal);
  document.getElementById("addEntryBtn").addEventListener("click", function(){ openNewEntryForm(); });

  function resetForm(){
    form.reset();
    editingId = null;
    // Every caller of resetForm() is a "this form is finished or no longer
    // valid" moment — a successful save, Cancel Edit, or the entry being
    // deleted underneath it — so all of them should dismiss the dialog.
    closeEntryModal();
    document.getElementById("entryModalTitle").textContent = "Add Entry";
    var today = todayStr();
    document.getElementById("fDate").value = today;
    document.getElementById("fToDate").value = today;
    document.getElementById("fToDate").min = today;
    document.getElementById("fType").value = "regular";
    document.getElementById("submitBtn").textContent = "Add Entry";
    document.getElementById("cancelEditBtn").style.display = "none";
    document.getElementById("fToDateWrap").style.display = "";
    document.getElementById("fRangeHint").style.display = "";
    document.getElementById("fDateLabel").textContent = "From";
  }

  function loadEntryIntoForm(id){
    var e = entries.find(function(x){ return x.id === id; });
    if(!e) return;
    resetForm();
    document.getElementById("fDate").value = e.date;
    document.getElementById("fIn").value = e.clockIn || "";
    document.getElementById("fOut").value = e.clockOut || "";
    document.getElementById("fType").value = e.type || "regular";
    document.getElementById("fNote").value = e.note || "";
    editingId = e.id;
    document.getElementById("submitBtn").textContent = "Save Changes";
    document.getElementById("cancelEditBtn").style.display = "inline-flex";
    // Editing modifies exactly one existing entry, so the range picker
    // doesn't apply here — just the single date being edited.
    document.getElementById("fToDateWrap").style.display = "none";
    document.getElementById("fRangeHint").style.display = "none";
    document.getElementById("fDateLabel").textContent = "Date";
    document.getElementById("entryModalTitle").textContent = "Edit Entry";
    // Editing almost always means filling in the clock-out that was never
    // recorded, so start there rather than on the date that is already right.
    openEntryModal("fOut");
  }

  document.getElementById("fDate").addEventListener("change", function(){
    var toDate = document.getElementById("fToDate");
    toDate.min = this.value;
    // Changing From always collapses To to match it. This keeps a single-day
    // edit a single day by default — widening into a range is then a
    // deliberate, separate action of changing To afterward.
    toDate.value = this.value;
  });

  document.getElementById("bulkApplyFromDate").addEventListener("change", function(){
    var toDate = document.getElementById("bulkApplyToDate");
    toDate.min = this.value;
    if(toDate.value && toDate.value < this.value) toDate.value = this.value;
  });

  form.addEventListener("submit", async function(ev){
    ev.preventDefault();
    var date = document.getElementById("fDate").value;
    if(!date){ showToast("Pick a date first.", "error"); markFieldInvalid("fDate"); return; }

    var toDateVal = document.getElementById("fToDate").value;
    // A range only actually applies when adding new entries with a genuinely
    // different end date — editing always targets the single date being edited.
    var isRange = !editingId && toDateVal && toDateVal !== date;

    var basePayload = {
      clockIn: document.getElementById("fIn").value || "",
      clockOut: document.getElementById("fOut").value || "",
      type: document.getElementById("fType").value,
      note: document.getElementById("fNote").value.trim()
    };

    if(isRange){
      await submitRecurringRange(date, basePayload);
      return;
    }

    // A clock-out earlier than the clock-in is treated as an overnight shift,
    // which is right for a real night shift and wrong for the far more common
    // case of the two fields being transposed — 16:00/08:00 silently recorded a
    // 16-hour day and eight hours of overtime. The two are indistinguishable to
    // the code, so ask rather than guess.
    if(!(await confirmLongShift(basePayload))) return;

    var payload = Object.assign({date: date}, basePayload);
    var existingDbId = null;
    if(editingId){
      existingDbId = editingId;
    } else {
      var existing = entries.find(function(e){ return e.date === date; });
      if(existing){
        if(!(await showConfirm("An entry for "+fmtDate(date)+" already exists. Replace it?", {confirmText:"Replace"}))) return;
        existingDbId = existing.id;
      }
    }

    var btn = document.getElementById("submitBtn");
    var prevText = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    try{
      await sbUpsertEntry(viewedUserId, payload, existingDbId);
      delete dismissedReminders[date];
      persistDismissals();
      resetForm();
      await loadDataForViewedUser();
    }catch(err){
      showToast("Couldn't save that entry: " + friendlyError(err), "error");
    }finally{
      btn.disabled = false; btn.textContent = prevText;
    }
  });

  // Applies one entry template across every scheduled workday in a date
  // range — the "week of planned leave in one go" case. Non-workdays in
  // the range are skipped since there's nothing to log on a day off.
  async function submitRecurringRange(fromDate, basePayload){
    var toDate = document.getElementById("fToDate").value;
    if(!toDate){ showToast("Pick an end date for the range.", "error"); return; }
    if(toDate < fromDate){ showToast("The end date can't be before the start date.", "error"); return; }

    var dates = [];
    var cursor = dateFromStr(fromDate);
    var end = dateFromStr(toDate);
    var guard = 0;
    while(dateToStr(cursor) <= dateToStr(end) && guard < 400){
      if(isScheduled(dateToStr(cursor))) dates.push(dateToStr(cursor));
      cursor.setDate(cursor.getDate() + 1);
      guard++;
    }
    // If the scan stopped because it hit the safety cap rather than because
    // it reached the end date, the range genuinely wasn't fully covered —
    // say so rather than silently applying to fewer days than requested.
    if(dateToStr(cursor) <= dateToStr(end)){
      showToast("That date range is too large to scan in one go — narrow it and try again.", "error");
      return;
    }
    if(!dates.length){
      showToast("No scheduled workdays fall inside that date range.", "error");
      return;
    }
    if(dates.length > 62){
      showToast("That range covers " + dates.length + " workdays — narrow it to 62 or fewer at a time.", "error");
      return;
    }

    var replacing = dates.filter(function(d){ return entries.some(function(e){ return e.date === d; }); }).length;
    var msg = "This will add " + typeLabel(basePayload.type).toLowerCase() + " entries for " +
      dates.length + " workday" + (dates.length===1?"":"s") + " (" + fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length-1]) + ").";
    if(replacing) msg += " " + replacing + " already have an entry and will be replaced.";
    if(!(await showConfirm(msg, {title:"Apply to date range?", confirmText:"Apply"}))) return;

    var btn = document.getElementById("submitBtn");
    btn.disabled = true;
    btn.textContent = "Adding " + dates.length + " entries…";
    beginBulkOperation();

    var rows = dates.map(function(d){
      return entryToRow(Object.assign({date:d}, basePayload), viewedUserId);
    });
    var applied = 0, bulkErr = null;
    try{
      applied = await sbBulkUpsertEntries(rows);
      dates.forEach(function(d){ delete dismissedReminders[d]; });
      persistDismissals();
    }catch(err){ bulkErr = err; }

    endBulkOperation();
    btn.disabled = false;
    resetForm();
    await loadDataForViewedUser();
    if(bulkErr) showToast("Couldn't add those entries: " + friendlyError(bulkErr), "error");
    else showToast("Added " + applied + " entries.", "success");
  }

  // Guards against the transposed-times typo. Returns false only if the user
  // says the entry is wrong; a genuine overnight shift confirms through.
  var LONG_SHIFT_MIN = 12 * 60;
  async function confirmLongShift(payload){
    if(!payload.clockIn || !payload.clockOut) return true;
    var inMin = timeToMinutes(payload.clockIn), outMin = timeToMinutes(payload.clockOut);
    var gross = outMin - inMin;
    var wrapped = gross < 0;
    if(wrapped) gross += 24*60;
    if(gross < LONG_SHIFT_MIN) return true;
    return showConfirm(
      "That records " + minutesToHoursStr(gross) + " worked" +
      (wrapped ? ", finishing the next morning." : ".") +
      "\n\nClock in " + formatTime12(payload.clockIn) +
      ", clock out " + formatTime12(payload.clockOut) + "." +
      (wrapped ? "\n\nIf the two times got swapped, choose Go Back and switch them." : ""),
      {title:"Is that shift right?", confirmText:"Yes, that's right", cancelText:"Go Back"}
    );
  }

  document.getElementById("cancelEditBtn").addEventListener("click", resetForm);

  document.getElementById("logBody").addEventListener("click", async function(ev){
    var btn = ev.target.closest("button");
    if(!btn){
      // The visible checkbox is 16px, well under a comfortable tap target —
      // let a click anywhere in the cell toggle it instead of just the box.
      var cell = ev.target.closest("td.select-col");
      var box = cell && cell.querySelector(".row-select");
      if(box){ box.checked = !box.checked; box.dispatchEvent(new Event("change", {bubbles:true})); }
      return;
    }
    var editId = btn.getAttribute("data-edit");
    var delId = btn.getAttribute("data-del");
    if(editId) loadEntryIntoForm(editId);
    if(delId && await showConfirm("Delete this entry?", {danger:true, confirmText:"Delete"})){
      if(editingId === delId) resetForm();
      try{
        await sbDeleteEntry(delId);
        await loadDataForViewedUser();
      }catch(err){
        showToast("Couldn't delete that entry: " + friendlyError(err), "error");
      }
    }
  });

  // ---------- Bulk select ----------
  function updateBulkToolbar(){
    document.getElementById("bulkCount").textContent =
      selectedEntryIds.size + " selected";
    document.getElementById("bulkDeleteBtn").disabled = selectedEntryIds.size === 0;
    var allBoxes = document.querySelectorAll("#logBody .row-select");
    var allChecked = allBoxes.length > 0 && Array.from(allBoxes).every(function(b){ return b.checked; });
    document.getElementById("bulkSelectAll").checked = allChecked;
  }

  function setSelectMode(on){
    selectModeActive = on;
    selectedEntryIds.clear();
    document.getElementById("selectModeToggle").classList.toggle("active", on);
    document.getElementById("bulkToolbar").style.display = on ? "flex" : "none";
    document.getElementById("selectColHead").style.display = on ? "" : "none";
    document.getElementById("bulkSelectAll").checked = false;
    renderLog();
    if(on) updateBulkToolbar();
  }

  document.getElementById("selectModeToggle").addEventListener("click", function(){
    setSelectMode(!selectModeActive);
  });
  document.getElementById("bulkCancelBtn").addEventListener("click", function(){
    setSelectMode(false);
  });

  document.getElementById("logBody").addEventListener("change", function(ev){
    var box = ev.target.closest(".row-select");
    if(!box) return;
    var id = box.getAttribute("data-id");
    if(box.checked) selectedEntryIds.add(id); else selectedEntryIds.delete(id);
    updateBulkToolbar();
  });

  document.getElementById("bulkSelectAll").addEventListener("change", function(){
    var checked = this.checked;
    document.querySelectorAll("#logBody .row-select").forEach(function(box){
      box.checked = checked;
      if(checked) selectedEntryIds.add(box.getAttribute("data-id"));
      else selectedEntryIds.delete(box.getAttribute("data-id"));
    });
    updateBulkToolbar();
  });

  document.getElementById("bulkDeleteBtn").addEventListener("click", async function(){
    var ids = Array.from(selectedEntryIds);
    if(!ids.length) return;
    var confirmed = await showConfirm(
      "Delete " + ids.length + " selected entr" + (ids.length===1?"y":"ies") + "? This can't be undone.",
      {title:"Delete selected entries?", danger:true, confirmText:"Delete " + ids.length}
    );
    if(!confirmed) return;

    var btn = this;
    btn.disabled = true;
    btn.textContent = "Deleting " + ids.length + "…";
    beginBulkOperation();
    // One request instead of one per row.
    var delErr = null;
    try{
      var res = await supabase.from("entries").delete().in("id", ids);
      if(res.error) throw res.error;
    }catch(err){ delErr = err; }
    endBulkOperation();
    btn.disabled = false;
    btn.textContent = "Delete Selected";
    if(editingId && ids.indexOf(editingId) !== -1) resetForm();
    setSelectMode(false);
    await loadDataForViewedUser();
    if(delErr) showToast("Couldn't delete those entries: " + friendlyError(delErr), "error");
    else showToast("Deleted " + ids.length + " entr" + (ids.length===1?"y":"ies") + ".", "success");
  });

  // ---------- Quick clock ----------
  function nowTimeStr(){
    var d = new Date();
    return pad2(d.getHours())+":"+pad2(d.getMinutes());
  }
  function updateLiveClock(){
    var d = new Date();
    var h = d.getHours();
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if(h12 === 0) h12 = 12;
    var timeStr = h12 + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + " " + period;
    document.getElementById("liveClock").textContent = timeStr;
    document.getElementById("liveDate").textContent = fmtDateLong(todayStr());
    var stickyTime = document.getElementById("stickyClockTime");
    if(stickyTime) stickyTime.textContent = h12 + ":" + pad2(d.getMinutes()) + " " + period;
  }
  function showQcNote(msg, success){
    var el = document.getElementById("qcStatusNote");
    el.textContent = msg;
    el.className = "qc-note" + (success ? " success" : "");
    void el.offsetWidth; // force reflow so back-to-back punches re-trigger the fade
    el.classList.add("pulse");
  }

  // The one-shot "confirmed" beat on the seal, separate from its ambient
  // idle glow — removing the class after the animation ends lets a repeat
  // punch (e.g. clock out shortly after clock in) retrigger it cleanly.
  function pulseSeal(){
    var seal = document.getElementById("todaySeal");
    if(!seal) return;
    seal.classList.remove("punched");
    void seal.offsetWidth;
    seal.classList.add("punched");
  }

  // Disabled buttons only stop taps, and punchClock is also reachable
  // programmatically (see the quick-clock dispatch further up). The buttons
  // are the visual affordance; this flag is the actual lock that serialises
  // punches — it also survives loadDataForViewedUser() calling
  // updateViewingBanner(), which re-enables every clock control before the
  // finally block runs.
  var punchInFlight = false;

  async function punchClock(kind){
    if(punchInFlight) return;
    if(!isOwnData){
      showToast("Switch back to \"Viewing: Me\" to clock in or out — you can only punch your own clock.", "error");
      return;
    }
    var today = todayStr();
    var timeNow = nowTimeStr();
    var field = kind === "in" ? "clockIn" : "clockOut";
    var existing = entries.find(function(x){ return x.date === today; });

    if(existing && existing[field]){
      if(!(await showConfirm("You already clocked "+kind+" today at "+formatTime12(existing[field])+". Replace it with "+formatTime12(timeNow)+"?", {confirmText:"Replace"}))) return;
    }

    var payload = existing
      ? {date: today, clockIn: existing.clockIn, clockOut: existing.clockOut, type: existing.type, note: existing.note}
      : {date: today, clockIn: "", clockOut: "", type: "regular", note: ""};
    payload[field] = timeNow;

    // Every clock control calls this same function — desktop quick-clock,
    // the sticky mobile bar, and the bottom nav's smart button — so all of
    // them need to be guarded against a double-tap firing overlapping calls,
    // not just the desktop pair.
    var clockBtns = [
      document.getElementById("clockInBtn"), document.getElementById("clockOutBtn"),
      document.getElementById("stickyClockInBtn"), document.getElementById("stickyClockOutBtn"),
      document.getElementById("bnClockBtn")
    ].filter(Boolean);
    // Set only now, after the "replace it?" confirmation has resolved — an
    // open modal must never leave the flag wedged on.
    punchInFlight = true;
    clockBtns.forEach(function(b){ b.disabled = true; });
    var bnClockBtnEl = document.getElementById("bnClockBtn");
    if(bnClockBtnEl) bnClockBtnEl.classList.add("disabled");
    try{
      var saved = await sbUpsertEntry(currentUser.id, payload, existing ? existing.id : null);
      if(kind === "in"){ delete dismissedReminders[today]; persistDismissals(); }

      if(editingId === (existing && existing.id)){
        document.getElementById(kind === "in" ? "fIn" : "fOut").value = timeNow;
      } else if(!editingId && document.getElementById("fDate").value === today){
        document.getElementById(kind === "in" ? "fIn" : "fOut").value = timeNow;
      }

      await loadDataForViewedUser();
      pulseSeal();

      var msg = "Clocked " + kind + " at " + formatTime12(timeNow) + " · " + fmtDate(today);
      if(kind === "out"){
        var c = computeEntry(saved);
        if(c.workedMin !== null) msg += " · " + minutesToHoursStr(c.workedMin) + " worked";
      }
      showQcNote(msg, true);
    }catch(err){
      showToast("Couldn't record that: " + friendlyError(err), "error");
    }finally{
      punchInFlight = false;
      clockBtns.forEach(function(b){ b.disabled = false; });
      if(bnClockBtnEl) bnClockBtnEl.classList.remove("disabled");
    }
  }

  document.getElementById("clockInBtn").addEventListener("click", function(){ punchClock("in"); });
  document.getElementById("clockOutBtn").addEventListener("click", function(){ punchClock("out"); });
  document.getElementById("stickyClockInBtn").addEventListener("click", function(){ punchClock("in"); });
  document.getElementById("stickyClockOutBtn").addEventListener("click", function(){ punchClock("out"); });

  // The bottom nav has one smart button instead of separate In/Out buttons —
  // it shows whichever action makes sense given today's entry, and simply
  // calls the same punchClock() used everywhere else (including its
  // existing "already clocked in, replace?" confirmation).
  var BN_CLOCK_IN_PATH = 'M5 12h11M12 5l7 7-7 7';
  var BN_CLOCK_OUT_PATH = 'M19 12H8M11 5l-7 7 7 7';
  function renderBnClock(todayEntry){
    var btn = document.getElementById("bnClockBtn");
    if(!btn) return;
    var icon = document.getElementById("bnClockIcon");
    var label = document.getElementById("bnClockLabel");
    var isOpen = !!(todayEntry && todayEntry.clockIn && !todayEntry.clockOut);

    btn.classList.toggle("clocked-in", isOpen);
    label.textContent = isOpen ? "Clock Out" : "Clock In";
    icon.innerHTML = '<path d="'+(isOpen ? BN_CLOCK_OUT_PATH : BN_CLOCK_IN_PATH)+'"/>';
    btn.setAttribute("data-bn-action", isOpen ? "out" : "in");
    btn.classList.toggle("disabled", !isOwnData);
  }
  document.getElementById("bnClockBtn").addEventListener("click", function(){
    if(this.classList.contains("disabled")) return;
    punchClock(this.getAttribute("data-bn-action") || "in");
  });

  // The sticky bar only appears once the main punch card has scrolled out of
  // view. It also steps aside whenever Settings is open, since clocking in
  // isn't the point of that screen and the bar would just compete for the
  // same bottom-of-screen space as the panel's own buttons.
  var stickyClockEl = document.getElementById("stickyClock");
  var mainQuickClockEl = document.querySelector(".quick-clock");
  var mainClockCurrentlyVisible = true;
  function updateStickyClockVisibility(){
    var settingsOpen = document.getElementById("settingsCard").classList.contains("open");
    stickyClockEl.classList.toggle("show", !mainClockCurrentlyVisible && isOwnData && !settingsOpen);
  }
  if(stickyClockEl && mainQuickClockEl && "IntersectionObserver" in window){
    var stickyObserver = new IntersectionObserver(function(entriesList){
      mainClockCurrentlyVisible = entriesList[0].isIntersecting;
      updateStickyClockVisibility();
    }, {threshold: 0});
    stickyObserver.observe(mainQuickClockEl);
  }

  // ---------- Tabs & filters ----------
  // Fades the tab bar's edges when there's more to scroll to, so a
  // horizontally-scrolling tab list doesn't look like it just... stops.
  function updateTabsScrollHint(){
    var bar = document.getElementById("tabsBar");
    var wrap = bar && bar.closest(".tabs-wrap");
    if(!bar || !wrap) return;
    wrap.classList.toggle("can-scroll-left", bar.scrollLeft > 4);
    wrap.classList.toggle("can-scroll-right", bar.scrollLeft < bar.scrollWidth - bar.clientWidth - 4);
  }
  var tabsBarEl = document.getElementById("tabsBar");
  if(tabsBarEl){
    tabsBarEl.addEventListener("scroll", updateTabsScrollHint);
    window.addEventListener("resize", updateTabsScrollHint);
  }

  // Shows the right filter bar(s) for whichever tab — and, for Trends,
  // whichever period sub-view — is currently active.
  function applyFilterBarVisibility(tab, subtab){
    document.getElementById("monthFilterWrap").style.display =
      (tab === "log" || (tab === "trends" && subtab === "weekly")) ? "flex" : "none";
    document.getElementById("searchFilterWrap").style.display = (tab === "log") ? "flex" : "none";
    if(tab !== "log"){
      document.getElementById("advancedFiltersPanel").style.display = "none";
      document.getElementById("advancedFiltersToggle").classList.remove("active");
    }
    document.getElementById("monthlyFilterWrap").style.display =
      (tab === "trends" && subtab === "monthly") ? "flex" : "none";
    document.getElementById("yearFilterWrap").style.display =
      (tab === "trends" && subtab === "yearly") ? "flex" : "none";
    document.getElementById("punctFilterWrap").style.display = (tab === "punctuality") ? "flex" : "none";
    document.getElementById("trendsSubTabs").style.display = (tab === "trends") ? "flex" : "none";
  }

  function renderSubtab(subtab){
    if(subtab === "weekly") renderWeekly();
    if(subtab === "monthly") renderMonthly();
    if(subtab === "yearly") renderYearly();
  }

  document.querySelectorAll(".sub-tab-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll(".sub-tab-btn").forEach(function(b){ b.classList.remove("active"); });
      document.querySelectorAll(".sub-tab-panel").forEach(function(p){ p.classList.remove("active"); });
      btn.classList.add("active");
      var subtab = btn.getAttribute("data-subtab");
      document.getElementById("subtab-"+subtab).classList.add("active");
      applyFilterBarVisibility("trends", subtab);
      renderSubtab(subtab);
    });
  });

  function activeSubtab(){
    var el = document.querySelector(".sub-tab-btn.active");
    return el ? el.getAttribute("data-subtab") : "weekly";
  }

  // Distributes the bottom-nav items into left/right zones so spacing stays
  // genuinely even regardless of admin status: an even visible count splits
  // equally; an odd count gives each side ceil(n/2) equal-width slots,
  // padding the shorter side with an invisible spacer of the same width
  // rather than letting its one real item float alone in extra space.
  function layoutBottomNav(){
    var leftEl = document.getElementById("bnSideLeft");
    var rightEl = document.getElementById("bnSideRight");
    if(!leftEl || !rightEl) return;

    document.querySelectorAll("#bottomNav .bn-spacer").forEach(function(s){ s.remove(); });

    // Admin is deliberately absent: it moved to the header, which is on screen
    // on phones too, and leaving it here would push the nav past six slots and
    // knock the centred clock button off balance.
    //
    // Every tab is listed, including Overview, which now leads. That is six
    // slots for an admin and the labels get tight at 320px — but the rail is
    // hidden below 760px and the tab strip with it, so anything dropped here
    // would be unreachable on a phone entirely rather than merely crowded.
    var order = ["overview", "log", "trends", "calendar", "punctuality"]
      .concat(isAdmin ? ["team"] : []);

    // Return anything no longer in scope to the hidden pool FIRST. Without this,
    // an admin who demoted themselves kept Team and Admin sitting in the visible
    // nav — the desktop tab bar hid them correctly, but this only ever appended
    // the in-scope items and never removed the others. Tapping one then clicked
    // a hidden tab button and produced an "Only admins can…" error toast, and the
    // stray slots broke the left/right split that keeps the clock centred.
    var pool = document.getElementById("bnItemPool");
    if(pool){
      document.querySelectorAll("#bottomNav .bn-item").forEach(function(el){
        if(order.indexOf(el.getAttribute("data-bn-tab")) === -1) pool.appendChild(el);
      });
    }

    var items = order.map(function(tab){
      return document.querySelector('.bn-item[data-bn-tab="'+tab+'"]');
    }).filter(Boolean);

    var n = items.length;
    var leftCount = Math.ceil(n / 2);

    items.forEach(function(el, i){
      (i < leftCount ? leftEl : rightEl).appendChild(el); // moves the node; listeners survive
    });

    if(n % 2 !== 0){
      var spacer = document.createElement("div");
      spacer.className = "bn-spacer";
      spacer.setAttribute("aria-hidden", "true");
      rightEl.appendChild(spacer);
    }
  }

  // One activation path for every control that can open a panel: the tab strip,
  // the mobile bottom nav, and the header's Admin button — which is not a tab at
  // all, since managing the organisation is not a view of your own attendance.
  function activateTab(tab){
    var panel = document.getElementById("tab-" + tab);
    if(!panel) return;

    document.querySelectorAll(".tab-btn").forEach(function(b){
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", on);
      // The active tab was previously conveyed by a CSS class alone, so
      // assistive tech could not tell which of the tabs was selected.
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function(p){ p.classList.remove("active"); });
    panel.classList.add("active");

    // Admin lives outside the tablist, so its own trigger carries the state.
    var adminBtn = document.getElementById("adminBtn");
    if(adminBtn) adminBtn.setAttribute("aria-current", tab === "admin" ? "page" : "false");

    // Overview lives outside #tabContentCard so its own cards sit on the
    // canvas rather than nesting inside one big card. That means the card
    // wrapper has to be hidden when Overview is the active tab, or an empty
    // white panel is left standing under it.
    var tabCard = document.getElementById("tabContentCard");
    if(tabCard) tabCard.hidden = (tab === "overview");

    applyFilterBarVisibility(tab, activeSubtab());

    if(tab === "overview"){
      renderStats();
      renderPersonCard();
      renderWorkingFormat();
      renderTodayTeam().catch(function(){});
      // After the panel is displayed, or the measurement reads a hidden node.
      fitOverview();
    }
    if(tab === "trends") renderSubtab(activeSubtab());
    if(tab === "calendar") renderCalendarView();
    if(tab === "punctuality") renderPunctuality();
    if(tab === "team") renderTeam();
    if(tab === "admin") renderAdmin();

    document.querySelectorAll(".bn-item").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-bn-tab") === tab);
    });
    // The rail mirrors the same active state. Admin is not a tab, so it is
    // matched on its action attribute rather than data-rail-tab. aria-current
    // carries the state to assistive tech: the rail is a plain <nav>, not a
    // tablist, and the real tab strip it delegates to is display:none, so the
    // active class alone would be invisible to a screen reader.
    document.querySelectorAll(".rail-item").forEach(function(b){
      var isTab = b.getAttribute("data-rail-tab") === tab;
      var isAdmin = b.getAttribute("data-rail-action") === "admin" && tab === "admin";
      var on = isTab || isAdmin;
      b.classList.toggle("active", on);
      if(on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  }

  document.querySelectorAll(".tab-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      activateTab(btn.getAttribute("data-tab"));
    });
  });

  // The rail is the same thin layer over the real controls that the bottom nav
  // is: a tab item clicks its .tab-btn, and the two destinations that are not
  // tabs (Admin, Settings) click their own existing header buttons, so their
  // admin guards and scroll behaviour are not duplicated here.
  document.querySelectorAll(".rail-item").forEach(function(btn){
    btn.addEventListener("click", function(){
      var action = btn.getAttribute("data-rail-action");
      if(action === "admin"){
        document.getElementById("adminBtn").click();
        return;
      }
      if(action === "settings"){
        document.getElementById("settingsBtn").click();
        return;
      }
      var realTab = document.querySelector('.tab-btn[data-tab="'+btn.getAttribute("data-rail-tab")+'"]');
      if(realTab) realTab.click();
    });
  });

  // Bottom nav items are a thin visual layer over the existing tab-btns —
  // clicking one just clicks the real tab button, so every render/filter/
  // admin rule above applies identically regardless of which control was used.
  document.querySelectorAll(".bn-item").forEach(function(btn){
    btn.addEventListener("click", function(){
      var tab = btn.getAttribute("data-bn-tab");
      var realTab = document.querySelector('.tab-btn[data-tab="'+tab+'"]');
      if(realTab) realTab.click();
      // Scroll to where the tab content actually lives, not the page's
      // absolute top — jumping to the very top just shows the header/hero
      // again, forcing a second manual scroll to see what was tapped for.
      // Instant, not smooth: an animated scroll takes time to settle, and
      // during that time whatever content is scrolling past visibly slides
      // behind the fixed nav. A tab switch should feel immediate.
      var target = document.getElementById("tabContentCard");
      if(target && target.hidden) target = document.getElementById("tab-overview");
      if(target){
        var top = target.getBoundingClientRect().top + window.scrollY - 12;
        window.scrollTo(0, Math.max(0, top));
      } else {
        window.scrollTo(0, 0);
      }
    });
  });

  document.getElementById("logYearSelect").addEventListener("change", function(){
    populateFilters();   // month list depends on the chosen year
    renderLog();
    renderWeekly();
  });
  document.getElementById("monthFilterSelect").addEventListener("change", function(){
    renderLog();
    renderWeekly();
  });
  document.getElementById("monthlyYearSelect").addEventListener("change", renderMonthly);

  document.getElementById("punctYearSelect").addEventListener("change", function(){
    populatePunctFilters();   // month list depends on the chosen year
    renderPunctuality();
  });
  document.getElementById("punctMonthSelect").addEventListener("change", renderPunctuality);

  // Search bar: re-filter the log as the person types or narrows the range.
  ["searchInput","typeFilterSelect","fromDate","toDate"].forEach(function(id){
    var el = document.getElementById(id);
    el.addEventListener(id === "searchInput" ? "input" : "change", function(){
      logVisibleCount = LOG_PAGE_SIZE;
      renderLog();
      updateAdvancedFilterBadge();
    });
  });

  function updateAdvancedFilterBadge(){
    var count = 0;
    if(document.getElementById("typeFilterSelect").value !== "all") count++;
    if(document.getElementById("fromDate").value) count++;
    if(document.getElementById("toDate").value) count++;
    var badge = document.getElementById("advancedFilterBadge");
    badge.textContent = count;
    badge.style.display = count ? "inline-flex" : "none";
  }

  document.getElementById("advancedFiltersToggle").addEventListener("click", function(){
    var panel = document.getElementById("advancedFiltersPanel");
    var opening = panel.style.display === "none";
    panel.style.display = opening ? "flex" : "none";
    this.classList.toggle("active", opening);
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", function(){
    document.getElementById("searchInput").value = "";
    document.getElementById("typeFilterSelect").value = "all";
    document.getElementById("fromDate").value = "";
    document.getElementById("toDate").value = "";
    document.getElementById("logYearSelect").value = "all";
    document.getElementById("monthFilterSelect").value = "all";
    populateFilters();
    renderLog();
    renderWeekly();
    updateAdvancedFilterBadge();
  });
  document.getElementById("yearFilterSelect").addEventListener("change", renderYearly);

  // ---------- Export / import ----------
  function download(filename, content, mime){
    var blob = new Blob([content], {type:mime});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportJson(){
    download("attendance-backup-"+todayStr()+".json",
      JSON.stringify({version:3, settings:settings, entries:entries}, null, 2), "application/json");
    markBackedUp();
  }
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);

  document.getElementById("exportCsvBtn").addEventListener("click", function(){
    var rows = [["Date","Day","Clock In","Clock Out","Worked (h)","Target (h)","Diff (h)","Late (min)","Early (min)","Type","Note"]];
    entries.slice().sort(function(a,b){ return a.date.localeCompare(b.date); }).forEach(function(e){
      var c = computeEntry(e);
      rows.push([
        e.date, DAY_NAMES[dateFromStr(e.date).getDay()],
        formatTime12(e.clockIn), formatTime12(e.clockOut),
        c.workedMin !== null ? (c.workedMin/60).toFixed(2) : "",
        (c.targetMin/60).toFixed(2),
        c.diffMin !== null ? (c.diffMin/60).toFixed(2) : "",
        c.lateMin || "", c.earlyMin || "",
        typeLabel(e.type), e.note || ""
      ]);
    });
    var csv = rows.map(function(r){
      return r.map(function(v){
        v = String(v == null ? "" : v);
        return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
      }).join(",");
    }).join("\n");
    download("attendance-export-"+todayStr()+".csv", csv, "text/csv");
    markBackedUp();
  });

  // A blank starter file with only the columns importCsvText() actually
  // reads (Date, Clock In, Clock Out, Type, Note) — Export CSV's own file
  // carries several read-only computed columns (Worked, Target, Diff…) that
  // would just confuse someone building a file to import. The example rows
  // double as documentation for the Type column's short codes, since a
  // spreadsheet opens straight into them.
  document.getElementById("csvTemplateBtn").addEventListener("click", function(){
    var base = dateFromStr(todayStr());
    function day(offset){ var d = new Date(base); d.setDate(d.getDate()+offset); return dateToStr(d); }
    var rows = [
      ["Date","Clock In","Clock Out","Type","Note"],
      [day(1), "08:00", "16:00", "Regular", ""],
      [day(2), "", "", "s", "Type code 's' = Sick Leave"],
      [day(3), "", "", "h", "Type code 'h' = Public Holiday"],
      [day(4), "08:00", "12:00", "hd", "Type code 'hd' = Half Day Leave"],
      [day(5), "", "", "l", "Type code 'l' = Annual Leave"],
      [day(8), "08:00", "16:00", "WFH", "Full words work too, e.g. WFH"]
    ];
    var csv = rows.map(function(r){ return r.map(csvCell).join(","); }).join("\r\n");
    download("attendance-import-template.csv", csv, "text/csv;charset=utf-8");
    showToast("Template downloaded. Type accepts a full word or short code: s/h/hd/l.", "success");
  });

  // ---------- CSV import ----------
  // Splits CSV text into rows of cells, honouring quoted fields, escaped
  // double-quotes, embedded newlines, and CRLF line endings.
  function parseCsv(text){
    var rows = [], row = [], cell = "", inQuotes = false;
    text = text.replace(/^\uFEFF/, ""); // strip BOM Excel likes to add
    for(var i=0;i<text.length;i++){
      var ch = text[i];
      if(inQuotes){
        if(ch === '"'){
          if(text[i+1] === '"'){ cell += '"'; i++; }
          else inQuotes = false;
        } else cell += ch;
      } else if(ch === '"'){
        inQuotes = true;
      } else if(ch === ","){
        row.push(cell); cell = "";
      } else if(ch === "\n" || ch === "\r"){
        if(ch === "\r" && text[i+1] === "\n") i++;
        row.push(cell); cell = "";
        rows.push(row); row = [];
      } else cell += ch;
    }
    if(cell.length || row.length){ row.push(cell); rows.push(row); }
    // Drop rows that are entirely blank
    return rows.filter(function(r){ return r.some(function(v){ return String(v).trim() !== ""; }); });
  }

  // Real days in a given month, leap years included — new Date(y,mo,0) rolls
  // back to the last day of the *previous* month index, i.e. month mo (1-12).
  function daysInMonth(y, mo){ return new Date(y, mo, 0).getDate(); }

  // Accepts "2026-08-09", "9/8/2026", "Aug 9, 2026" etc. Returns "YYYY-MM-DD" or "".
  // dayFirst decides D/M vs M/D when both numbers could be a month.
  function parseDateCell(v, dayFirst){
    v = String(v || "").trim();
    if(!v) return "";
    var iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if(iso){
      var y=+iso[1], mo=+iso[2], da=+iso[3];
      if(mo<1||mo>12||da<1||da>daysInMonth(y,mo)) return "";
      return y+"-"+pad2(mo)+"-"+pad2(da);
    }
    var slash = v.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
    if(slash){
      var a=+slash[1], b=+slash[2], yr=+slash[3], month, day;
      if(a > 12){ day=a; month=b; }        // first can't be a month
      else if(b > 12){ month=a; day=b; }   // second can't be a month
      else if(dayFirst){ day=a; month=b; } // genuinely ambiguous
      else { month=a; day=b; }
      if(month<1||month>12||day<1||day>daysInMonth(yr,month)) return "";
      return yr+"-"+pad2(month)+"-"+pad2(day);
    }
    var d = new Date(v);
    if(!isNaN(d.getTime())) return dateToStr(d);
    return "";
  }

  // True when a slash/dotted date could read either as D/M or M/D.
  function isAmbiguousDate(v){
    var m = String(v || "").trim().match(/^(\d{1,2})[\/.](\d{1,2})[\/.]\d{4}$/);
    return !!m && +m[1] <= 12 && +m[2] <= 12 && +m[1] !== +m[2];
  }

  // Accepts "8:00 AM", "08:00", "8:00am", "16:00", "4 PM", "3:00:00 PM",
  // "8.00 AM" (period separator), "0800"/"800" (compact, no separator),
  // "16" (bare hour), and Excel's raw day-fraction decimals if a time cell
  // wasn't formatted before export. Returns "HH:MM" or "".
  function parseTimeCell(v){
    v = String(v || "").trim();
    if(!v || v === "—" || v === "-") return "";

    if(/^0?\.\d+$/.test(v)){
      var totalMin = Math.round(parseFloat(v) * 24 * 60);
      if(totalMin >= 0 && totalMin < 24*60) return pad2(Math.floor(totalMin/60))+":"+pad2(totalMin%60);
      return "";
    }

    // 12-hour with AM/PM. Colon or period as the minute separator; seconds
    // (colon- or period-separated) are optional and ignored.
    var m = v.match(/^(\d{1,2})(?:[:.](\d{2}))?(?:[:.]\d{2})?\s*([AaPp])\.?[Mm]\.?$/);
    if(m){
      var rawH = +m[1], mins = m[2] || "00";
      if(rawH < 1 || rawH > 12 || +mins > 59) return "";
      var h = rawH % 12;
      if(m[3].toLowerCase() === "p") h += 12;
      return pad2(h)+":"+mins;
    }

    // 24-hour, colon or period as separator, seconds optional and ignored.
    m = v.match(/^(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?$/);
    if(m){
      var hh = +m[1];
      if(hh > 23 || +m[2] > 59) return "";
      return pad2(hh)+":"+m[2];
    }

    // Compact 24-hour with no separator at all: "800", "0800", "1630".
    m = v.match(/^(\d{3,4})$/);
    if(m){
      var digits = m[1];
      var hh2 = digits.length === 3 ? +digits.slice(0,1) : +digits.slice(0,2);
      var mm2 = digits.length === 3 ? digits.slice(1) : digits.slice(2);
      if(hh2 > 23 || +mm2 > 59) return "";
      return pad2(hh2)+":"+mm2;
    }

    // Bare hour only, 24-hour, no separator or AM/PM suffix: "8", "16".
    m = v.match(/^(\d{1,2})$/);
    if(m){
      var hh3 = +m[1];
      if(hh3 > 23) return "";
      return pad2(hh3)+":00";
    }

    return "";
  }

  // Maps a label like "Annual Leave", "WFH", "sick" back to its internal key.
  // Single/two-letter shorthand a spreadsheet or another system's export
  // might use instead of a full word. Checked as an exact match only — "s"
  // and "h" are too short to safely guess from a substring the way "sick" or
  // "holiday" can below.
  var TYPE_SHORTHAND = {s:"sick", h:"holiday", hd:"halfleave", l:"leave"};
  function parseTypeCell(v){
    v = String(v || "").trim().toLowerCase();
    if(!v) return "regular";
    if(TYPE_LABELS[v]) return v;
    var found = Object.keys(TYPE_LABELS).find(function(k){
      return TYPE_LABELS[k].toLowerCase() === v;
    });
    if(found) return found;
    if(TYPE_SHORTHAND[v]) return TYPE_SHORTHAND[v];
    if(v.indexOf("home") !== -1 || v === "wfh") return "wfh";
    if(v.indexOf("half") !== -1) return "halfleave";
    if(v.indexOf("annual") !== -1 || v === "leave" || v.indexOf("vacation") !== -1) return "leave";
    if(v.indexOf("sick") !== -1) return "sick";
    if(v.indexOf("trip") !== -1 || v.indexOf("business") !== -1) return "trip";
    if(v.indexOf("training") !== -1 || v.indexOf("course") !== -1) return "training";
    if(v.indexOf("holiday") !== -1) return "holiday";
    return "regular";
  }

  // Finds a column index by trying each candidate name against the header row.
  function findCol(headers, candidates){
    for(var i=0;i<candidates.length;i++){
      var idx = headers.indexOf(candidates[i]);
      if(idx !== -1) return idx;
    }
    return -1;
  }

  async function importCsvText(text){
    if(!isOwnData){
      showToast("Switch back to \"Viewing: Me\" before importing — you can only import into your own attendance.", "error");
      return;
    }
    var rows = parseCsv(text);
    if(rows.length < 2){
      showToast("That file has no data rows. Expected a header row plus at least one day.", "error");
      return;
    }

    var headers = rows[0].map(function(h){ return String(h).trim().toLowerCase(); });
    var cDate  = findCol(headers, ["date","day date","work date"]);
    var cIn    = findCol(headers, ["clock in","in","start","time in","start time"]);
    var cOut   = findCol(headers, ["clock out","out","end","time out","end time"]);
    var cType  = findCol(headers, ["type","day type","category"]);
    var cNote  = findCol(headers, ["note","notes","comment","comments","remarks"]);

    if(cDate === -1){
      showToast("Couldn't find a Date column. The header row needs a column named \"Date\" — the easiest fix is to export a CSV from this page first and match its columns.", "error");
      return;
    }

    // Resolve D/M vs M/D once, up front, instead of guessing per row.
    var dayFirst = false;
    var sample = null;
    for(var s=1;s<rows.length;s++){
      var raw = cDate < rows[s].length ? rows[s][cDate] : "";
      if(isAmbiguousDate(raw)){ sample = String(raw).trim(); break; }
    }
    if(sample){
      var parts = sample.split(/[\/.]/);
      dayFirst = await showConfirm(
        "This file has dates like \"" + sample + "\" that could be read two ways. Pick the order it's actually in.",
        {
          title: "Which date order is this?",
          confirmText: (+parts[0]) + "/" + (+parts[1]) + " = Day/Month",
          cancelText: (+parts[0]) + "/" + (+parts[1]) + " = Month/Day"
        }
      );
    }

    var parsed = [], skipped = 0;
    var seen = {};
    for(var r=1;r<rows.length;r++){
      var row = rows[r];
      var cell = function(i){ return i !== -1 && i < row.length ? row[i] : ""; };
      var date = parseDateCell(cell(cDate), dayFirst);
      if(!date){ skipped++; continue; }

      var rec = {
        date: date,
        clockIn: parseTimeCell(cell(cIn)),
        clockOut: parseTimeCell(cell(cOut)),
        type: parseTypeCell(cell(cType)),
        note: String(cell(cNote) || "").trim()
      };
      // A later row for the same date wins, matching the "last write" rule elsewhere.
      if(seen[date] !== undefined) parsed[seen[date]] = rec;
      else { seen[date] = parsed.length; parsed.push(rec); }
    }

    if(!parsed.length){
      showToast("No rows had a readable date, so nothing was imported. Dates should look like 2026-08-09 or 09/08/2026.", "error");
      return;
    }

    var replacing = parsed.filter(function(p){
      return entries.some(function(e){ return e.date === p.date; });
    }).length;

    var msg = "Found " + parsed.length + " day" + (parsed.length===1?"":"s") + " to import.";
    if(replacing) msg += "\n" + replacing + " will replace a day you've already logged.";
    if(skipped) msg += "\n" + skipped + " row" + (skipped===1?"":"s") + " skipped (no readable date).";
    msg += "\n\nImport now?";
    if(!(await showConfirm(msg, {confirmText:"Import"}))) return;

    // Progress is shown in a toast, not in #qcStatusNote — that note lives in the
    // New Entry card at the top of the page while the Import buttons are in the
    // footer, so importing from the footer produced no visible feedback at all
    // for the entire run.
    showToast("Importing " + parsed.length + " day" + (parsed.length===1?"":"s") + "…", "info");
    beginBulkOperation();
    var imported = 0, bulkErr = null;
    try{
      imported = await sbBulkUpsertEntries(parsed.map(function(rec2){
        return entryToRow(rec2, currentUser.id);
      }));
      parsed.forEach(function(rec2){ delete dismissedReminders[rec2.date]; });
      persistDismissals();
    }catch(err){ bulkErr = err; }
    endBulkOperation();

    await loadDataForViewedUser();
    if(bulkErr){
      showToast("Import failed: " + friendlyError(bulkErr) + " No days were changed.", "error");
    } else {
      showToast("Imported " + imported + " day" + (imported===1?"":"s") + " from CSV." +
        (skipped ? " " + skipped + " row" + (skipped===1?"":"s") + " skipped (no readable date)." : ""), "success");
    }
  }

  document.getElementById("importCsvBtn").addEventListener("click", function(){
    document.getElementById("importCsvFile").click();
  });
  document.getElementById("importCsvFile").addEventListener("change", function(ev){
    var file = ev.target.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      try{ importCsvText(String(reader.result)); }
      catch(err){ showToast("Couldn't read that file. Make sure it's a plain .csv file.", "error"); }
      ev.target.value = "";
    };
    reader.onerror = function(){
      showToast("Couldn't open that file.", "error");
      ev.target.value = "";
    };
    reader.readAsText(file);
  });

  document.getElementById("importBtn").addEventListener("click", function(){
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", function(ev){
    var file = ev.target.files[0];
    if(!file) return;
    if(!isOwnData){
      showToast("Switch back to \"Viewing: Me\" before importing — you can only import into your own attendance.", "error");
      ev.target.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = async function(){
      try{
        var data = JSON.parse(reader.result);
        // v1/v2 backups were a bare array or {entries}; v3 also carries settings.
        var incoming = Array.isArray(data) ? data : data.entries;
        if(!Array.isArray(incoming)) throw new Error("bad format");

        var proceed = await showConfirm(
          "Import "+incoming.length+" entries? Days already logged will be replaced by the imported version.",
          {confirmText:"Import"}
        );
        if(!proceed){
          document.getElementById("importFile").value = "";
          return;
        }

        var applySettings = false;
        if(isAdmin && !Array.isArray(data) && data.settings){
          applySettings = await showConfirm("This backup includes schedule settings. Use them too?", {confirmText:"Use them"});
        }

        // Every incoming record goes through the same parsers the CSV path uses.
        // Previously the JSON path wrote raw objects straight to the database
        // with no date, time, type or length validation, so a hand-edited or
        // third-party backup could permanently corrupt those days — an unknown
        // `type` renders as the literal text "undefined" everywhere it appears.
        var clean = [], rejected = 0;
        var seenDates = {};
        incoming.forEach(function(imp){
          if(!imp || typeof imp !== "object"){ rejected++; return; }
          var d = parseDateCell(imp.date, false);
          if(!d){ rejected++; return; }
          var rec = {
            date: d,
            clockIn: parseTimeCell(imp.clockIn || imp.clock_in),
            clockOut: parseTimeCell(imp.clockOut || imp.clock_out),
            type: parseTypeCell(imp.type),
            note: String(imp.note == null ? "" : imp.note).slice(0, 500)
          };
          if(seenDates[d] !== undefined) clean[seenDates[d]] = rec;
          else { seenDates[d] = clean.length; clean.push(rec); }
        });

        if(!clean.length){
          showToast("None of those entries had a readable date, so nothing was imported.", "error");
          document.getElementById("importFile").value = "";
          return;
        }

        showToast("Importing " + clean.length + " entr" + (clean.length===1?"y":"ies") + "…", "info");
        beginBulkOperation();
        var done = 0, jsonErr = null;
        try{
          done = await sbBulkUpsertEntries(clean.map(function(r){ return entryToRow(r, currentUser.id); }));
          clean.forEach(function(r){ delete dismissedReminders[r.date]; });
          persistDismissals();
          if(applySettings){
            await sbSaveSettings(viewedUserId, normalizeSettings(data.settings));
          }
        }catch(err){ jsonErr = err; }
        endBulkOperation();

        await loadDataForViewedUser();
        if(jsonErr){
          showToast("Import failed: " + friendlyError(jsonErr), "error");
        } else {
          showToast("Imported " + done + " entr" + (done===1?"y":"ies") + "." +
            (rejected ? " " + rejected + " skipped (unreadable)." : ""), "success");
        }
      }catch(err){
        showToast("Couldn't read that file. Choose a JSON backup exported from this page.", "error");
      }
      document.getElementById("importFile").value = "";
    };
    reader.readAsText(file);
  });

  document.getElementById("clearAllBtn").addEventListener("click", async function(){
    if(!isOwnData){
      showToast("You can only clear your own attendance data from here.", "error");
      return;
    }
    var step1 = await showConfirm(
      "This permanently deletes every attendance entry in your account. Export a backup first if you want to keep them.",
      {title:"Clear all attendance data?", danger:true, confirmText:"Continue"}
    );
    if(!step1) return;
    var step2 = await showConfirm(
      "Delete all "+entries.length+" entries? This can't be undone.",
      {title:"Last check", danger:true, confirmText:"Delete Everything"}
    );
    if(!step2) return;
    try{
      await sbDeleteAllEntries(currentUser.id);
      dismissedReminders = {};
      persistDismissals();
      resetForm();
      await loadDataForViewedUser();
      showToast("All attendance entries have been deleted.", "success");
    }catch(err){
      showToast("Couldn't clear your entries: " + friendlyError(err), "error");
    }
  });

  // ---------- Auth screen ----------
  function showAuthScreen(){
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("appShell").style.display = "none";
  }
  function showApp(){
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("appShell").style.display = "block";
  }
  function setAuthMsg(id, msg){
    var el = document.getElementById(id);
    if(el) el.textContent = msg || "";
  }

  // The email link Supabase sends signs the browser into a short-lived
  // "recovery" session and fires PASSWORD_RECOVERY (see the auth listener
  // below) rather than a normal SIGNED_IN. That session's user is stashed
  // here so the reset form can hand it straight to handleSignedIn() once the
  // new password is set, instead of making them log in a second time.
  var recoverySessionUser = null;
  function showResetPasswordScreen(){
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("appShell").style.display = "none";
    document.getElementById("signInForm").style.display = "none";
    document.getElementById("registerForm").style.display = "none";
    document.getElementById("resetPasswordForm").style.display = "flex";
    setAuthMsg("resetPasswordError", "");
  }

  if(!supabaseConfigured){
    document.getElementById("authConfigWarning").style.display = "block";
  }

  document.getElementById("showRegisterBtn").addEventListener("click", function(){
    document.getElementById("signInForm").style.display = "none";
    document.getElementById("registerForm").style.display = "flex";
    setAuthMsg("signInError", "");
  });
  document.getElementById("showSignInBtn").addEventListener("click", function(){
    document.getElementById("registerForm").style.display = "none";
    document.getElementById("signInForm").style.display = "flex";
    setAuthMsg("registerError", "");
    setAuthMsg("registerSuccess", "");
  });

  document.getElementById("signInForm").addEventListener("submit", async function(ev){
    ev.preventDefault();
    setAuthMsg("signInError", "");
    if(!supabaseConfigured){ setAuthMsg("signInError", "Backend isn't configured yet — see the notice above."); return; }
    var email = document.getElementById("siEmail").value.trim();
    var password = document.getElementById("siPassword").value;
    var btn = document.getElementById("signInBtn");
    btn.disabled = true; btn.textContent = "Signing in…";
    try{
      var res = await supabase.auth.signInWithPassword({email:email, password:password});
      if(res.error) throw res.error;
      // onAuthStateChange fires from here and finishes loading the app.
    }catch(err){
      setAuthMsg("signInError", err.message || "Couldn't sign in.");
    }finally{
      btn.disabled = false; btn.textContent = "Sign In";
    }
  });

  document.getElementById("forgotPasswordBtn").addEventListener("click", async function(){
    var email = document.getElementById("siEmail").value.trim();
    if(!email){ setAuthMsg("signInError", "Enter your email above, then tap this again."); return; }
    if(!supabaseConfigured){ setAuthMsg("signInError", "Backend isn't configured yet."); return; }
    try{
      // Without an explicit redirectTo, Supabase falls back to the project's
      // configured Site URL, which may point somewhere other than this exact
      // page — the emailed link then lands the user off the app entirely,
      // with no way back to the reset form. Pinning it to the current page
      // matches the admin-triggered reset a few hundred lines down.
      var res = await supabase.auth.resetPasswordForEmail(email, {redirectTo: window.location.href});
      if(res.error) throw res.error;
      setAuthMsg("signInError", "");
      showToast("If an account exists for " + email + ", a reset link has been sent.", "success");
    }catch(err){
      setAuthMsg("signInError", err.message || "Couldn't send reset email.");
    }
  });

  document.getElementById("resetPasswordForm").addEventListener("submit", async function(ev){
    ev.preventDefault();
    setAuthMsg("resetPasswordError", "");
    var pw = document.getElementById("newPassword").value;
    var pw2 = document.getElementById("newPassword2").value;
    if(pw !== pw2){ setAuthMsg("resetPasswordError", "Passwords don't match."); return; }
    if(pw.length < 10){ setAuthMsg("resetPasswordError", "Password must be at least 10 characters."); return; }

    var btn = document.getElementById("resetPasswordBtn");
    btn.disabled = true; btn.textContent = "Updating…";
    try{
      var res = await supabase.auth.updateUser({password: pw});
      if(res.error) throw res.error;
      showToast("Password updated.", "success");
      var u = recoverySessionUser || (res.data && res.data.user);
      recoverySessionUser = null;
      if(u) handleSignedIn(u); else showAuthScreen();
    }catch(err){
      setAuthMsg("resetPasswordError", err.message || "Couldn't update password.");
    }finally{
      btn.disabled = false; btn.textContent = "Set New Password";
    }
  });

  document.getElementById("registerForm").addEventListener("submit", async function(ev){
    ev.preventDefault();
    setAuthMsg("registerError", "");
    setAuthMsg("registerSuccess", "");
    if(!supabaseConfigured){ setAuthMsg("registerError", "Backend isn't configured yet — see the notice above."); return; }

    var name = document.getElementById("regName").value.trim();
    var email = document.getElementById("regEmail").value.trim();
    var pw = document.getElementById("regPassword").value;
    var pw2 = document.getElementById("regPassword2").value;
    if(pw !== pw2){ setAuthMsg("registerError", "Passwords don't match."); return; }
    if(pw.length < 10){ setAuthMsg("registerError", "Password must be at least 10 characters."); return; }

    var btn = document.getElementById("registerBtn");
    btn.disabled = true; btn.textContent = "Creating account…";
    try{
      var res = await supabase.auth.signUp({
        email: email, password: pw,
        options: { data: { full_name: name } }
      });
      if(res.error) throw res.error;
      if(res.data && res.data.session){
        // Email confirmation is off for this project — signed in immediately.
      } else {
        setAuthMsg("registerSuccess",
          "Account created. Check " + email + " for a confirmation link, then sign in.");
        document.getElementById("registerForm").reset();
      }
    }catch(err){
      setAuthMsg("registerError", err.message || "Couldn't create account.");
    }finally{
      btn.disabled = false; btn.textContent = "Create Account";
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async function(){
    await supabase.auth.signOut();
  });
  // The rail's sign-out control proxies to the real button above rather than
  // duplicating its logic — the same pattern .rail-item already uses for
  // Admin and Settings.
  document.getElementById("railLogoutBtn").addEventListener("click", function(){
    document.getElementById("logoutBtn").click();
  });

  // ---------- Admin: viewer switcher + Team tab ----------
  // ---------- Person card ----------
  // Whose record is on screen. For your own data that is you; when an admin
  // switches to someone else it becomes them, which makes the target of every
  // edit concrete rather than leaving it to the banner alone.
  function renderPersonCard(){
    var who = (!isOwnData && viewedProfile) ? viewedProfile : currentProfile;
    if(!who) return;
    var nameEl = document.getElementById("personName");
    if(!nameEl) return;

    nameEl.textContent = who.full_name || who.email;
    document.getElementById("personRole").textContent =
      (who.role === "admin" ? "Admin" : "Employee") + (isOwnData ? "" : " · viewing");

    // Photos are device-local, so only your own can ever be shown here — for
    // anyone else this always resolves to the monogram, which is why the
    // monogram is styled as a portrait rather than as a missing one.
    var media = document.getElementById("portraitMedia");
    var url = (currentUser && who.id === currentUser.id) ? localAvatar(who.id) : null;
    media.innerHTML = url
      ? '<img src="'+escapeAttr(url)+'" alt="">'
      : '<span class="portrait-mono" aria-hidden="true">'+
          escapeHtml(initialsOf(who.full_name || who.email))+'</span>';

    var st = teamStatus(entries, settings);
    var pill = document.getElementById("personStatus");
    pill.hidden = false;
    pill.className = "team-status " + st.cls;
    pill.textContent = st.label;
  }

  // ---------- Day types ----------
  // Every day type logged this month — Regular through Other, whatever
  // actually occurs — rather than the three worked-only buckets (Office/
  // Remote/Off-site) this replaced. A month of annual leave now shows as
  // 100% Annual Leave instead of reading as no data.
  //
  // One fixed colour per type, keyed off TYPE_LABELS so a legend entry is
  // never left unlabelled. Reuses existing tokens rather than inventing a
  // wider accent set: the three Fill-Only accents (mint/gold/blush) for the
  // types the old buckets already covered, then the status hues for the
  // rest, which read as loosely on-theme (sick=red, holiday=green) without
  // requiring the palette to grow.
  var DAY_TYPE_COLORS = {
    regular:"var(--mint)", wfh:"var(--gold)", halfleave:"var(--gold-light)",
    leave:"var(--blush)", sick:"var(--negative-solid)", trip:"var(--teal-600)",
    training:"var(--warn)", holiday:"var(--positive)", other:"var(--muted-2)"
  };

  // Largest-remainder rounding, so the shares always total 100. Rounding each
  // independently produced legends reading 34/33/34 and 33/33/33 for the very
  // same split, depending only on where the fractions fell.
  function pctSplit(counts, total){
    var raw = counts.map(function(c){ return (c / total) * 100; });
    var out = raw.map(function(v){ return Math.floor(v); });
    var short = 100 - out.reduce(function(a, b){ return a + b; }, 0);
    raw.map(function(v, i){ return {i:i, rem:v - Math.floor(v)}; })
       .sort(function(a, b){ return b.rem - a.rem; })
       .slice(0, Math.max(0, short))
       .forEach(function(x){ out[x.i] += 1; });
    return out;
  }

  function renderWorkingFormat(){
    var dial = document.getElementById("formatDial");
    var legend = document.getElementById("formatLegend");
    var period = document.getElementById("heroMonthLabel");
    if(!dial || !legend) return;
    if(period){
      period.textContent = new Date().toLocaleDateString(undefined, {month:"long", year:"numeric"});
    }

    var mk = monthKey(todayStr());
    var month = entries.filter(function(e){ return monthKey(e.date) === mk; });
    // Canonical TYPE_LABELS order, but only the types that actually occurred —
    // an entry-less type would just be a zero-percent legend row nobody needs.
    var active = Object.keys(TYPE_LABELS).map(function(type){
      return {type:type, label:TYPE_LABELS[type], color:DAY_TYPE_COLORS[type],
        count:month.filter(function(e){ return (e.type || "regular") === type; }).length};
    }).filter(function(b){ return b.count > 0; });
    var total = active.reduce(function(sum, b){ return sum + b.count; }, 0);

    if(!total){
      dial.innerHTML = '<p class="format-empty">No days logged this month yet.</p>';
      legend.innerHTML = "";
      updateFormatLegendScrollHint();
      return;
    }

    var pcts = pctSplit(active.map(function(b){ return b.count; }), total);
    // One ring, segments stacked end to end rather than the old concentric
    // rings — those only read cleanly for a fixed 3-way split; day types can
    // run to 9. Each segment is its own circle at a shared radius, advanced by
    // the running total of arc-length already drawn. Rotated -90° on the group
    // so the stack starts at twelve o'clock, same as before.
    // R/SW sized to fill more of the 120-unit viewBox: outer edge at 110 of
    // 120 units (5-unit margin each side), vs. the previous 44/13's 101 —
    // the ring was reading as small inside a card with a lot of open space
    // around it, not because the card lacked room but because the ring
    // wasn't using it.
    var C = 60, R = 48, SW = 14, circ = 2 * Math.PI * R;
    var cum = 0;
    var rings = '<circle class="format-ring-track" cx="'+C+'" cy="'+C+'" r="'+R+'" fill="none" stroke-width="'+SW+'"/>' +
      active.map(function(b){
        var shown = circ * (b.count / total);
        var seg = '<circle class="format-ring" cx="'+C+'" cy="'+C+'" r="'+R+'" fill="none" stroke-width="'+SW+'" ' +
          'stroke="'+b.color+'" stroke-dasharray="'+shown.toFixed(2)+' '+(circ - shown).toFixed(2)+'" ' +
          'stroke-dashoffset="'+(-cum).toFixed(2)+'"/>';
        cum += shown;
        return seg;
      }).join("");

    // The centre readout is drawn inside the svg so it scales with the ring —
    // as an HTML overlay it kept a fixed size while the dial shrank with the
    // row, and spilled out of the hole on a short viewport.
    var summary = total + " days: " +
      active.map(function(b, i){ return pcts[i] + "% " + b.label; }).join(", ");
    dial.innerHTML =
      '<svg viewBox="0 0 120 120" role="img" aria-label="'+escapeAttr(summary)+'">'+
        '<g transform="rotate(-90 '+C+' '+C+')">'+rings+'</g>'+
        '<text class="format-count" x="'+C+'" y="'+(C + 1)+'" '+
          'text-anchor="middle" dominant-baseline="middle">'+total+'</text>'+
        '<text class="format-count-label" x="'+C+'" y="'+(C + 12)+'" '+
          'text-anchor="middle" dominant-baseline="middle">DAYS</text>'+
      '</svg>';

    legend.innerHTML = active.map(function(b, i){
      return '<div class="format-leg">'+
        '<div class="format-leg-top">'+
          '<i class="format-leg-dot" style="background:'+b.color+'"></i>'+
          '<span class="format-leg-pct">'+pcts[i]+'%</span>'+
        '</div>'+
        '<span class="format-leg-label">'+escapeHtml(b.label)+'</span>'+
      '</div>';
    }).join("");
    updateFormatLegendScrollHint();
  }

  // A legend cut short read identically to one that just... ended — nothing
  // told you the card's edge wasn't the last day type. Same fix as the tab
  // strip's edge fade (updateTabsScrollHint above): fade in only once there
  // is genuinely more to scroll to, so a legend that fits gets no fade.
  function updateFormatLegendScrollHint(){
    var legend = document.getElementById("formatLegend");
    var card = legend && legend.closest(".format-card");
    if(!legend || !card) return;
    card.classList.toggle("can-scroll-legend",
      legend.scrollHeight - legend.scrollTop - legend.clientHeight > 4);
  }

  // ---------- Fit the Overview to the viewport ----------
  // The Overview is meant to be one screen: its grid is sized to whatever is
  // left of the viewport under the header rather than to its content, so the
  // roster is the only thing that scrolls. Measured rather than hardcoded
  // because the header's height moves — the viewing banner appears, the title
  // wraps — and a stale constant would either clip the figures or bring the
  // page scrollbar back.
  function fitOverview(){
    var panel = document.getElementById("tab-overview");
    if(!panel) return;
    if(!panel.classList.contains("active") ||
       !window.matchMedia("(min-width:1100px)").matches){
      panel.style.removeProperty("--ov-chrome");
      return;
    }
    // Everything on the page that is not this panel: the header above it, and
    // the export/import footer below. The footer is measured directly rather
    // than inferred from scrollHeight, which the browser clamps to the viewport
    // — that clamp turns "what is left over" into a feedback loop that shrinks
    // the panel a little further on every call.
    var top = panel.getBoundingClientRect().top + (window.scrollY || 0);
    var foot = document.querySelector("footer.ledger-foot");
    var below = 0;
    if(foot){
      var cs = getComputedStyle(foot);
      below = foot.getBoundingClientRect().height +
              (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    panel.style.setProperty("--ov-chrome", Math.round(top + below) + "px");
  }
  window.addEventListener("resize", fitOverview);
  window.addEventListener("resize", updateFormatLegendScrollHint);
  var formatLegendEl = document.getElementById("formatLegend");
  if(formatLegendEl) formatLegendEl.addEventListener("scroll", updateFormatLegendScrollHint);

  // ---------- Today's team ----------
  // Admin-only "who is in today". Deliberately its own one-day query rather
  // than reusing the Team tab's cache: that cache is built by renderTeam(),
  // which pulls a whole month for every user, and this panel is on the default
  // screen where that would be the heaviest thing on the page.
  async function renderTodayTeam(){
    var card = document.getElementById("todayTeamCard");
    // .solo drops the Overview grid to two columns; without it the roster's
    // column would stay behind as dead space for every non-admin.
    var panel = document.getElementById("tab-overview");
    if(!card) return;
    if(!isAdmin){
      card.hidden = true;
      if(panel) panel.classList.add("solo");
      fitOverview();
      return;
    }
    card.hidden = false;
    if(panel) panel.classList.remove("solo");

    var list = document.getElementById("todayTeamList");
    var countEl = document.getElementById("todayTeamCount");
    var today = todayStr();
    var byUser = {};
    try{
      var res = await supabase.from("entries")
        .select("user_id,date,clock_in,clock_out,type")
        .eq("date", today);
      if(res.error) throw res.error;
      (res.data || []).forEach(function(row){
        (byUser[row.user_id] = byUser[row.user_id] || []).push(rowToEntry(row));
      });
    }catch(err){
      list.innerHTML = '<p class="tt-empty">Couldn\'t load today: '+escapeHtml(friendlyError(err))+'</p>';
      if(countEl) countEl.textContent = "";
      return;
    }

    var settingsByUser = await loadTeamSettings();
    var rows = allProfiles.map(function(p){
      var own = settingsByUser[p.id] || normalizeSettings({});
      return {p: p, st: teamStatus(byUser[p.id] || [], own)};
    });
    // Anyone still outstanding first — the panel exists to surface those.
    var order = {missing:0, in:1, excused:2, done:3, off:4};
    rows.sort(function(a,b){
      var d = (order[a.st.cls] || 9) - (order[b.st.cls] || 9);
      return d || (a.p.full_name || a.p.email).localeCompare(b.p.full_name || b.p.email);
    });

    if(!rows.length){
      list.innerHTML = '<p class="tt-empty">No other users have registered yet.</p>';
      if(countEl) countEl.textContent = "";
      return;
    }
    // The panel exists to surface whoever is still outstanding, so that — not
    // a headcount — is what the header reports.
    if(countEl){
      var outstanding = rows.filter(function(r){ return r.st.cls === "missing"; }).length;
      countEl.textContent = outstanding
        ? outstanding + " outstanding"
        : "All " + rows.length + " accounted for";
    }
    list.innerHTML = rows.map(function(r){
      var name = r.p.full_name || r.p.email;
      var url = (currentUser && r.p.id === currentUser.id) ? localAvatar(r.p.id) : null;
      // Filled for a settled day, lime while a shift is running, an open ring
      // for anything still outstanding.
      var checkCls = r.st.cls === "in" ? " is-in"
                   : (r.st.cls === "done" || r.st.cls === "excused" || r.st.cls === "off") ? " is-done" : "";
      return '<div class="tt-row">'+
        (url ? '<div class="avatar"><img src="'+escapeAttr(url)+'" alt=""></div>'
             : '<div class="avatar">'+escapeHtml(initialsOf(name))+'</div>')+
        '<span class="tt-name" dir="auto">'+escapeHtml(name)+'</span>'+
        '<span class="team-status '+r.st.cls+'">'+escapeHtml(r.st.label)+'</span>'+
        '<span class="tt-check'+checkCls+'" aria-hidden="true">'+
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'+
        '</span>'+
      '</div>';
    }).join("");
  }

  function updateViewingBanner(){
    var banner = document.getElementById("viewingOtherBanner");
    var qc = document.querySelector(".quick-clock");
    if(!isOwnData && viewedProfile){
      document.getElementById("viewingOtherTitle").textContent =
        "Viewing " + (viewedProfile.full_name || viewedProfile.email) + "'s attendance";
      banner.classList.add("show");
    } else {
      banner.classList.remove("show");
    }
    document.getElementById("clockInBtn").disabled = !isOwnData;
    document.getElementById("clockOutBtn").disabled = !isOwnData;
    if(qc) qc.style.opacity = isOwnData ? "1" : ".5";
    document.getElementById("stickyClockInBtn").disabled = !isOwnData;
    document.getElementById("stickyClockOutBtn").disabled = !isOwnData;
    if(!isOwnData) document.getElementById("stickyClock").classList.remove("show");
    document.getElementById("bnClockBtn").classList.toggle("disabled", !isOwnData);
    // Everyone can reach their own schedule; an admin can additionally edit
    // anyone else's. Hiding the entry point entirely from employees meant a new
    // user silently inherited the Sun–Thu 08:00–16:00 defaults with no way to
    // change them and nothing in the UI even hinting the setting existed — so in
    // a Mon–Fri organisation every figure they saw was wrong, permanently.
    document.getElementById("settingsBtn").style.display = (isAdmin || isOwnData) ? "flex" : "none";
  }

  async function loadAllProfilesForSwitcher(){
    try{
      var res = await supabase.from("profiles").select("id,email,full_name,role").order("email");
      if(res.error) throw res.error;
      allProfiles = res.data || [];
    }catch(err){
      allProfiles = currentProfile ? [currentProfile] : [];
    }
    var sel = document.getElementById("viewerSelect");
    var prev = sel.value;
    sel.innerHTML = allProfiles.map(function(p){
      var label = (p.id === currentUser.id ? "Me — " : "") + (p.full_name || p.email) +
        (p.role === "admin" ? " (Admin)" : "");
      return '<option value="'+p.id+'">'+escapeHtml(label)+'</option>';
    }).join("");
    sel.value = allProfiles.some(function(p){ return p.id === prev; }) ? prev : currentUser.id;
  }

  document.getElementById("viewerSelect").addEventListener("change", async function(){
    var newId = this.value;
    if(newId === viewedUserId) return;
    viewedUserId = newId;
    viewedProfile = allProfiles.find(function(p){ return p.id === newId; }) || null;
    resetForm();
    document.getElementById("settingsCard").classList.remove("open");
    await loadDataForViewedUser();
  });

  // ---------- Roles: grant/revoke admin rights ----------
  // The role toggle lives in the Admin tab's People list. Delegated from the
  // list container so rows can be re-rendered freely by search and filtering.
  document.getElementById("adminUsersList").addEventListener("click", async function(ev){
    var btn = ev.target.closest(".role-btn");
    if(!btn || btn.disabled) return;
    var row = btn.closest(".admin-user-row");
    var uid = row.getAttribute("data-uid");
    var newRole = btn.getAttribute("data-role");
    var person = adminUsersCache.find(function(p){ return p.id === uid; });
    if(!person || person.role === newRole) return;

    var isSelf = uid === currentUser.id;
    // A courtesy check only — the authoritative "never remove the last admin"
    // rule now lives inside the admin_set_user_role RPC, so it cannot be
    // bypassed by calling the API directly the way this client-side guard could.
    if(isSelf && newRole !== "admin"){
      var adminCount = adminUsersCache.filter(function(p){ return p.role === "admin"; }).length;
      if(adminCount <= 1){
        showToast("You're the only admin. Promote someone else first — otherwise no one would be left with access to these controls.", "error");
        return;
      }
    }

    var label = person.full_name || person.email;
    var msg = newRole === "admin"
      ? "Make " + label + " an admin? They'll be able to view and edit everyone's attendance and schedule settings."
      : "Remove admin rights from " + label + "?" + (isSelf ? " You'll lose access to these controls immediately." : "");
    var confirmed = await showConfirm(msg, {
      title: newRole === "admin" ? "Grant admin rights?" : "Remove admin rights?",
      danger: newRole !== "admin",
      confirmText: newRole === "admin" ? "Make Admin" : "Remove Admin"
    });
    if(!confirmed) return;

    var buttons = row.querySelectorAll(".role-btn");
    buttons.forEach(function(b){ b.disabled = true; });
    try{
      // Role changes go through a SECURITY DEFINER RPC that re-checks admin
      // rights and enforces the last-admin rule server-side. A direct table
      // update is no longer permitted: `authenticated` holds a column grant on
      // profiles.full_name only, which is what closed the self-promotion hole.
      var res = await supabase.rpc("admin_set_user_role", {target_id: uid, new_role: newRole});
      if(res.error) throw res.error;
      person.role = newRole;
      renderAdminPeople();
      await loadAllProfilesForSwitcher();
      if(isSelf) await refreshCurrentProfile();
      await renderAuditLog();
      showToast(label + " is now " + (newRole === "admin" ? "an admin." : "an employee."), "success");
    }catch(err){
      showToast("Couldn't update that role: " + friendlyError(err), "error");
      buttons.forEach(function(b){ b.disabled = false; });
    }
  });

  // Applies one entry to every registered user across a date range — the
  // "mark a multi-day public holiday for the whole team in one click" case.
  var BULK_APPLY_MAX_ENTRIES = 500; // safety cap: days x team members

  document.getElementById("bulkApplyBtn").addEventListener("click", async function(){
    var fromDate = document.getElementById("bulkApplyFromDate").value;
    var toDate = document.getElementById("bulkApplyToDate").value;
    var type = document.getElementById("bulkApplyType").value;
    var note = document.getElementById("bulkApplyNote").value.trim();

    if(!fromDate || !toDate){ showToast("Pick both a start and end date.", "error"); return; }
    if(toDate < fromDate){ showToast("The end date can't be before the start date.", "error"); return; }
    if(!allProfiles.length){ showToast("No team members to apply this to yet.", "error"); return; }

    // Every calendar day in the range, inclusive — this covers the whole
    // team regardless of any one person's own working-day schedule, since
    // a company holiday applies to specific dates for everyone alike.
    var dates = [];
    var cursor = dateFromStr(fromDate);
    var end = dateFromStr(toDate);
    var guard = 0;
    while(dateToStr(cursor) <= dateToStr(end) && guard < 400){
      dates.push(dateToStr(cursor));
      cursor.setDate(cursor.getDate() + 1);
      guard++;
    }
    // If the scan stopped because it hit the safety cap rather than because
    // it reached the end date, the range genuinely wasn't fully covered —
    // proceeding would silently apply to fewer days than requested, and
    // could even let the entry-count cap below pass on an undercount.
    if(dateToStr(cursor) <= dateToStr(end)){
      showToast("That date range is too large to scan in one go — narrow it and try again.", "error");
      return;
    }

    var totalEntries = dates.length * allProfiles.length;
    if(totalEntries > BULK_APPLY_MAX_ENTRIES){
      showToast(
        "That's " + dates.length + " days × " + allProfiles.length + " team members = " + totalEntries +
        " entries, over the " + BULK_APPLY_MAX_ENTRIES + " limit for one action. Narrow the date range and try again.",
        "error"
      );
      return;
    }

    var btn = this;
    btn.disabled = true;

    // One query for every existing entry across the whole range. clock_in and
    // clock_out come back too, so days that already hold real recorded hours can
    // be identified — previously this action blanked them with no warning and no
    // undo, destroying payroll-relevant data for the whole team in one click.
    var existingByUserDate = {}, occupied = [];
    try{
      var res = await supabase.from("entries")
        .select("id,user_id,date,clock_in,clock_out").in("date", dates);
      if(res.error) throw res.error;
      (res.data || []).forEach(function(row){
        existingByUserDate[row.user_id + "|" + row.date] = row;
        if(row.clock_in || row.clock_out) occupied.push(row);
      });
    }catch(err){
      showToast("Couldn't check existing entries for that range: " + friendlyError(err), "error");
      btn.disabled = false;
      return;
    }
    btn.disabled = false;

    var dateRangeLabel = dates.length === 1 ? fmtDate(dates[0]) : fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length-1]);
    var skipOccupied = true;
    if(occupied.length){
      var sample = occupied.slice(0, 3).map(function(r){ return fmtDate(r.date); });
      var overwrite = await showConfirm(
        occupied.length + " of these " + totalEntries + " entries already contain recorded hours" +
        " (" + sample.join(", ") + (occupied.length > 3 ? " and " + (occupied.length-3) + " more" : "") + ")." +
        "\n\nOverwriting them erases those clock-in and clock-out times permanently.",
        {title:"Some days already have hours", danger:true,
         confirmText:"Overwrite all " + totalEntries, cancelText:"Skip those " + occupied.length}
      );
      skipOccupied = !overwrite;
    }

    var willWrite = totalEntries - (skipOccupied ? occupied.length : 0);
    if(!willWrite){
      showToast("Every day in that range already has recorded hours, so nothing was changed.", "info");
      return;
    }

    var confirmed = await showConfirm(
      "This will set " + typeLabel(type).toLowerCase() + " for all " + allProfiles.length +
      " team member" + (allProfiles.length===1?"":"s") + " across " + dates.length +
      " day" + (dates.length===1?"":"s") + " (" + dateRangeLabel + ")." +
      (occupied.length && skipOccupied ? "\n\n" + occupied.length + " day(s) with recorded hours will be left untouched." : ""),
      {title:"Apply to everyone?", confirmText:"Apply " + willWrite + " entries"}
    );
    if(!confirmed) return;

    btn.disabled = true;
    btn.textContent = "Applying " + willWrite + " entries…";
    beginBulkOperation();

    var rows = [];
    for(var d=0; d<dates.length; d++){
      for(var i=0; i<allProfiles.length; i++){
        var p = allProfiles[i];
        var existing = existingByUserDate[p.id + "|" + dates[d]];
        if(skipOccupied && existing && (existing.clock_in || existing.clock_out)) continue;
        rows.push(entryToRow({date: dates[d], clockIn:"", clockOut:"", type: type, note: note}, p.id));
      }
    }

    var applied = 0, bulkErr = null;
    try{ applied = await sbBulkUpsertEntries(rows); }
    catch(err){ bulkErr = err; }

    endBulkOperation();
    btn.disabled = false;
    btn.textContent = "Apply to All Team Members";
    document.getElementById("bulkApplyNote").value = "";

    await loadDataForViewedUser();
    if(document.querySelector('.tab-btn[data-tab="team"].active')) renderTeam();
    if(bulkErr){
      showToast("Couldn't apply that: " + friendlyError(bulkErr), "error");
    } else {
      showToast(
        "Applied " + applied + " entries." +
        (occupied.length && skipOccupied ? " " + occupied.length + " day(s) with recorded hours were left untouched." : ""),
        "success");
    }
  });

  // ---------- Profile photo (device-local) ----------
  // Deliberately NOT stored in Supabase: the photo lives in this browser only,
  // so it costs no storage quota. The trade-offs were chosen knowingly and are
  // worth stating, because they are surprising:
  //
  //   * Nobody else ever sees it. Teammates render as initials in the Team
  //     roster and the admin People list, because their photos live in THEIR
  //     browsers and are not transmitted anywhere.
  //   * It does not follow you to another device or browser, and clearing site
  //     data removes it.
  //   * An admin cannot set someone else's photo.
  //
  // Keyed by user id so two people signing into the same browser (a shared
  // office machine is exactly the scene this app is used in) never inherit
  // each other's picture.
  var AVATAR_PREFIX = "attendance_avatar_v1_";
  var AVATAR_PX = 256;          // stored square edge
  var AVATAR_MAX_BYTES = 8 * 1024 * 1024; // reject before decoding

  function avatarKey(userId){ return AVATAR_PREFIX + userId; }

  function localAvatar(userId){
    if(!userId) return null;
    return safeGet(avatarKey(userId));
  }

  // Downscales to a square data URL before storing. localStorage holds ~5MB per
  // origin and throws once full, so an untouched 4MB phone photo would both
  // blow the quota and be 16x larger than anything the UI renders.
  function fileToAvatarDataUrl(file){
    return new Promise(function(resolve, reject){
      if(!/^image\/(jpeg|png|webp)$/.test(file.type)){
        reject(new Error("Choose a JPEG, PNG or WebP image."));
        return;
      }
      if(file.size > AVATAR_MAX_BYTES){
        reject(new Error("That image is larger than 8MB. Choose a smaller one."));
        return;
      }
      // FileReader rather than URL.createObjectURL: an object URL is a blob:
      // URL, and this page's CSP is `img-src 'self' data:`, so the <img> below
      // would be blocked and every upload would fail as "not a readable image".
      // Reading to a data: URL keeps the policy tight instead of widening it
      // to blob: just to load a picture the user just picked.
      var reader = new FileReader();
      reader.onerror = function(){ reject(new Error("That file couldn't be read.")); };
      reader.onload = function(){
        var img = new Image();
        img.onload = function(){
          try{
            // Cover-crop to a centred square so portraits and landscapes both
            // fill the circle instead of being squashed to fit it.
            var side = Math.min(img.width, img.height);
            var sx = (img.width - side) / 2;
            var sy = (img.height - side) / 2;
            var canvas = document.createElement("canvas");
            canvas.width = canvas.height = AVATAR_PX;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          }catch(err){
            reject(new Error("That image couldn't be processed."));
          }
        };
        img.onerror = function(){ reject(new Error("That file isn't a readable image.")); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Repaints every surface that shows your face after the photo changes.
  function refreshAvatars(){
    renderIdentityChrome();
    var settingsAvatar = document.getElementById("settingsAvatar");
    if(settingsAvatar && currentProfile){
      var url = localAvatar(currentProfile.id);
      settingsAvatar.innerHTML = url
        ? '<img src="'+escapeAttr(url)+'" alt="">'
        : escapeHtml(initialsOf(currentProfile.full_name || currentProfile.email));
      var removeBtn = document.getElementById("photoRemoveBtn");
      if(removeBtn) removeBtn.style.display = url ? "" : "none";
    }
    // The Team roster draws your own card from the same store.
    if(document.querySelector('.tab-btn[data-tab="team"].active')) renderTeamCards();
  }

  document.getElementById("photoChooseBtn").addEventListener("click", function(){
    document.getElementById("photoInput").click();
  });

  document.getElementById("photoInput").addEventListener("change", async function(){
    var file = this.files && this.files[0];
    // Reset immediately so re-picking the same file still fires a change event.
    this.value = "";
    if(!file || !currentProfile) return;
    try{
      var dataUrl = await fileToAvatarDataUrl(file);
      // safeSet reports its own failure; localStorage throws when the origin's
      // quota is full, which a photo is far more likely to trigger than a
      // settings blob, so a failed write must not look like a success.
      if(!safeSet(avatarKey(currentProfile.id), dataUrl)){
        showToast("Couldn't save the photo — this browser's storage is full or blocked.", "error");
        return;
      }
      refreshAvatars();
      showToast("Photo saved on this device.", "success");
    }catch(err){
      showToast(err.message || "That image couldn't be used.", "error");
    }
  });

  document.getElementById("photoRemoveBtn").addEventListener("click", async function(){
    if(!currentProfile) return;
    var ok = await showConfirm(
      "Remove your photo from this device? You'll go back to showing your initials.",
      {title:"Remove photo?", confirmText:"Remove", danger:true}
    );
    if(!ok) return;
    try{ localStorage.removeItem(avatarKey(currentProfile.id)); }catch(err){}
    refreshAvatars();
    showToast("Photo removed.", "success");
  });

  // ---------- Identity chrome ----------
  // Everything that shows who is signed in: the header greeting, the rail's
  // user block, and the two rail destinations only an admin may see. Called
  // from both the cold-start path and the role-refresh path so the two can
  // never drift apart.
  function firstNameOf(profile){
    var name = (profile && profile.full_name || "").trim();
    if(!name) return (profile && profile.email || "").split("@")[0];
    return name.split(/\s+/)[0];
  }

  // Photo when there is one, initials when there is not — see .avatar in the
  // stylesheet. Both branches render the same box so a mixed roster still
  // lines up.
  function avatarHtml(profile, extraClass){
    var name = (profile && (profile.full_name || profile.email)) || "?";
    var cls  = "avatar" + (extraClass ? " " + extraClass : "");
    // Only the signed-in user can have a picture here: photos are device-local,
    // so there is nothing to show for anyone else.
    var url = profile && currentUser && profile.id === currentUser.id
      ? localAvatar(profile.id) : null;
    if(url){
      return '<div class="'+cls+'"><img src="'+escapeAttr(url)+'" alt=""></div>';
    }
    return '<div class="'+cls+'">'+escapeHtml(initialsOf(name))+'</div>';
  }

  function initialsOf(name){
    return String(name || "?").trim().split(/\s+/)
      .map(function(w){ return w[0]; }).slice(0,2).join("").toUpperCase();
  }

  function renderIdentityChrome(){
    if(!currentProfile) return;
    var greeting = document.getElementById("headGreeting");
    if(greeting) greeting.textContent = "Hello " + firstNameOf(currentProfile);

    var railAvatar = document.getElementById("railUserAvatar");
    if(railAvatar){
      var url = localAvatar(currentProfile.id);
      railAvatar.innerHTML = url
        ? '<img src="'+escapeAttr(url)+'" alt="">'
        : escapeHtml(initialsOf(currentProfile.full_name || currentProfile.email));
    }
    var railName = document.getElementById("railUserName");
    if(railName) railName.textContent = currentProfile.full_name || currentProfile.email;
    var railRole = document.getElementById("railUserRole");
    if(railRole) railRole.textContent = isAdmin ? "Admin" : "Employee";

    var railTeam = document.getElementById("railTeamBtn");
    if(railTeam) railTeam.style.display = isAdmin ? "" : "none";
    var railAdmin = document.getElementById("railAdminBtn");
    if(railAdmin) railAdmin.style.display = isAdmin ? "" : "none";
  }

  // Re-syncs UI after the signed-in user's own role changes (e.g. self-demotion),
  // without requiring a full sign-out/sign-in.
  async function refreshCurrentProfile(){
    try{
      var res = await supabase.from("profiles").select("*").eq("id", currentUser.id).single();
      if(res.error) throw res.error;
      currentProfile = res.data;
    }catch(err){ return; }

    isAdmin = currentProfile.role === "admin";
    refreshAvatars();

    if(isAdmin){
      document.getElementById("viewerSwitchWrap").style.display = "flex";
      document.getElementById("teamTabBtn").style.display = "";
      document.getElementById("adminBtn").style.display = "";
      layoutBottomNav();
    } else {
      document.getElementById("viewerSwitchWrap").style.display = "none";
      document.getElementById("teamTabBtn").style.display = "none";
      document.getElementById("adminBtn").style.display = "none";
      layoutBottomNav();
      document.getElementById("settingsCard").classList.remove("open");
      if(viewedUserId !== currentUser.id){
        viewedUserId = currentUser.id;
        viewedProfile = currentProfile;
        await loadDataForViewedUser();
      }
      // Leave any admin-only tab the demoted user is standing on. Hiding the
      // button alone would leave the panel — roles, the audit log, everyone's
      // accounts — on screen until they happened to click elsewhere.
      var activeTab = document.querySelector(".tab-btn.active");
      var activeName = activeTab && activeTab.getAttribute("data-tab");
      if(activeName === "team" || activeName === "admin"){
        document.querySelector('.tab-btn[data-tab="log"]').click();
      }
    }
    updateViewingBanner();
    setTimeout(updateTabsScrollHint, 0);
  }

  // ---------- Team roster ----------
  // Every figure here is computed against the person's OWN schedule. The old
  // version ran everyone's entries through whichever settings the viewer
  // happened to be holding, so a Sun–Thu admin looking at a Mon–Fri employee
  // saw a target, a shortfall and a punctuality record for a week that employee
  // does not work.
  var teamMonth = null;          // "YYYY-MM"; null until first render
  var teamSettingsCache = null;  // user_id -> normalised settings
  var teamRowsCache = [];        // [{profile, summary, today, settings}]

  async function loadTeamSettings(){
    if(teamSettingsCache) return teamSettingsCache;
    var map = {};
    try{
      var res = await supabase.from("user_settings").select("user_id,settings");
      if(res.error) throw res.error;
      (res.data || []).forEach(function(r){ map[r.user_id] = normalizeSettings(r.settings); });
    }catch(err){
      // Fall through with what we have: everyone without a row is measured
      // against the defaults, which is exactly what the app does for them too.
    }
    teamSettingsCache = map;
    return map;
  }

  // summarize(), computeEntry() and scheduleFor() all read the module-level
  // `settings`. Rather than change the signature of functions the regression
  // suite extracts verbatim, swap the value for the duration of one synchronous
  // call. Nothing awaits in between, so nothing else can observe the swap.
  function summarizeAs(personSettings, rows){
    var saved = settings;
    settings = personSettings;
    try { return summarize(rows); }
    finally { settings = saved; }
  }
  function scheduledFor(personSettings, dateStr){
    var saved = settings;
    settings = personSettings;
    try { return isScheduled(dateStr); }
    finally { settings = saved; }
  }

  // What that person is doing today — the question a roster is actually opened
  // to answer, and one the old three-number row could not answer at all.
  function teamStatus(rows, personSettings){
    var today = todayStr();
    var e = rows.find(function(r){ return r.date === today; });
    if(e && e.clockIn && !e.clockOut) return {cls:"in", label:"Clocked in"};
    if(e && EXCUSED_TYPES.indexOf(e.type) !== -1) return {cls:"excused", label:typeLabel(e.type)};
    if(e && e.clockIn && e.clockOut) return {cls:"done", label:"Done today"};
    if(!scheduledFor(personSettings, today)) return {cls:"off", label:"Day off"};
    return {cls:"missing", label:"Not logged"};
  }

  async function renderTeam(){
    if(!isAdmin) return;
    var list = document.getElementById("teamList");
    var empty = document.getElementById("teamEmpty");
    if(!teamMonth) teamMonth = monthKey(todayStr());
    document.getElementById("teamMonthLabel").textContent = monthLabel(teamMonth);
    // Nobody has attendance in the future; stop the arrow rather than let it
    // walk into empty months.
    document.getElementById("teamNextMonth").disabled = teamMonth >= monthKey(todayStr());

    list.innerHTML = '<p class="empty-state" style="padding:24px 0;">Loading team…</p>';
    empty.style.display = "none";
    document.getElementById("teamSummary").hidden = true;

    var byUser = {};
    try{
      // Scoped to the month being displayed, with an explicit column list.
      // This previously fetched every entry in the database — all users, all
      // history — on every visit to the tab, then discarded ~everything client
      // side. Besides the bandwidth, an unbounded select risks PostgREST's row
      // cap silently truncating the result, which would under-report someone's
      // hours with no error at all.
      var monthStart = teamMonth + "-01";
      var mp = teamMonth.split("-");
      var monthEnd = dateToStr(new Date(+mp[0], +mp[1], 0)); // last day of month
      var res = await supabase.from("entries")
        .select("user_id,date,clock_in,clock_out,type")
        .gte("date", monthStart).lte("date", monthEnd);
      if(res.error) throw res.error;
      (res.data || []).forEach(function(row){
        if(!byUser[row.user_id]) byUser[row.user_id] = [];
        byUser[row.user_id].push(rowToEntry(row));
      });
    }catch(err){
      list.innerHTML = "";
      empty.textContent = "Couldn't load team data: " + friendlyError(err);
      empty.style.display = "block";
      return;
    }

    var settingsByUser = await loadTeamSettings();

    teamRowsCache = allProfiles.map(function(p){
      var rows = byUser[p.id] || [];
      var own = settingsByUser[p.id] || normalizeSettings({});
      return {
        profile: p,
        rows: rows,
        settings: own,
        summary: summarizeAs(own, rows),
        status: teamStatus(rows, own),
        configured: !!settingsByUser[p.id]
      };
    });

    renderTeamCards();
  }

  function renderTeamCards(){
    var list = document.getElementById("teamList");
    var empty = document.getElementById("teamEmpty");
    var summaryEl = document.getElementById("teamSummary");
    var term = (document.getElementById("teamSearch").value || "").trim().toLowerCase();
    var sort = document.getElementById("teamSort").value;

    if(!teamRowsCache.length){
      list.innerHTML = "";
      empty.textContent = "No other users have registered yet.";
      empty.style.display = "block";
      summaryEl.hidden = true;
      return;
    }

    // The summary covers the whole team, not the filtered view — a search box
    // should not appear to change the month's totals.
    var totals = teamRowsCache.reduce(function(a, t){
      a.worked += t.summary.workedSum;
      a.target += t.summary.targetSum;
      a.days   += t.summary.loggedDays;
      if(t.status.cls === "in") a.inNow++;
      return a;
    }, {worked:0, target:0, days:0, inNow:0});

    summaryEl.hidden = false;
    summaryEl.innerHTML = [
      ['<span class="ts-value">'+teamRowsCache.length+'</span><span class="ts-label">people</span>'],
      ['<span class="ts-value">'+totals.inNow+'</span><span class="ts-label">clocked in now</span>'],
      ['<span class="ts-value">'+totals.days+'</span><span class="ts-label">days logged</span>'],
      ['<span class="ts-value">'+minutesToHoursStr(totals.worked)+'</span><span class="ts-label">of '+minutesToHoursStr(totals.target)+' target</span>'],
      // Same accomplishment reading as the Shortfall tab's Target Met Rate:
      // share of target HOURS worked, not a day-count rate. Floored, not
      // rounded — see the note by pMetRate above for why.
      ['<span class="ts-value">'+(totals.target ? Math.floor((totals.worked/totals.target)*100)+"%" : "—")+'</span><span class="ts-label">target met</span>']
    ].map(function(x){ return '<div class="ts-item">'+x+'</div>'; }).join("");

    var shown = teamRowsCache.filter(function(t){
      if(!term) return true;
      return ((t.profile.full_name || "") + " " + (t.profile.email || "")).toLowerCase().indexOf(term) !== -1;
    });

    shown.sort(function(a, b){
      if(sort === "worked") return b.summary.workedSum - a.summary.workedSum;
      if(sort === "short")  return a.summary.diffSum - b.summary.diffSum;
      if(sort === "ontime"){
        var ar = a.summary.targetSum ? (a.summary.workedSum/a.summary.targetSum)*100 : null;
        var br = b.summary.targetSum ? (b.summary.workedSum/b.summary.targetSum)*100 : null;
        if(ar === null && br === null) return 0;
        if(ar === null) return 1;          // no target to measure against sorts last, not best
        if(br === null) return -1;
        return ar - br;
      }
      return (a.profile.full_name || a.profile.email || "")
        .localeCompare(b.profile.full_name || b.profile.email || "");
    });

    empty.style.display = shown.length ? "none" : "block";
    if(!shown.length) empty.textContent = "Nobody matches that search.";
    list.innerHTML = "";

    shown.forEach(function(t){
      var p = t.profile, s = t.summary;
      var initials = (p.full_name || p.email || "?").trim().split(/\s+/)
        .map(function(w){ return w[0]; }).slice(0,2).join("").toUpperCase();
      var name = p.full_name || p.email;
      // Floored, not rounded, so a bar/figure a few minutes short of target
      // never reads as a full "100%" — see the note by pMetRate for why.
      var pct = s.targetSum ? Math.min(100, Math.floor((s.workedSum / s.targetSum) * 100)) : 0;
      var barCls = !s.targetSum ? "" : (s.diffSum >= 0 ? " is-met" : (pct >= 90 ? " is-short" : " is-short"));
      var diffCls = s.diffSum > 0 ? " over" : (s.diffSum < 0 ? " short" : "");
      var diffTxt = (s.diffSum > 0 ? "+" : "") + minutesToHoursStr(s.diffSum);

      var card = document.createElement("button");
      card.type = "button";
      card.className = "team-card";
      card.setAttribute("data-uid", p.id);
      card.setAttribute("aria-label", "Open " + name + "'s attendance for " + monthLabel(teamMonth));
      card.innerHTML =
        '<div class="team-card-head">'+
          // Initials always: a teammate's photo lives in THEIR browser and is
          // never transmitted, so there is nothing to render here but initials.
          // Your own card is the one exception.
          ((currentUser && p.id === currentUser.id && localAvatar(p.id))
            ? '<div class="team-avatar"><img src="'+escapeAttr(localAvatar(p.id))+'" alt=""></div>'
            : '<div class="team-avatar">'+escapeHtml(initials)+'</div>')+
          '<div class="team-info">'+
            '<div class="team-name" dir="auto">'+escapeHtml(name)+
              (p.role === "admin" ? ' <span class="admin-badge">Admin</span>' : '')+
              (t.configured ? '' : ' <span class="admin-badge unconfigured">No schedule</span>')+
            '</div>'+
            '<div class="team-email" dir="auto">'+escapeHtml(p.email)+'</div>'+
          '</div>'+
          '<span class="team-status '+t.status.cls+'">'+escapeHtml(t.status.label)+'</span>'+
        '</div>'+
        '<div>'+
          '<div class="team-bar'+barCls+'"><span style="width:'+pct+'%"></span></div>'+
          '<div class="team-bar-note">'+
            (s.targetSum
              ? minutesToHoursStr(s.workedSum)+' of '+minutesToHoursStr(s.targetSum)+' target'+
                (s.incompleteDays ? ' · '+s.incompleteDays+' incomplete' : '')
              : 'No scheduled days this month')+
          '</div>'+
        '</div>'+
        '<div class="team-card-figures">'+
          '<div><div class="label">Days</div><div class="value">'+s.loggedDays+'</div></div>'+
          '<div><div class="label">Avg/Day</div><div class="value">'+(s.loggedDays ? minutesToHoursStr(s.avgMin) : "—")+'</div></div>'+
          '<div><div class="label">Diff</div><div class="value'+diffCls+'">'+diffTxt+'</div></div>'+
          '<div><div class="label">Target Met</div><div class="value">'+
            (s.targetSum ? Math.floor((s.workedSum/s.targetSum)*100)+"%" : "—")+'</div></div>'+
        '</div>';
      list.appendChild(card);
    });
  }

  document.getElementById("teamList").addEventListener("click", function(ev){
    var card = ev.target.closest(".team-card");
    if(!card) return;
    var sel = document.getElementById("viewerSelect");
    sel.value = card.getAttribute("data-uid");
    sel.dispatchEvent(new Event("change"));
    activateTab("log");
  });
  document.getElementById("teamSearch").addEventListener("input", renderTeamCards);
  document.getElementById("teamSort").addEventListener("change", renderTeamCards);
  document.getElementById("teamPrevMonth").addEventListener("click", function(){
    teamMonth = shiftMonth(teamMonth || monthKey(todayStr()), -1);
    renderTeam();
  });
  document.getElementById("teamNextMonth").addEventListener("click", function(){
    var next = shiftMonth(teamMonth || monthKey(todayStr()), 1);
    if(next > monthKey(todayStr())) return;
    teamMonth = next;
    renderTeam();
  });
  function shiftMonth(key, delta){
    var p = key.split("-");
    var d = new Date(+p[0], +p[1] - 1 + delta, 1);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  }

  // ---------- Admin panel ----------
  var adminUsersCache = [];

  function fmtBytes(n){
    if(!isFinite(n) || n <= 0) return "0 B";
    var units = ["B","KB","MB","GB","TB"], i = 0, v = n;
    while(v >= 1024 && i < units.length-1){ v /= 1024; i++; }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
  }

  function fmtRelative(iso){
    if(!iso) return "Never";
    var then = new Date(iso), now = new Date();
    var mins = Math.round((now - then) / 60000);
    if(mins < 1) return "Just now";
    if(mins < 60) return mins + "m ago";
    var hrs = Math.round(mins/60);
    if(hrs < 24) return hrs + "h ago";
    var days = Math.round(hrs/24);
    if(days < 30) return days + "d ago";
    return then.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"});
  }

  async function renderAdminStats(){
    var res;
    try{
      res = await supabase.rpc("admin_db_stats");
      if(res.error) throw res.error;
    }catch(err){
      showToast("Couldn't load system stats: " + friendlyError(err), "error");
      return;
    }
    var s = res.data || {};

    document.getElementById("statDbSize").textContent = fmtBytes(s.db_size_bytes);
    document.getElementById("statUsers").textContent = (s.counts && s.counts.profiles) || 0;
    document.getElementById("statUsersDetail").textContent =
      ((s.counts && s.counts.admins) || 0) + " admin" + (((s.counts && s.counts.admins) || 0) === 1 ? "" : "s");
    document.getElementById("statEntries").textContent =
      ((s.counts && s.counts.entries) || 0).toLocaleString();
    document.getElementById("statConnections").textContent =
      (s.active_connections || 0) + " / " + (s.max_connections || "?");

    var pct = s.max_connections ? Math.round((s.active_connections / s.max_connections) * 100) : 0;
    document.getElementById("statConnectionsDetail").textContent = pct + "% of the connection limit in use";

    var body = document.getElementById("adminTablesBody");
    body.innerHTML = "";
    (s.tables || []).forEach(function(t){
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td data-label='Table'><span class=\"cell-label\">Table</span>"+escapeHtml(t.name)+"</td>"+
        "<td class='num' data-label='Rows'><span class=\"cell-label\">Rows</span>"+Number(t.rows).toLocaleString()+"</td>"+
        "<td class='num' data-label='Size'><span class=\"cell-label\">Size</span>"+fmtBytes(t.total_bytes)+"</td>";
      body.appendChild(tr);
    });

    document.getElementById("adminStatsFooter").textContent =
      "Postgres " + (s.postgres_version || "?") +
      " · Updated " + new Date(s.generated_at || Date.now()).toLocaleTimeString() +
      " · CPU and bandwidth aren't available from the browser; see your Supabase dashboard for those.";
  }

  // Which users hold a user_settings row of their own. Anyone missing from this
  // set is running on the client-side fallback schedule — Sun–Thu 08:00–16:00 —
  // which means every figure the app shows them is measured against a week they
  // may not work. It is invisible from their side, so it is surfaced here.
  var adminSettingsOwners = null;   // null = not loaded yet, Set once fetched

  async function loadAdminSettingsOwners(){
    try{
      var res = await supabase.from("user_settings").select("user_id");
      if(res.error) throw res.error;
      adminSettingsOwners = new Set((res.data || []).map(function(r){ return r.user_id; }));
    }catch(err){
      adminSettingsOwners = null;   // unknown, not "nobody" — don't flag everyone
    }
  }

  function isUnconfigured(u){
    return adminSettingsOwners ? !adminSettingsOwners.has(u.id) : false;
  }

  async function loadAdminPeople(){
    var res;
    try{
      res = await supabase.rpc("admin_list_users");
      if(res.error) throw res.error;
    }catch(err){
      showToast("Couldn't load users: " + friendlyError(err), "error");
      return;
    }
    adminUsersCache = res.data || [];
    fillAuditUserFilter();
    renderAdminPeople();
  }

  // Renders from the cache, so typing in the search box never re-queries.
  function renderAdminPeople(){
    var list = document.getElementById("adminUsersList");
    var empty = document.getElementById("adminUsersEmpty");
    var term = (document.getElementById("adminUserSearch").value || "").trim().toLowerCase();
    var filter = document.getElementById("adminUserFilter").value;

    var shown = adminUsersCache.filter(function(u){
      if(term){
        var hay = ((u.full_name || "") + " " + (u.email || "")).toLowerCase();
        if(hay.indexOf(term) === -1) return false;
      }
      if(filter === "admin") return u.role === "admin";
      if(filter === "user") return u.role !== "admin";
      if(filter === "deactivated") return !!u.deactivated;
      if(filter === "unconfigured") return isUnconfigured(u);
      return true;
    });

    var admins = adminUsersCache.filter(function(u){ return u.role === "admin"; }).length;
    document.getElementById("adminUserCount").textContent =
      (shown.length === adminUsersCache.length
        ? adminUsersCache.length + " account" + (adminUsersCache.length === 1 ? "" : "s")
        : shown.length + " of " + adminUsersCache.length) +
      " · " + admins + " admin" + (admins === 1 ? "" : "s");

    empty.style.display = shown.length ? "none" : "block";
    list.innerHTML = "";

    shown.forEach(function(u){
      var isSelf = u.id === currentUser.id;
      var unconfigured = isUnconfigured(u);
      var name = u.full_name || u.email;
      var row = document.createElement("div");
      row.className = "admin-user-row" + (u.deactivated ? " is-deactivated" : "");
      row.setAttribute("data-uid", u.id);
      row.innerHTML =
        '<div class="admin-user-main">'+
          '<div class="admin-user-name" dir="auto">'+escapeHtml(name)+
            (isSelf ? ' <span class="admin-badge role-you">You</span>' : '')+
            (u.deactivated ? ' <span class="admin-badge deactivated">Deactivated</span>' : '')+
            (unconfigured ? ' <span class="admin-badge unconfigured">No schedule</span>' : '')+
          '</div>'+
          '<div class="admin-user-meta" dir="auto">'+escapeHtml(u.email)+' · '+
            Number(u.entry_count).toLocaleString()+' entries · Last seen '+escapeHtml(fmtRelative(u.last_sign_in_at))+
          '</div>'+
        '</div>'+
        // The role toggle sits on the same row as the account actions so an
        // admin never has to hold "who is an admin" in their head across two
        // different screens the way the old Team & Access card required.
        '<div class="role-toggle" role="group" aria-label="Role for '+escapeAttr(name)+'">'+
          '<button type="button" class="role-btn'+(u.role!=="admin"?" active":"")+'" data-role="user"'+
            ' aria-pressed="'+(u.role!=="admin")+'">Employee</button>'+
          '<button type="button" class="role-btn'+(u.role==="admin"?" active":"")+'" data-role="admin"'+
            ' aria-pressed="'+(u.role==="admin")+'">Admin</button>'+
        '</div>'+
        '<div class="admin-user-actions">'+
          '<button type="button" class="btn ghost small" data-view-user="'+u.id+'">Open Record</button>'+
          '<button type="button" class="btn ghost small" data-reset="'+u.id+'">Reset Password</button>'+
          (isSelf ? '' :
            '<button type="button" class="btn ghost small" data-toggle-active="'+u.id+'">'+
              (u.deactivated ? "Reactivate" : "Deactivate")+'</button>'+
            '<button type="button" class="btn danger-ghost small" data-delete-user="'+u.id+'">Delete</button>')+
        '</div>';
      list.appendChild(row);
    });
  }

  document.getElementById("adminUserSearch").addEventListener("input", renderAdminPeople);
  document.getElementById("adminUserFilter").addEventListener("change", renderAdminPeople);

  document.getElementById("adminUsersList").addEventListener("click", async function(ev){
    var btn = ev.target.closest("button");
    if(!btn) return;

    var resetId = btn.getAttribute("data-reset");
    var toggleId = btn.getAttribute("data-toggle-active");
    var deleteId = btn.getAttribute("data-delete-user");
    var viewId = btn.getAttribute("data-view-user");
    var user = adminUsersCache.find(function(u){
      return u.id === (resetId || toggleId || deleteId || viewId);
    });
    if(!user) return;

    // Jump straight into someone's own view rather than making the admin hunt
    // for them in the header switcher. The viewing-other banner then explains
    // whose record any subsequent edit lands on.
    if(viewId){
      var sel = document.getElementById("viewerSelect");
      if(sel && sel.value !== viewId){
        sel.value = viewId;
        sel.dispatchEvent(new Event("change"));
      }
      document.querySelector('.tab-btn[data-tab="log"]').click();
      document.getElementById("appShell").scrollIntoView({behavior:"smooth", block:"start"});
      return;
    }

    // Password resets go through Supabase's own email flow — setting another
    // user's password directly would need the service-role key, which must
    // never live in browser code.
    if(resetId){
      var okReset = await showConfirm(
        "Send a password reset email to " + user.email + "? They'll get a link to choose a new password themselves.",
        {title:"Send reset email?", confirmText:"Send Email"}
      );
      if(!okReset) return;
      btn.disabled = true;
      try{
        var r = await supabase.auth.resetPasswordForEmail(user.email, {redirectTo: window.location.href});
        if(r.error) throw r.error;
        showToast("Password reset email sent to " + user.email + ".", "success");
      }catch(err){
        showToast("Couldn't send reset email: " + friendlyError(err), "error");
      }
      btn.disabled = false;
      return;
    }

    if(toggleId){
      var makeActive = !!user.deactivated;
      var okToggle = await showConfirm(
        makeActive
          ? "Reactivate " + user.email + "? They'll be able to sign in again."
          : "Deactivate " + user.email + "? They won't be able to sign in, but all " +
            Number(user.entry_count).toLocaleString() + " of their entries stay intact.",
        {title: makeActive ? "Reactivate account?" : "Deactivate account?",
         confirmText: makeActive ? "Reactivate" : "Deactivate", danger: !makeActive}
      );
      if(!okToggle) return;
      btn.disabled = true;
      try{
        var t = await supabase.rpc("admin_set_user_active", {target_id: user.id, make_active: makeActive});
        if(t.error) throw t.error;
        showToast(makeActive ? "Account reactivated." : "Account deactivated.", "success");
        await loadAdminPeople();
        await renderAuditLog();
      }catch(err){
        showToast(friendlyError(err), "error");
        btn.disabled = false;
      }
      return;
    }

    if(deleteId){
      // Two-step, same as Clear All: delete-user is the only other fully
      // irreversible action in the app, so it gets the same safety net —
      // including a nudge toward Deactivate, which keeps records intact and
      // can be undone, right before the point of no return.
      var deleteStep1 = await showConfirm(
        "Permanently delete " + user.email + " and all " + Number(user.entry_count).toLocaleString() +
        " of their attendance entries? If you just need to remove their access, Deactivate keeps their records intact and can be undone — Delete cannot.",
        {title:"Delete this user?", confirmText:"Continue", danger:true}
      );
      if(!deleteStep1) return;
      var okDelete = await showConfirm(
        "Delete " + user.email + " and all " + Number(user.entry_count).toLocaleString() +
        " entries? This can't be undone.",
        {title:"Last check", confirmText:"Delete Permanently", danger:true}
      );
      if(!okDelete) return;
      btn.disabled = true;
      try{
        var d = await supabase.rpc("admin_delete_user", {target_id: user.id});
        if(d.error) throw d.error;
        showToast("User deleted.", "success");
        await loadAdminSettingsOwners();
        await loadAdminPeople();
        await renderAdminStats();
        await renderAdminHealth();
        await renderAuditLog();
        await loadAllProfilesForSwitcher();
      }catch(err){
        showToast(friendlyError(err), "error");
        btn.disabled = false;
      }
    }
  });

  var AUDIT_LABELS = {
    insert:"Added", update:"Edited", delete:"Deleted",
    role_change:"Role changed", user_created:"User created",
    user_deactivated:"Deactivated", user_reactivated:"Reactivated", user_deleted:"User deleted",
    app_settings_change:"Org settings changed"
  };
  function auditActionClass(action){
    if(action === "insert") return "a-insert";
    if(action === "update" || action === "app_settings_change") return "a-update";
    if(action === "delete" || action === "user_deleted") return "a-delete";
    return "a-admin";
  }

  // A real before → after diff for an edited entry, not just its new state —
  // "Regular · 08:00–17:00" alone can't tell anyone it used to say 16:00.
  function fieldDiff(label, ov, nv, fmt){
    ov = ov == null || ov === "" ? null : ov;
    nv = nv == null || nv === "" ? null : nv;
    if(ov === nv) return null;
    var f = fmt || function(v){ return v == null ? "—" : String(v); };
    return label + ": " + f(ov) + " → " + f(nv);
  }
  function entryDiff(oldV, newV){
    oldV = oldV || {}; newV = newV || {};
    var bits = [
      fieldDiff("Type", oldV.type || "regular", newV.type || "regular", typeLabel),
      fieldDiff("In", oldV.clock_in, newV.clock_in, formatTime12),
      fieldDiff("Out", oldV.clock_out, newV.clock_out, formatTime12)
    ].filter(Boolean);
    // Free text, not a value with two states to arrow between — "changed"
    // says what happened without implying there's a meaningful "→" to show.
    if((oldV.note || "") !== (newV.note || "")) bits.push("Note changed");
    return bits.length ? bits.join(" · ") : "No visible change";
  }

  // `theme` is no longer a setting — the org-wide theme picker was retired with
  // the move to Atrium. The label stays because audit_log is append-only: rows
  // written while the picker existed still carry a theme diff, and without the
  // label those historical entries would render as a bare key or vanish.
  var APP_SETTINGS_LABELS = {
    announcement: "Announcement", announcement_active: "Announcement banner",
    allow_registration: "Allow registrations", theme: "Theme (retired)",
    default_settings: "Organisation defaults"
  };
  function appSettingsDiff(oldV, newV){
    oldV = oldV || {}; newV = newV || {};
    var bits = [];
    Object.keys(APP_SETTINGS_LABELS).forEach(function(key){
      var label = APP_SETTINGS_LABELS[key];
      if(key === "default_settings"){
        // A nested schedule object — a field-by-field diff here would be more
        // noise than signal, so just flag that the org's starting schedule moved.
        if(JSON.stringify(oldV[key] || {}) !== JSON.stringify(newV[key] || {})) bits.push(label + " updated");
        return;
      }
      var d = fieldDiff(label, oldV[key], newV[key], function(v){
        if(typeof v === "boolean") return v ? "on" : "off";
        return v == null ? "—" : String(v);
      });
      if(d) bits.push(d);
    });
    return bits.length ? bits.join(" · ") : "Settings saved";
  }

  function auditDetail(row){
    if(row.action === "role_change"){
      var oldRole = row.old_values && row.old_values.role;
      var newRole = row.new_values && row.new_values.role;
      if(oldRole && newRole && oldRole !== newRole) return oldRole + " → " + newRole;
      return "Profile updated";
    }
    if(row.action === "user_deleted"){
      var n = row.old_values && row.old_values.entries_removed;
      return n != null ? n + " entries removed" : "Account removed";
    }
    if(row.action === "app_settings_change") return appSettingsDiff(row.old_values, row.new_values);
    if(row.entry_date){
      if(row.action === "update") return entryDiff(row.old_values, row.new_values);
      var src = row.new_values || row.old_values || {};
      var bits = [];
      if(src.type) bits.push(typeLabel(src.type));
      if(src.clock_in) bits.push(formatTime12(src.clock_in) + (src.clock_out ? "–" + formatTime12(src.clock_out) : ""));
      return bits.join(" · ") || "—";
    }
    return "—";
  }

  // The RPC takes a row limit but no offset, so "show more" raises the ceiling
  // and re-fetches rather than paging. At audit-log scale that is cheaper than
  // it sounds, and it keeps the newest rows correct when activity is ongoing.
  var AUDIT_PAGE = 100;
  var auditLimit = AUDIT_PAGE;
  var auditRowsCache = [];

  function fillAuditUserFilter(){
    var sel = document.getElementById("auditFilterUser");
    var prev = sel.value;
    sel.innerHTML = '<option value="">Anyone</option>' +
      adminUsersCache.map(function(u){
        return '<option value="'+escapeAttr(u.id)+'">'+escapeHtml(u.full_name || u.email)+'</option>';
      }).join("");
    sel.value = adminUsersCache.some(function(u){ return u.id === prev; }) ? prev : "";
  }

  async function renderAuditLog(){
    var action = document.getElementById("auditFilterAction").value || null;
    var who = document.getElementById("auditFilterUser").value || null;
    var since = document.getElementById("auditFilterSince").value || "";
    var until = document.getElementById("auditFilterUntil").value || "";
    var search = (document.getElementById("auditFilterSearch").value || "").trim().toLowerCase();
    var res;
    try{
      res = await supabase.rpc("admin_audit_log",
        {limit_n: auditLimit, filter_action: action, filter_user: who});
      if(res.error) throw res.error;
    }catch(err){
      showToast("Couldn't load the activity log: " + friendlyError(err), "error");
      return;
    }
    var fetched = res.data || [];
    // The RPC takes no date range or text filter, so both are applied here.
    // The count below reports what is actually on screen, not what was fetched.
    var rows = fetched.filter(function(r){
      var day = (r.created_at || "").slice(0,10);
      if(since && day < since) return false;
      if(until && day > until) return false;
      if(search){
        var hay = ((r.actor_email||"") + " " + (r.target_email||"") + " " +
          (AUDIT_LABELS[r.action]||r.action||"") + " " + auditDetail(r)).toLowerCase();
        if(hay.indexOf(search) === -1) return false;
      }
      return true;
    });
    auditRowsCache = rows;

    var body = document.getElementById("auditBody");
    body.innerHTML = "";
    document.getElementById("auditEmpty").style.display = rows.length ? "none" : "block";
    document.getElementById("auditCount").textContent =
      rows.length + (fetched.length >= auditLimit ? "+" : "") +
      " entr" + (rows.length === 1 ? "y" : "ies");
    // Only offer more when the fetch came back full — otherwise this is all of it.
    document.getElementById("auditMoreWrap").style.display =
      fetched.length >= auditLimit ? "" : "none";

    rows.forEach(function(r){
      var tr = document.createElement("tr");
      var affected = r.entry_date
        ? fmtDate(r.entry_date) + (r.target_email ? " · " + r.target_email : "")
        : (r.target_email || "—");
      tr.innerHTML =
        "<td data-label='When'><span class=\"cell-label\">When</span>"+escapeHtml(fmtRelative(r.created_at))+"</td>"+
        "<td data-label='Who'><span class=\"cell-label\">Who</span>"+escapeHtml(r.actor_email || "System")+"</td>"+
        "<td data-label='Action'><span class=\"cell-label\">Action</span><span class='audit-action "+auditActionClass(r.action)+"'>"+
          escapeHtml(AUDIT_LABELS[r.action] || r.action)+"</span></td>"+
        "<td data-label='Affected'><span class=\"cell-label\">Affected</span>"+escapeHtml(affected)+"</td>"+
        "<td data-label='Details' class='audit-detail'><span class=\"cell-label\">Details</span>"+escapeHtml(auditDetail(r))+"</td>";
      body.appendChild(tr);
    });
  }

  function resetAuditPaging(){
    auditLimit = AUDIT_PAGE;
    return renderAuditLog();
  }

  document.getElementById("auditMoreBtn").addEventListener("click", async function(){
    this.disabled = true;
    auditLimit += AUDIT_PAGE;
    await renderAuditLog();
    this.disabled = false;
  });

  document.getElementById("auditExportBtn").addEventListener("click", function(){
    if(!auditRowsCache.length){
      showToast("Nothing to export with the current filters.", "error");
      return;
    }
    var head = ["Timestamp","Actor","Action","Affected user","Entry date","Details"];
    var lines = [head.map(csvCell).join(",")];
    auditRowsCache.forEach(function(r){
      lines.push([
        r.created_at || "",
        r.actor_email || "System",
        AUDIT_LABELS[r.action] || r.action || "",
        r.target_email || "",
        r.entry_date || "",
        auditDetail(r)
      ].map(csvCell).join(","));
    });
    download("activity-log-" + todayStr() + ".csv", lines.join("\r\n"), "text/csv;charset=utf-8");
    showToast("Exported " + auditRowsCache.length + " log entries.", "success");
  });

  // Quoted always: notes and names carry commas, quotes and newlines, and a
  // leading =, + or - would be executed as a formula by a spreadsheet.
  function csvCell(v){
    var s = String(v == null ? "" : v);
    if(/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  async function loadAppSettings(){
    try{
      var res = await supabase.from("app_settings").select("*").eq("id", 1).maybeSingle();
      if(res.error) throw res.error;
      var s = res.data || {};
      document.getElementById("setAllowRegistration").checked = s.allow_registration !== false;
      document.getElementById("setAnnouncementActive").checked = !!s.announcement_active;
      document.getElementById("setAnnouncement").value = s.announcement || "";
      fillDefaultsForm(s.default_settings);
      applyAppSettings(s);
    }catch(err){
      // Non-fatal: the app works without org settings. Surfaced rather than
      // swallowed so a misconfigured announcement isn't invisible.
      showToast("Couldn't load app settings — announcements may not be shown.", "error");
    }
  }

  // Applies org-wide settings that affect every user, not just admins.
  function applyAppSettings(s){
    var banner = document.getElementById("announcementBanner");
    if(s && s.announcement_active && s.announcement){
      document.getElementById("announcementText").textContent = s.announcement;
      banner.classList.add("show");
    } else {
      banner.classList.remove("show");
    }
    var regBtn = document.getElementById("showRegisterBtn");
    if(regBtn) regBtn.style.display = (s && s.allow_registration === false) ? "none" : "";
  }

  // ---------- Organisation defaults ----------
  // app_settings.default_settings is what handle_new_user() copies into a new
  // account's user_settings row. The column existed from the start but nothing
  // ever wrote to it, so it stayed {} and every new employee silently started
  // on DEFAULT_SETTINGS instead of the organisation's actual working week.
  var defaultsAreSet = false;

  function buildDefaultsDayPicker(){
    var wrap = document.getElementById("defaultsDayPicker");
    wrap.innerHTML = DAY_NAMES.map(function(name, i){
      return '<input type="checkbox" id="dwd'+i+'" value="'+i+'"><label for="dwd'+i+'">'+DAY_FULL[i]+'</label>';
    }).join("");
  }

  function fillDefaultsForm(raw){
    defaultsAreSet = !!(raw && typeof raw === "object" && Object.keys(raw).length);
    var d = normalizeSettings(raw || {});
    DAY_NAMES.forEach(function(_, i){
      var box = document.getElementById("dwd"+i);
      if(box) box.checked = d.workDays.indexOf(i) !== -1;
    });
    document.getElementById("dTargetH").value = Math.floor(d.targetMin / 60);
    document.getElementById("dTargetM").value = d.targetMin % 60;
    document.getElementById("dIn").value = d.standardIn;
    document.getElementById("dOut").value = d.standardOut;
    document.getElementById("dGrace").value = d.graceMin;
    document.getElementById("dRemind").value = d.remindAfterHours;
    document.getElementById("dLeaveDays").value = d.annualLeaveDays;
    renderPeriodRows(d.periods, "defaultsPeriodsList");

    document.getElementById("adminDefaultsState").textContent = defaultsAreSet
      ? "Set — new accounts start here"
      : "Not set — new accounts fall back to Sun–Thu, 8h";
  }

  function readDefaultsForm(){
    var days = [];
    DAY_NAMES.forEach(function(_, i){
      var box = document.getElementById("dwd"+i);
      if(box && box.checked) days.push(i);
    });
    if(!days.length){
      showToast("Pick at least one working day.", "error");
      return null;
    }
    var h = parseInt(document.getElementById("dTargetH").value, 10);
    var m = parseInt(document.getElementById("dTargetM").value, 10);
    if(isNaN(h)) h = 0;
    if(isNaN(m)) m = 0;
    if(h < 0 || m < 0 || m > 59){
      showToast("Minutes must be between 0 and 59.", "error");
      return null;
    }
    if(h === 0 && m === 0){
      showToast("A target of zero would make every worked day look like overtime.", "error");
      return null;
    }
    var rawPeriods = readPeriodRows("defaultsPeriodsList");
    var periodsErr = validatePeriods(rawPeriods);
    if(periodsErr){ showToast(periodsErr, "error"); return null; }
    // Run it through the same normaliser every other schedule goes through, so
    // a value that would be rejected on a personal schedule can't enter the org
    // default by the back door.
    return normalizeSettings({
      workDays: days,
      targetMin: h * 60 + m,
      standardIn: document.getElementById("dIn").value || DEFAULT_SETTINGS.standardIn,
      standardOut: document.getElementById("dOut").value || DEFAULT_SETTINGS.standardOut,
      graceMin: document.getElementById("dGrace").value,
      remindAfterHours: document.getElementById("dRemind").value,
      annualLeaveDays: document.getElementById("dLeaveDays").value,
      periods: rawPeriods
    });
  }

  document.getElementById("saveDefaultsBtn").addEventListener("click", async function(){
    var btn = this;
    var defaults = readDefaultsForm();
    if(!defaults) return;
    btn.disabled = true;
    try{
      var res = await supabase.from("app_settings").update({
        default_settings: defaults,
        updated_at: new Date().toISOString(),
        updated_by: currentUser.id
      }).eq("id", 1);
      if(res.error) throw res.error;
      fillDefaultsForm(defaults);
      showToast("Organisation defaults saved. New accounts will start with this schedule.", "success");
    }catch(err){
      showToast("Couldn't save the defaults: " + friendlyError(err), "error");
    }
    btn.disabled = false;
  });

  // Backfills people who never got a settings row. Deliberately never touches
  // anyone who already has one — an admin fixing onboarding must not silently
  // overwrite a schedule someone is already being measured against.
  document.getElementById("seedSettingsBtn").addEventListener("click", async function(){
    var btn = this;
    var defaults = readDefaultsForm();
    if(!defaults) return;

    await loadAdminSettingsOwners();
    if(!adminSettingsOwners){
      showToast("Couldn't check who already has a schedule, so nothing was changed.", "error");
      return;
    }
    var missing = adminUsersCache.filter(function(u){ return !adminSettingsOwners.has(u.id); });
    if(!missing.length){
      showToast("Everyone already has their own schedule. Nothing to do.", "info");
      return;
    }

    var names = missing.slice(0, 4).map(function(u){ return u.full_name || u.email; });
    var ok = await showConfirm(
      missing.length + " " + (missing.length === 1 ? "person has" : "people have") +
      " no schedule of their own (" + names.join(", ") +
      (missing.length > 4 ? " and " + (missing.length - 4) + " more" : "") + ")." +
      "\n\nThey'll be given the defaults above. Nobody who already has a schedule is touched.",
      {title:"Give these people the default schedule?", confirmText:"Apply to " + missing.length}
    );
    if(!ok) return;

    btn.disabled = true;
    var done = 0, failed = 0;
    for(var i = 0; i < missing.length; i++){
      btn.textContent = "Applying " + (i+1) + " of " + missing.length + "…";
      try{
        await sbSaveSettings(missing[i].id, defaults);
        done++;
      }catch(err){ failed++; }
    }
    btn.disabled = false;
    btn.textContent = "Give these to people with no schedule";

    await loadAdminSettingsOwners();
    renderAdminPeople();
    await renderAdminHealth();
    showToast(
      "Applied to " + done + " " + (done === 1 ? "person" : "people") + "." +
      (failed ? " " + failed + " failed." : ""),
      failed ? "error" : "success"
    );
  });

  // Announcement/sign-up and Theme live in separate Admin accordion sections
  // now, each with its own Save button, but they're one row of app_settings —
  // saving from either section commits the whole row, so a value changed in
  // one section and left unsaved is still picked up when the other is saved.
  async function saveAppSettings(btn, successMsg){
    var payload = {
      allow_registration: document.getElementById("setAllowRegistration").checked,
      announcement_active: document.getElementById("setAnnouncementActive").checked,
      announcement: document.getElementById("setAnnouncement").value.trim(),
      updated_at: new Date().toISOString(),
      updated_by: currentUser.id
    };
    if(payload.announcement_active && !payload.announcement){
      showToast("Add an announcement message before turning the banner on.", "error");
      return;
    }
    btn.disabled = true;
    try{
      var res = await supabase.from("app_settings").update(payload).eq("id", 1);
      if(res.error) throw res.error;
      applyAppSettings(payload);
      showToast(successMsg, "success");
    }catch(err){
      showToast("Couldn't save app settings: " + friendlyError(err), "error");
    }
    btn.disabled = false;
  }

  document.getElementById("saveAppSettingsBtn").addEventListener("click", function(){
    saveAppSettings(this, "App settings saved.");
  });

  // ---------- Data health ----------
  // Each check is a counted query rather than a client-side scan, so it stays
  // honest as the table grows and never pulls the whole database down to the
  // phone. head:true means no rows travel at all — only the count.
  async function countEntries(build){
    var q = supabase.from("entries").select("id", {count:"exact", head:true});
    var res = await build(q);
    if(res.error) throw res.error;
    return res.count || 0;
  }

  async function renderAdminHealth(){
    var wrap = document.getElementById("adminAttentionList");
    var today = todayStr();
    var horizon = dateToStr(new Date(Date.now() + 400*24*60*60*1000));
    var findings = [];

    try{
      var noSchedule = adminSettingsOwners
        ? adminUsersCache.filter(function(u){ return !adminSettingsOwners.has(u.id); }).length
        : null;

      var results = await Promise.all([
        // Clocked in, never clocked out, on a day that has already ended. These
        // are the days that quietly count as a full shortfall in the aggregates.
        countEntries(function(q){
          return q.not("clock_in","is",null).is("clock_out",null).lt("date", today);
        }),
        // Regular days carrying no hours at all — usually an import or a bulk
        // apply that landed on a working day and blanked it.
        countEntries(function(q){
          return q.eq("type","regular").is("clock_in",null).is("clock_out",null).lt("date", today);
        }),
        // Dated beyond any plausible roster. The CHECK constraint stops the
        // year-9999 case now, but older rows predate it.
        countEntries(function(q){ return q.gt("date", horizon); })
      ]);

      if(noSchedule !== null){
        findings.push({
          count: noSchedule,
          title: noSchedule === 1 ? "1 person has no schedule of their own"
                                  : noSchedule + " people have no schedule of their own",
          note: "Their hours, lateness and leave are all measured against the fallback " +
                "Sunday–Thursday 08:00–16:00 week. Set the organisation defaults below, then apply them.",
          clear: "Everyone has their own schedule."
        });
      }
      findings.push({
        count: results[0],
        title: results[0] === 1 ? "1 open shift from a past day" : results[0] + " open shifts from past days",
        note: "Someone clocked in and never clocked out. Each one counts as a full day's shortfall until it is corrected.",
        clear: "No unfinished shifts."
      });
      findings.push({
        count: results[1],
        title: results[1] === 1 ? "1 blank working day" : results[1] + " blank working days",
        note: "Regular days holding no clock times at all, usually from an import or a company-wide apply.",
        clear: "No blank working days."
      });
      findings.push({
        count: results[2],
        title: results[2] === 1 ? "1 entry dated far in the future" : results[2] + " entries dated far in the future",
        note: "More than 400 days ahead. These distort the year filter and the year-over-year chart.",
        clear: "No implausible dates."
      });
    }catch(err){
      wrap.innerHTML = '<p class="settings-hint" style="margin:0;">Couldn\'t run the data checks: ' +
        escapeHtml(friendlyError(err)) + '</p>';
      return;
    }

    // Worst first, but clean checks are still listed — an admin needs to see
    // that a check ran and passed, not be left guessing whether it ran at all.
    findings.sort(function(a, b){ return b.count - a.count; });
    wrap.innerHTML = findings.map(function(f){
      return '<div class="attention-item" role="listitem">'+
        '<span class="attention-count'+(f.count ? '' : ' is-clear')+'">'+(f.count ? f.count : '✓')+'</span>'+
        '<div class="attention-body">'+
          '<div class="attention-title">'+escapeHtml(f.count ? f.title : f.clear)+'</div>'+
          (f.count ? '<div class="attention-note">'+escapeHtml(f.note)+'</div>' : '')+
        '</div>'+
      '</div>';
    }).join("");
  }

  document.getElementById("refreshStatsBtn").addEventListener("click", function(){ renderAdmin(); });
  document.getElementById("refreshAuditBtn").addEventListener("click", resetAuditPaging);
  document.getElementById("auditFilterAction").addEventListener("change", resetAuditPaging);
  document.getElementById("auditFilterUser").addEventListener("change", resetAuditPaging);
  document.getElementById("auditFilterSince").addEventListener("change", resetAuditPaging);
  document.getElementById("auditFilterUntil").addEventListener("change", resetAuditPaging);
  document.getElementById("auditFilterSearch").addEventListener("input", resetAuditPaging);

  async function renderAdmin(){
    // Belt and braces. The tab button is hidden for employees and every RPC and
    // policy behind this screen re-checks is_admin() server-side, but a stale
    // tab left open across a demotion should not keep painting the console.
    if(!isAdmin){
      document.getElementById("adminUsersList").innerHTML = "";
      document.getElementById("auditBody").innerHTML = "";
      return;
    }

    // Owners first: both the People list and the health panel need to know who
    // has a schedule, and neither should render a half-answer.
    await loadAdminSettingsOwners();

    var bulkFrom = document.getElementById("bulkApplyFromDate");
    var bulkTo = document.getElementById("bulkApplyToDate");
    if(!bulkFrom.value) bulkFrom.value = todayStr();
    if(!bulkTo.value) bulkTo.value = bulkFrom.value;

    await Promise.all([
      renderAdminStats(),
      loadAdminPeople(),
      resetAuditPaging(),
      loadAppSettings()
    ]);
    await renderAdminHealth();
  }

  // ---------- Sign-in / sign-out transitions ----------
  async function handleSignedIn(user){
    currentUser = {id:user.id, email:user.email};

    try{
      var res = await supabase.from("profiles").select("*").eq("id", user.id).single();
      if(res.error) throw res.error;
      currentProfile = res.data;
    }catch(err){
      // The profile-creation trigger can lag by a beat right after signup — retry once.
      await new Promise(function(r){ setTimeout(r, 700); });
      try{
        var res2 = await supabase.from("profiles").select("*").eq("id", user.id).single();
        currentProfile = res2.data;
      }catch(err2){
        currentProfile = {id:user.id, email:user.email, full_name:null, role:"user"};
      }
    }

    isAdmin = currentProfile.role === "admin";
    viewedUserId = currentUser.id;
    viewedProfile = currentProfile;
    refreshAvatars();

    if(isAdmin){
      await loadAllProfilesForSwitcher();
      document.getElementById("viewerSwitchWrap").style.display = "flex";
      document.getElementById("teamTabBtn").style.display = "";
      document.getElementById("adminBtn").style.display = "";
      layoutBottomNav();
    } else {
      document.getElementById("viewerSwitchWrap").style.display = "none";
      document.getElementById("teamTabBtn").style.display = "none";
      document.getElementById("adminBtn").style.display = "none";
      layoutBottomNav();
    }

    showApp();
    buildDayPicker();
    // Built before loadAppSettings() below, which fills it from
    // app_settings.default_settings.
    buildDefaultsDayPicker();
    document.getElementById("fDate").value = todayStr();
    document.getElementById("fToDate").value = todayStr();
    updateLiveClock();
    syncTimers();
    await loadDataForViewedUser();
    fillSettingsForm();
    // Org-wide settings (announcement banner, registration toggle) apply to
    // everyone, so this runs regardless of admin status.
    await loadAppSettings();
    setTimeout(updateTabsScrollHint, 0);
  }

  function handleSignedOut(){
    stopTimers();
    currentUser = null; currentProfile = null;
    viewedUserId = null; viewedProfile = null;
    allProfiles = []; isAdmin = false; isOwnData = true;
    entries = []; settings = Object.assign({}, DEFAULT_SETTINGS);
    dismissedReminders = {};
    document.getElementById("signInForm").reset();
    document.getElementById("registerForm").reset();
    setAuthMsg("signInError", ""); setAuthMsg("registerError", ""); setAuthMsg("registerSuccess", "");
    document.getElementById("signInForm").style.display = "flex";
    document.getElementById("registerForm").style.display = "none";
    showAuthScreen();
  }

  // ---------- Init ----------
  var copyrightText = "© " + new Date().getFullYear() + " Aseel Thalnoon. All rights reserved.";
  document.getElementById("copyrightLine").textContent = copyrightText;
  document.getElementById("copyrightLineAuth").textContent = copyrightText;

  // The clock and reminder timers used to run unconditionally from load — on the
  // sign-in screen, and in background tabs — so the page never idled and phones
  // paid for a 1 Hz repaint they could not see. Both now pause when the document
  // is hidden or nobody is signed in, and resync immediately on return.
  var clockTimer = null, reminderTimer = null;
  function timersRunning(){ return clockTimer !== null; }
  function startTimers(){
    if(timersRunning()) return;
    updateLiveClock();
    clockTimer = setInterval(updateLiveClock, 1000);
    reminderTimer = setInterval(renderReminder, 60000);
  }
  function stopTimers(){
    if(clockTimer !== null){ clearInterval(clockTimer); clockTimer = null; }
    if(reminderTimer !== null){ clearInterval(reminderTimer); reminderTimer = null; }
  }
  function syncTimers(){
    if(document.visibilityState === "visible" && currentUser) startTimers();
    else stopTimers();
  }
  document.addEventListener("visibilitychange", function(){
    syncTimers();
    // Coming back after a long pause: the clock and any open-shift reminder
    // would otherwise show whatever they showed when the tab was hidden.
    if(document.visibilityState === "visible" && currentUser){
      updateLiveClock();
      renderReminder();
    }
  });

  updateLiveClock();

  var resizeTimer;
  window.addEventListener("resize", function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 150);
  });

  if(!supabaseConfigured){
    showAuthScreen();
  } else {
    supabase.auth.onAuthStateChange(function(event, session){
      // The reset-password email link lands here as PASSWORD_RECOVERY, not a
      // normal SIGNED_IN — it must show the "choose a new password" form
      // instead of falling through to handleSignedIn() below, which would
      // otherwise silently drop the visitor straight into the dashboard on
      // their old password without ever prompting them to set a new one.
      if(event === "PASSWORD_RECOVERY"){
        recoverySessionUser = session && session.user;
        showResetPasswordScreen();
        return;
      }
      // handleSignedIn() is a full cold start: it re-fetches the profile, resets
      // the theme, resets the entry form to today, and — most damagingly — resets
      // viewedUserId back to the signed-in user. Firing it for every event meant a
      // routine hourly token refresh silently yanked an admin out of the employee
      // record they were editing and wiped any half-filled form. Only genuine
      // sign-in / sign-out transitions should re-boot the app.
      if(event === "TOKEN_REFRESHED" || event === "USER_UPDATED" || event === "INITIAL_SESSION"){
        if(event === "INITIAL_SESSION" && session && session.user && !currentUser){
          // The one case where INITIAL_SESSION must boot: a restored session on load.
        } else {
          return;
        }
      }
      if(session && session.user){
        // Already signed in as this user — nothing to re-initialise.
        if(currentUser && currentUser.id === session.user.id) return;
        // Deferred out of the callback: Supabase holds an internal auth lock
        // while it runs, and calling back into supabase.* from inside it is a
        // documented deadlock hazard. handleSignedIn awaits a profiles query
        // immediately, so it must not run inline here.
        var u = session.user;
        setTimeout(function(){ handleSignedIn(u); }, 0);
      } else {
        handleSignedOut();
      }
    });
  }
})();

// Registered at module scope (not inside the app's IIFE) since it's
// independent of sign-in state. Service workers require HTTPS (or
// localhost) — this silently no-ops on file:// or plain HTTP, which is
// expected when just opening the file directly to test.
if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").catch(function(){
      // Not fatal — the app still works, it just won't be installable
      // as a PWA until served over HTTPS (e.g. GitHub Pages).
    });
  });
}

