// The values that do not change: day names, day types and what each one means
// for a target, the localStorage keys, the default settings object, the VAPID
// public half.
//
// First piece lifted out of app.js, which had grown to ten thousand lines in
// one IIFE. It went first because it is the only part with no dependency in
// either direction -- nothing here reads the app's state, and nothing here
// calls anything outside this file -- so moving it is a change of address and
// nothing else.
//
// Declarations stay `var` and keep their exact wording on purpose. Several
// suites in tests/ pull these blocks out by matching the text of the line that
// opens them (see tests/extract.js), so `export var TYPE_LABELS` would have
// quietly stopped resolving. The export list lives at the bottom instead,
// where no extraction range reaches it -- which also keeps ESM syntax out of
// the CommonJS vm sandbox those suites run the extracted code in.

var DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
var DAY_FULL  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
var TYPE_LABELS = {
  // "WFH" here against "Work From Home" in the picker meant the day you
  // chose and the day you later read back were named differently, in the
  // only one of the nine types that disagreed with itself. The table has
  // room — "Half Day Leave" and "Public Holiday" are the same length.
  regular:"Regular", wfh:"Work From Home", halfleave:"Half Day Leave", leave:"Annual Leave",
  sick:"Sick Leave", trip:"Business Trip", training:"Training", holiday:"Public Holiday",
  // "Other" alone gave no clue that this is an EXCUSED absence — it reads as
  // a shrug, and sat in a list where every other option states what it is.
  // The stored value is untouched; this is the display label only, so the
  // log, calendar, print report and audit history all relabel together.
  other:"Other (Excused)"
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
var PUSH_PROMPT_SNOOZE_KEY = "attendance_ledger_push_prompt_snooze_v1";
var PUSH_PROMPT_SNOOZE_DAYS = 7;

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

// VAPID public keys are meant to be public — the private half never leaves
// the send-push Edge Function's own secrets. This one is paired with
// whatever VAPID_PRIVATE_KEY is set as that function's secret; the two
// must be regenerated and redeployed together, never independently.
var VAPID_PUBLIC_KEY = "BJlxibKyLbjnTvhH6hFdlNHSugC15FqdNxT55UJbY0RJtn3DGIWMTX4XG0FKB-K1H8SbvGcWYhLpmCD58OiD-es";

export {
  DAY_NAMES, DAY_FULL, TYPE_LABELS, typeLabel, CAL_STATUS_LABELS,
  EXCUSED_TYPES, HALF_TYPES, WORKED_TYPES, countsAsWorked, NO_TARGET_TYPES,
  DISMISS_KEY, SNOOZE_KEY, BACKUP_KEY, BACKUP_REMIND_DAYS,
  PUSH_PROMPT_SNOOZE_KEY, PUSH_PROMPT_SNOOZE_DAYS,
  DEFAULT_SETTINGS, VAPID_PUBLIC_KEY
};
