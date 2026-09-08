// Builds a page around the real punchClock() and the real click listeners,
// extracted verbatim from index.html, with backend deps stubbed so a save can
// be held in flight and button state measured while it is pending.
const fs = require("fs");
const path = require("path");
const { slice, line } = require("../extract");

const OUT = path.join(__dirname, "harness.html");

const stubs = `
var isOwnData = true, entries = [], editingId = null, dismissedReminders = {};
var currentUser = { id: "u1" };
function todayStr(){ return "2026-08-14"; }
function nowTimeStr(){ return "09:00"; }
function formatTime12(t){ return t; }
function minutesToHoursStr(m){ return m + "m"; }
function computeEntry(){ return { workedMin: 480 }; }
function showToast(m){ window.__toasts.push(m); }
function fmtDate(d){ return d; }
// The offline path in punchClock() runs these on the way to queueing a punch.
// Stubbed because this suite measures the punch, not the repaint — but stubbed
// at all because they were previously absent, which meant an exception inside
// the try block was being swallowed by punchClock's own catch and the success
// path was only half exercised.
function renderAll(){}
function pulseSeal(){}
function pulseQuickClock(){}
function safeGet(){ return null; }
function safeSet(){ return true; }
function showQcNote(m){ window.__notes.push(m); }
async function showConfirm(){ return true; }
// Dismissed reminders are now persisted to localStorage, and backend errors are
// mapped to human sentences before display. Neither is what this suite measures.
function persistDismissals(){}
function friendlyError(e){ return (e && e.message) || String(e); }
window.__toasts = []; window.__notes = [];

// Counts how many punches actually reached the save call. Stays pending until
// the test resolves it, so the in-flight window can be inspected, not raced.
window.__saveCalls = 0;
window.__resolveSave = null; window.__rejectSave = null;
window.__saveArgs = [];
async function sbUpsertEntry(userId, payload){
  window.__saveCalls++;
  window.__saveArgs.push(payload);
  return new Promise(function(res, rej){ window.__resolveSave = res; window.__rejectSave = rej; });
}

// A successful punch used to close by re-fetching this person's entire
// history through loadDataForViewedUser(), whose own updateViewingBanner()
// call re-enabled every button before punchClock's finally{} ran — which is
// what made the punchInFlight flag (not button state) the thing actually
// worth testing. punchClock now patches the saved row into the in-memory
// entries array and re-renders synchronously instead, with no network gap
// in between, so applyLocalUpsert() is the one dependency that stands in
// for that whole step here — just a call counter, since this suite
// measures the punch, not the repaint.
window.__applyCalls = 0;
function applyLocalUpsert(saved, forUserId){ window.__applyCalls++; }
`;

// resolveOvernightTarget() is inside the extracted slice below, so its own
// dependencies have to be in scope too. They are pulled verbatim rather than
// stubbed because each one is part of the behaviour under test: dayBefore is
// calendar arithmetic that has to survive a month boundary and a DST shift,
// and the excused list and long-shift ceiling are what decide whether a
// clock-out is treated as a night shift or a forgotten punch. A hand-written
// copy here could not see a change to any of them — which is the failure mode
// tests/extract.js exists to prevent.
// punchClock() no longer drops a punch it cannot upload — it queues it — so the
// outbox is part of the function under test now, not a neighbour of it. Pulled
// verbatim for the same reason as everything else here.
const outboxDeps = slice("var OUTBOX_KEY =", "var flushing = false;");

const overnightDeps = [
  line("function pad2(n)"),
  slice("function dateFromStr(s){", "function todayStr()"),
  slice("function dayBefore(dateStr){", "function fmtDate(s){"),
  slice("function timeToMinutes(t){", "function formatTime12(t){"),
  line("var EXCUSED_TYPES ="),
  line("var LONG_SHIFT_MIN =")
].join("\n");

const listeners = ["clockInBtn", "clockOutBtn", "stickyClockInBtn", "stickyClockOutBtn"]
  .map(id => line(`document.getElementById("${id}").addEventListener("click", function(){ punchClock(`).trim())
  .join("\n");

const html = `<!doctype html><meta charset="utf-8"><title>clock harness</title>
<style>
${line(".bn-clock.disabled{")}
</style>
<button id="clockInBtn">In</button>
<button id="clockOutBtn">Out</button>
<button id="stickyClockInBtn">In</button>
<button id="stickyClockOutBtn">Out</button>
<button class="bn-clock" id="bnClockBtn">Clock</button>
<div id="stickyClock"></div>
<input id="fIn"><input id="fOut"><input id="fDate">
<div id="qcStatusNote"></div>
<script>
${stubs}
${overnightDeps}
${outboxDeps}
${slice("var punchInFlight = false;", "document.getElementById(\"clockInBtn\").addEventListener")}
${listeners}
// The real bottom-nav listener also refreshes the button's icon/label through
// render helpers that aren't in scope here; the punchClock dispatch is the
// part under test.
document.getElementById("bnClockBtn").addEventListener("click", function(){ punchClock("in"); });
window.punchClock = punchClock;
</script>
`;

fs.writeFileSync(OUT, html);
if(!/async function punchClock/.test(html)) throw new Error("harness is missing punchClock");
if(!/punchInFlight/.test(html)) throw new Error("harness is missing the punchInFlight guard");
if(!/async function resolveOvernightTarget/.test(html)) throw new Error("harness is missing resolveOvernightTarget");
if(!/function queuePunch/.test(html)) throw new Error("harness is missing the outbox");
module.exports = { OUT };
