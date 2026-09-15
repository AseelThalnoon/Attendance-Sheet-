// Clock arithmetic and date formatting. Everything here takes its arguments
// and returns a value: no app state, no DOM, no Supabase.
//
// Second piece lifted out of app.js's IIFE, and for the same reason as
// src/constants.js — these functions already had no dependency on anything
// around them, so moving them is a change of address rather than a change of
// behaviour. What is left behind in app.js is the half that reads `settings`
// (isScheduled, scheduleFor, computeEntry, weekStartDow), which cannot follow
// until the app's state has an owner of its own.
//
// Declarations stay `var`/`function` and keep their exact wording: the clock
// and audit suites pull these out by matching the opening line (see
// tests/extract.js), so the export list goes at the bottom, past the end of
// every range those suites ask for.

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
// Calendar-day arithmetic, not 24-hour arithmetic: dateFromStr builds a local
// midnight and setDate rolls the month and the DST boundary for us, where
// subtracting 86400000ms would land on the wrong day twice a year.
function dayBefore(dateStr){
  var d = dateFromStr(dateStr);
  d.setDate(d.getDate() - 1);
  return dateToStr(d);
}
function fmtDate(s){
  return dateFromStr(s).toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"});
}
function fmtDateLong(s){
  return dateFromStr(s).toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric", year:"numeric"});
}
// Weekday + month + day, no year — for lists already scoped to one month
// (the Team roster's recent-days lines, the activity feed), where the year
// and often the month too would just repeat what the toolbar already says.
function fmtDateShort(s){
  return dateFromStr(s).toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric"});
}
// Month and day alone, for a list whose year is already fixed by a control
// above it — the Log's own Year select, which makes ", 2026" the same four
// characters repeated down every row of the month.
function fmtDateNoYear(s){
  return dateFromStr(s).toLocaleDateString(undefined,{month:"short", day:"numeric"});
}

export {
  uid, pad2, timeToMinutes, formatTime12, minutesToHoursStr, minutesOnlyStr,
  signed, dateFromStr, dateToStr, todayStr, dayBefore,
  fmtDate, fmtDateLong, fmtDateShort, fmtDateNoYear
};
