// localStorage, and the one function that decides what a settings object is
// allowed to contain.
//
// safeGet/safeSet exist because localStorage is not always there to be written
// to -- Safari's private mode, a browser with site data blocked, a full quota
// -- and a throw from a setItem call is not a reason for the surrounding
// feature to stop. safeSet reports the loss in the page rather than swallowing
// it, since the person's next action might be closing a tab holding the only
// copy of something.
//
// normalizeSettings is the boundary that stops malformed settings entering the
// app, from either storage or an imported backup file. It is deliberately
// total: every branch ends in a value, so it cannot hand back a half-valid
// object, and a field it does not recognise falls back to the default rather
// than to undefined.
import { DEFAULT_SETTINGS } from "./constants.js";

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

export { safeGet, safeSet, normalizeSettings };
