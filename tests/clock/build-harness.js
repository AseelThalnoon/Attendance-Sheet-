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
async function sbUpsertEntry(){
  window.__saveCalls++;
  return new Promise(function(res, rej){ window.__resolveSave = res; window.__rejectSave = rej; });
}

// Stands in for loadDataForViewedUser(). The real one awaits two network
// fetches and then calls updateViewingBanner(); the button-state lines below
// are that function's block, extracted verbatim, because re-enabling the
// buttons mid-flight is exactly what the reload-window test probes.
window.__reloadCalls = 0;
window.__resolveReload = null;
window.__skipReload = false;
async function loadDataForViewedUser(){
  window.__reloadCalls++;
  if(window.__skipReload) return;
  await new Promise(function(res){ window.__resolveReload = res; });
${["clockInBtn", "clockOutBtn", "stickyClockInBtn", "stickyClockOutBtn"]
  .map(id => "  " + line(`document.getElementById("${id}").disabled = !isOwnData;`).trim())
  .join("\n")}
  ${line('document.getElementById("bnClockBtn").classList.toggle("disabled", !isOwnData);').trim()}
}
`;

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
module.exports = { OUT };
