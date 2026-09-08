// Builds a page around the real consumeShortcutAction() and quickClockOut(),
// extracted verbatim from app.js, with backend deps stubbed. What this suite
// actually protects: the boot-time dispatch a push notification's "Clock
// Out" action button depends on (see sw.js's notificationclick, which
// navigates to ?action=out-date&date=...) routing to the right entry and the
// right write — not push delivery itself, which needs a real push service
// and is out of reach of an automated suite (see tests/push/README notes in
// the test file's own header).
const fs = require("fs");
const path = require("path");
const { slice } = require("../extract");

const OUT = path.join(__dirname, "harness.html");

const stubs = `
var isOwnData = true, editingId = null, dismissedReminders = {};
var currentUser = { id: "u1" };
var viewedUserId = "u1";
var settings = { periods: [], standardOut: "16:00" };
function scheduleFor(){ return { standardOut: settings.standardOut }; }
function formatTime12(t){ return t; }
function fmtDate(d){ return d; }
function friendlyError(e){ return (e && e.message) || String(e); }
function persistDismissals(){}
function renderAll(){}
window.__toasts = [];
function showToast(m){ window.__toasts.push(m); }

window.__upsertCalls = [];
window.__resolveUpsert = null; window.__rejectUpsert = null;
async function sbUpsertEntry(userId, payload, existingId){
  window.__upsertCalls.push({ userId: userId, payload: payload, existingId: existingId });
  return new Promise(function(res, rej){ window.__resolveUpsert = res; window.__rejectUpsert = rej; });
}
window.__applyCalls = [];
function applyLocalUpsert(saved, forUserId){ window.__applyCalls.push({ saved: saved, forUserId: forUserId }); }

// punchClock() itself isn't under test here (see tests/clock) -- only that
// consumeShortcutAction() still reaches it for the manifest-shortcut cases
// (?action=in|out) and doesn't regress while gaining the out-date case.
window.__punchCalls = [];
async function punchClock(kind){ window.__punchCalls.push(kind); }
`;

const html = `<!doctype html><meta charset="utf-8"><title>push actions harness</title>
<script>
${stubs}
var entries = [];
${slice("async function quickClockOut(entry, btn){", "// ---------- Log ----------")}
${slice("function consumeShortcutAction(){", "document.getElementById(\"clockInBtn\")")}
window.consumeShortcutAction = consumeShortcutAction;
window.setEntries = function(list){ entries.length = 0; list.forEach(function(e){ entries.push(e); }); };
</script>
`;

fs.writeFileSync(OUT, html);
if(!/async function quickClockOut/.test(html)) throw new Error("harness is missing quickClockOut");
if(!/function consumeShortcutAction/.test(html)) throw new Error("harness is missing consumeShortcutAction");
module.exports = { OUT };
