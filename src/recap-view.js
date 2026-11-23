// The Recap tab, as HTML. src/recap.js does the arithmetic; this only says it.
//
// One page, readable at a glance (2026-11-23, owner: "It is really
// complicated. Make sure it is easy for the user and can be understood from
// the first look", then "Make it perfect"): a headline that answers "how did
// it go?", then one card per area -- Hours, Start time, Logging, Time off.
// Hours leads because making the day's hours is what the team's rule judges;
// Start time counts a day late only when it started after 8:00 and came up
// short, as the rest of the app does (2026-11-18 rule, applied here
// 2026-11-23).
//
// Every card is the same five parts in the same order, so four of them side
// by side line up row for row (index.html lays them on a subgrid):
//   1. the area, with its verdict (Better, Steady, Slipped)
//   2. one figure -- the one the verdict was decided on
//   3. that figure's usual ("Usually about 3", "Last year: about 15")
//   4. the days behind it: a chart, a list, a month by month
//   5. one line on what to do ("Try this") or that nothing needs doing
// A part with nothing to say is an empty box, so the rows still line up.
//
// Tone, as the owner chose it: an honest coach. An area that slipped gets one
// concrete thing to try; one that held or improved gets a short line saying
// so. Time off is described, never judged.
//
// Every text node is one whole sentence or label: the Arabic is matched
// against the English text node by text node (src/i18n.js), and a sentence
// split across nodes would come out half translated.
import { DAY_FULL } from "./constants.js";
import { formatTime12, minutesToHoursStr, pad2, dateFromStr, fmtDateShort, fmtDateNoYear } from "./time.js";
import { locale } from "./i18n.js";

function esc(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function clock(min){ return min == null ? "—" : formatTime12(pad2(Math.floor(min / 60) % 24) + ":" + pad2(min % 60)); }
function clockShort(min){ return clock(min).replace(/\s*\S+$/, ""); }
function dur(min){ return minutesToHoursStr(Math.abs(Math.round(min))); }
function plural(n, one, many){ return n + " " + (n === 1 ? one : (many || one + "s")); }
// Days off can be half days: 2.5, never 2.4999.
function days(n){ return String(Math.round(n * 2) / 2); }
function monthName(mk, style){ return dateFromStr(mk + "-01").toLocaleDateString(locale(), { month: style || "long" }); }
function stdMinOf(cur){ return cur.standardIn ? +cur.standardIn.slice(0, 2) * 60 + +cur.standardIn.slice(3, 5) : null; }
var RANGE_FMT = null;
function range(a, b){
  if(a === b) return fmtDateNoYear(a);
  try{
    RANGE_FMT = RANGE_FMT || new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" });
    if(RANGE_FMT.formatRange) return RANGE_FMT.formatRange(dateFromStr(a), dateFromStr(b));
  }catch(e){}
  return fmtDateNoYear(a) + " – " + fmtDateNoYear(b);
}
// "9 in 10" reads faster than 88%.
function oneIn(rate){
  if(rate == null) return "—";
  if(rate === 0) return "none";
  if(rate === 1) return "all";
  if(rate >= 0.95) return "nearly all";
  if(rate >= 0.5) return Math.round(rate * 10) + " in 10";
  return "1 in " + Math.round(1 / rate);
}
// The line under a figure: against the usual in a month, last year in a year.
function usual(isYear, value){ return isYear ? "Last year: " + value : "Usually " + value; }

var OFF_WORDS = {
  leave: ["day of annual leave", "days of annual leave"], sick: ["sick day", "sick days"],
  other: ["excused day", "excused days"], halfleave: ["half-day leave", "half-day leaves"]
};
function offParts(byType){
  return Object.keys(byType).map(function(t){
    var w = OFF_WORDS[t] || [t, t], n = byType[t];
    return n + " " + (n === 1 ? w[0] : w[1]);
  });
}
function offChips(byType){
  var parts = offParts(byType);
  return parts.length ? '<div class="recap-chips">' + parts.map(function(p){ return '<span class="recap-chip">' + esc(p) + "</span>"; }).join("") + "</div>" : "";
}
function countTypes(list){
  var by = {};
  list.forEach(function(a){ by[a.type] = (by[a.type] || 0) + 1; });
  return by;
}

// ---------- The five parts ----------

var ICONS = {
  start: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  hours: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 5 8 4 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 4-8 8.5s8 3.5 8 8.5"/>',
  logging: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  off: '<path d="M12 4a8 8 0 0 1 8 8H4a8 8 0 0 1 8-8z"/><path d="M12 12v6a2 2 0 0 1-4 0"/>'
};
var ARROW = {
  better: '<path d="M12 19V5M6 11l6-6 6 6"/>', slipped: '<path d="M12 5v14M6 13l6 6 6-6"/>', steady: '<path d="M5 12h14"/>'
};
var VERDICT = { better: "Better", steady: "Steady", slipped: "Slipped" };
function svg(paths, size){
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
}
function area(o){
  return '<section class="card recap-area' + (o.surface ? " is-" + o.surface : "") + '" aria-labelledby="' + o.id + '" tabindex="-1">' +
    '<div class="recap-area-head"><span class="recap-area-icon">' + svg(ICONS[o.icon], 17) + '</span>' +
    '<h3 class="recap-area-name" id="' + o.id + '">' + esc(o.name) + "</h3>" +
    (o.verdict ? '<span class="recap-verdict is-' + o.verdict + '">' + svg(ARROW[o.verdict], 13) + "<span>" + esc(VERDICT[o.verdict]) + "</span></span>" : "") + "</div>" +
    '<div class="recap-fig"><span class="recap-fig-num">' + esc(o.fig) + '</span><span class="recap-fig-label">' + esc(o.label) + "</span></div>" +
    '<p class="recap-usual">' + (o.usual ? esc(o.usual) : "") + "</p>" +
    '<div class="recap-visual">' + (o.visual || "") + "</div>" +
    '<div class="recap-coach">' + coach(o.tip, o.well) + "</div></section>";
}
function coach(tip, well){
  if(tip) return '<div class="recap-take is-tip"><span class="recap-take-label">Try this</span><span class="recap-take-text">' + esc(tip) + "</span></div>";
  if(well) return '<div class="recap-take is-well"><span class="recap-take-label">Well done</span><span class="recap-take-text">' + esc(well) + "</span></div>";
  return "";
}
function caption(text){ return '<p class="recap-caption">' + esc(text) + "</p>"; }
function more(text){ return '<p class="recap-more">' + esc(text) + "</p>"; }
function legend(items){
  return '<div class="recap-legend">' + items.map(function(it){
    return '<span><i class="recap-mark is-' + it[0] + '" aria-hidden="true"></i><span>' + esc(it[1]) + "</span></span>";
  }).join("") + "</div>";
}
// A list of days, each one a button that opens that day: the entry if there
// is one, the entry form on that date if not.
function dayRows(list){
  return '<div class="recap-rows">' + list.map(function(r){
    return '<button type="button" class="recap-row is-day" data-recap-day="' + r.date + '"><span class="recap-row-label">' + esc(fmtDateShort(r.date)) + "</span>" +
      '<span class="recap-row-value' + (r.tone ? " is-" + r.tone : "") + '">' + esc(r.value) + "</span></button>";
  }).join("") + "</div>";
}
// Month by month, for the Year: the month, a small mark of its value, the value.
function monthRows(list){
  return '<div class="recap-rows is-months">' + list.map(function(r){
    return '<div class="recap-row"><span class="recap-row-label">' + esc(r.label) + "</span>" + r.mark +
      '<span class="recap-row-value">' + esc(r.value) + "</span></div>";
  }).join("") + "</div>";
}
function bar(frac){ return '<span class="recap-bar" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%"></i></span>'; }
function meter(label, value, frac){
  return '<div class="recap-meter"><div class="recap-meter-top"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>" + bar(frac) + "</div>";
}

// ---------- The headline ----------

function list(words){ return words.length > 1 ? words.slice(0, -1).join(", ") + " and " + words[words.length - 1] : words[0] || ""; }
function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// Says what happened, in the words of the cards under it: "More short days
// and more late days than usual", never just "slipped".
function headline(v, isCurrent, isYear){
  var why = v.why || {}, good = [], bad = [];
  if(v.hours === "slipped") bad.push(why.hours === "depth" ? "more time short" : "more short days");
  else if(v.hours === "better") good.push("fewer short days");
  if(v.punctuality === "slipped") bad.push("more late days"); else if(v.punctuality === "better") good.push("fewer late days");
  if(v.consistency === "slipped") bad.push(why.consistency === "live" ? "more days typed in later" : "more days not logged");
  else if(v.consistency === "better") good.push(why.consistency === "live" ? "more days clocked in on arrival" : "more days logged");
  var than = isYear ? " than last year" : " than usual", g = list(good), b = list(bad);
  if(g && b) return cap(g) + ", but " + b + than + ".";
  if(b) return cap(b) + than + ".";
  if(g) return cap(g) + than + ", and nothing slipped.";
  return isYear ? "A steady year, much like last year." : "A steady month, much like usual.";
}
// With no usual to hold the month against yet, the headline says what the
// month holds: "5 full days and 1 short day so far."
function facts(m){
  var cur = m.cur, when = m.isCurrent ? " so far." : " in " + monthName(m.key) + ".";
  if(!cur.worked) return m.isCurrent ? "Nothing to count yet." : "No days to count in " + monthName(m.key) + ".";
  var short = cur.short.length, full = cur.worked - short;
  if(!short) return "Every day full" + when;
  return list((full ? [plural(full, "full day")] : []).concat([plural(short, "short day")])) + when;
}
// (3) On a phone the cards stack, so the four verdicts sit in one row under
// the headline, each a way to its card. Hidden from 761px, where the four
// cards are all in view.
var JUMP = [["recapAreaHours", "hours", "Hours", "hours"], ["recapAreaStart", "start", "Start time", "punctuality"],
  ["recapAreaLogging", "logging", "Logging", "consistency"], ["recapAreaOff", "off", "Time off", null]];
function jump(v){
  if(!v) return "";
  return '<nav class="recap-jump" aria-label="' + esc("Areas") + '">' + JUMP.map(function(j){
    var verdict = j[3] ? v[j[3]] : null;
    return '<button type="button" class="recap-jump-btn' + (verdict ? " is-" + verdict : "") + '" data-recap-jump="' + j[0] + '">' +
      '<span class="recap-jump-top">' + svg(ICONS[j[1]], 15) + (verdict ? svg(ARROW[verdict], 13) : "") + "</span>" +
      '<span class="recap-jump-name">' + esc(j[2]) + "</span>" + (verdict ? '<span class="sr-only">' + esc(VERDICT[verdict]) + "</span>" : "") + "</button>";
  }).join("") + "</nav>";
}
function hero(title, basis){
  return '<header class="recap-hero"><p class="recap-headline display">' + esc(title) + "</p>" +
    (basis ? '<p class="recap-basis">' + esc(basis) + "</p>" : "") + "</header>";
}

// ---------- Start time ----------

function startsChart(cur){
  var cols = cur.days.filter(function(d){ return cur.startByDate[d.date] != null; });
  var std = stdMinOf(cur);
  if(cols.length < 2 || std == null) return "";
  var lateOn = {};
  cur.lateDays.forEach(function(x){ lateOn[x.date] = true; });
  var lo = Math.min.apply(null, cur.starts.concat([std])), hi = Math.max.apply(null, cur.starts.concat([std]));
  lo = Math.floor((lo - 10) / 15) * 15; hi = Math.ceil((hi + 10) / 15) * 15;
  var span = hi - lo, y = function(m){ return (((m - lo) / span) * 100).toFixed(1); };
  // A dot after the 8:00 line is only a ring -- late -- when that day came up
  // short; a day that made its hours is on time however it started.
  var marks = cols.map(function(d){
    var st = cur.startByDate[d.date];
    return '<span class="recap-col" title="' + esc(fmtDateShort(d.date) + " · " + clock(st)) + '"><i class="recap-mark is-' + (lateOn[d.date] ? "after" : "before") + '" style="top:' + y(st) + '%"></i></span>';
  }).join("");
  var late = cur.lateDays.map(function(x){ return fmtDateNoYear(x.date); });
  var aria = "Start time on each workday. " + (late.length ? plural(late.length, "late day") + ": " + late.join(", ") + "." : "No late days.");
  return '<div class="recap-chart" role="img" aria-label="' + esc(aria) + '" style="--cols:' + cols.length + '">' +
    '<span class="recap-chart-axis" aria-hidden="true"><span style="top:' + y(std) + '%">' + esc(clockShort(std)) + "</span></span>" +
    '<div class="recap-plot"><span class="recap-std" aria-hidden="true" style="top:' + y(std) + '%"></span>' + marks + "</div>" +
    '<div class="recap-chart-ends" aria-hidden="true"><span>' + esc(fmtDateNoYear(cols[0].date)) + "</span><span>" +
    esc(fmtDateNoYear(cols[cols.length - 1].date)) + "</span></div></div>";
}
// Start time, judged the way the rest of the app judges it (2026-11-18): a
// start after 8:00 is late only on a day that came up short. The figure is
// those days; when you usually arrive is said under it, as information.
function startArea(m, cur, base, v, tip, isYear){
  var std = stdMinOf(cur), verdict = v ? v.punctuality : null, n = cur.lateDays.length;
  var stdText = std != null ? clock(std) : "the start time";
  var typical = cur.medStart != null ? "Typical start " + clock(cur.medStart) : "";
  var usualText = "";
  if(base && base.worked){
    var expected = Math.round(base.lateRate * cur.worked);
    usualText = usual(isYear, expected ? "about " + expected : "none");
  } else if(typical){
    usualText = typical; typical = "";
  }
  var visual = "";
  if(isYear){
    var top = Math.max.apply(null, m.perMonth.map(function(x){ return x.late; }).concat([1]));
    visual = (typical ? caption(typical) : "") + monthRows(m.perMonth.map(function(x){
      return { label: monthName(x.key, "short"), value: x.late ? plural(x.late, "day") : "none", mark: bar(x.late / top) };
    }));
  } else if(cur.starts.length){
    visual = (typical ? caption(typical) : "") + startsChart(cur) + legend([["before", "Not late"], ["after", "Late: after " + stdText + " on a short day"]]);
  }
  var tipText = null, well = null;
  if(tip){
    var stay = "On a late start, stay the full " + dur(tip.target) + ": in at " + clock(tip.inAt) + ", out at " + clock(tip.outAt) + ".";
    if(tip.kind === "lateRun") tipText = "Late days came in a run: " + range(tip.run.from, tip.run.to) + ". " + stay;
    else if(tip.kind === "lateWeekday") tipText = "Most late days fall on " + DAY_FULL[tip.dow] + "s: " + tip.count + " of " + tip.of + ". " + stay;
    else tipText = plural(tip.count, "day") + " started late and came up short. " + stay;
  } else if(verdict === "better"){
    well = (m.earliest ? "Earliest starts of any month yet. " : "") + "Fewer late days than " + (isYear ? "last year" : "usual") + ". Keep it up.";
  } else if(verdict === "steady"){
    well = n ? "Starts as usual. Nothing to change." : "No late days. Nothing to change.";
  }
  return area({ id: "recapAreaStart", icon: "start", name: "Start time", surface: "cream", verdict: verdict,
    fig: String(n), label: n === 1 ? "late day" : "late days", usual: usualText, visual: visual, tip: tipText, well: well });
}

// ---------- Hours ----------

function hoursArea(m, cur, base, v, tip, isYear){
  var verdict = v ? v.hours : null, why = v && v.why ? v.why.hours : null, n = cur.short.length;
  var usualText = "";
  if(base && base.worked){
    if(why === "depth"){
      // The count held but each short day ran deeper: say the total, both ways.
      usualText = isYear ? dur(cur.shortMin) + " short in all. Last year: about " + dur(base.shortMin / base.worked * cur.worked) + "."
        : dur(cur.shortMin) + " short in all, usually about " + dur(base.shortMin / base.worked * cur.worked);
    } else {
      var expected = Math.round(base.shortRate * cur.worked);
      usualText = usual(isYear, expected ? "about " + expected : "none");
    }
  } else if(cur.worked){
    usualText = "Out of " + plural(cur.worked, "day") + " worked";
  }
  var visual = "";
  if(isYear){
    var top = Math.max.apply(null, m.perMonth.map(function(x){ return x.short; }).concat([1]));
    visual = monthRows(m.perMonth.map(function(x){ return { label: monthName(x.key, "short"), value: x.short ? plural(x.short, "day") : "none", mark: bar(x.short / top) }; }));
  } else if(n){
    var worst = cur.short.slice().sort(function(a, b){ return (b.target - b.worked) - (a.target - a.worked); });
    var shown = worst.slice(0, 3).sort(function(a, b){ return a.date < b.date ? -1 : 1; });
    visual = (why === "depth" ? "" : caption(dur(cur.shortMin) + " short in total")) +
      dayRows(shown.map(function(x){ return { date: x.date, value: dur(x.target - x.worked) + " short", tone: "bad" }; })) +
      (n > 3 && !isYear ? '<button type="button" class="btn ghost small recap-see-all" data-recap-shortfall="' + m.key + '">' + esc("See all " + n + " short days") + "</button>" : "");
  }
  var tipText = null, well = null;
  if(tip){
    if(tip.kind === "halfDay") tipText = "On a half day, stay the full " + dur(tip.target) + ". " + fmtDateNoYear(tip.date) + " alone was " + dur(tip.min) + " of the " + dur(tip.total) + ".";
    else if(tip.kind === "lateStart") tipText = tip.count + " of " + plural(tip.of, "short day") + " started late. On a late start, stay the full " + dur(tip.target) + ".";
    else tipText = "The short days were about " + dur(tip.min) + " short each. Stay that much longer on those days.";
  } else if(verdict === "better"){
    well = "Fewer short days than " + (isYear ? "last year" : "usual") + ". Keep it up.";
  } else if(verdict === "steady"){
    well = "Hours are where they usually are.";
  }
  return area({ id: "recapAreaHours", icon: "hours", name: "Hours", surface: "", verdict: verdict,
    fig: String(n), label: n === 1 ? "short day" : "short days", usual: usualText, visual: visual, tip: tipText, well: well });
}

// ---------- Logging ----------

function loggingArea(m, cur, base, v, tip, isYear){
  var verdict = v ? v.consistency : null, why = v && v.why ? v.why.consistency : null;
  // The figure is the one the verdict was decided on: entries made on
  // arrival when that is what moved, otherwise workdays logged.
  var live = why === "live" && cur.liveKnown;
  var fig = live ? cur.live + " of " + cur.liveKnown : cur.logged + " of " + cur.workdays;
  var usualText = "";
  if(base){
    var rate = live ? base.liveRate : base.loggedRate;
    if(rate != null) usualText = usual(isYear, oneIn(rate));
  } else if(cur.liveKnown){
    usualText = "Clocked in on arrival: " + cur.live + " of " + cur.liveKnown;
  }
  // The other half of logging, as a small meter: entries made on arrival
  // under a figure of days logged, and the other way round.
  // With no usual, the line under the figure already says it.
  var visual = live ? meter("Days logged", cur.logged + " of " + cur.workdays, cur.workdays ? cur.logged / cur.workdays : 0)
    : base && cur.liveKnown ? meter("Clocked in on arrival", cur.live + " of " + cur.liveKnown, cur.live / cur.liveKnown) : "";
  if(isYear){
    visual += monthRows(m.perMonth.map(function(x){
      return { label: monthName(x.key, "short"), value: x.logged + " of " + x.workdays, mark: bar(x.workdays ? x.logged / x.workdays : 0) };
    }));
  } else if(cur.missing.length){
    // The days with nothing on them, each with the way to fix it.
    visual += caption("Not logged") + '<div class="recap-rows">' + cur.missing.slice(-3).map(function(d){
      return '<div class="recap-row is-fix"><span class="recap-row-label">' + esc(fmtDateShort(d)) + "</span>" +
        '<button type="button" class="btn ghost small recap-add" data-recap-day="' + d + '" aria-label="' + esc("Add " + fmtDateShort(d)) + '">Add</button></div>';
    }).join("") + "</div>" + (cur.missing.length > 3 ? more("and " + (cur.missing.length - 3) + " more") : "");
  }
  var tipText = null, well = null, nMiss = cur.missing.length;
  if(tip){
    if(tip.kind === "missing") tipText = tip.count === 1 ? fmtDateNoYear(tip.dates[0]) + " was not logged. Add it so it counts." : tip.count + " days were not logged. Add them so they count.";
    else tipText = plural(tip.count, "day was", "days were") + " typed in later. Clock in when you arrive: it is one tap.";
  } else if(verdict === "better"){
    well = why === "live" ? "More days clocked in on arrival. Keep it up." : "More days logged than " + (isYear ? "last year" : "usual") + ". Keep it up.";
  } else if(verdict === "steady"){
    if(isYear) well = "Steady, as usual.";
    else if(nMiss) well = nMiss === 1 ? "Steady. Add the missing day so it counts." : "Steady. Add the missing days so they count.";
    else well = "Every day logged. Nothing to change.";
  }
  return area({ id: "recapAreaLogging", icon: "logging", name: "Logging", surface: "gray", verdict: verdict,
    fig: fig, label: live ? "clocked in on arrival" : "days logged", usual: usualText, visual: visual, tip: tipText, well: well });
}

// ---------- Time off ----------

// The year's days off as one column a month, January on: a fixed height
// whatever the year holds, where a row a month ran to twelve rows beside
// cards of four.
function offByMonth(y){
  var last = y.isCurrent ? y.to.slice(0, 7) : y.year + "-12";
  Object.keys(y.off.byMonth).forEach(function(k){ if(k > last) last = k; });
  var cols = [], top = 1;
  for(var i = 1; i <= +last.slice(5, 7); i++){
    var k = y.year + "-" + pad2(i), n = y.off.byMonth[k] || 0;
    cols.push({ key: k, n: n }); if(n > top) top = n;
  }
  var aria = "Days off by month: " + cols.filter(function(c){ return c.n; }).map(function(c){ return monthName(c.key, "short") + " " + days(c.n); }).join(", ") + ".";
  return '<div class="recap-mchart" role="img" aria-label="' + esc(aria) + '" style="--cols:' + cols.length + '">' + cols.map(function(c){
    return '<span class="recap-mcol" aria-hidden="true"><b>' + (c.n ? esc(days(c.n)) : "") + '</b><span class="recap-mcol-area"><i style="height:' +
      (c.n ? Math.max(8, c.n / top * 100) : 0).toFixed(1) + '%"></i></span><span class="recap-mcol-label">' + esc(dateFromStr(c.key + "-01").toLocaleDateString(locale(), { month: "narrow" })) + "</span></span>";
  }).join("") + "</div>";
}

function timeOffArea(m, cur, base, isYear){
  var total = isYear ? m.off.total : cur.offDays;
  var usualText = "";
  if(!isYear && base){
    var x = base.offDays / Math.max(base.months || 1, 0.5);
    usualText = x < 0.5 ? "Usually less than 1 a month" : "Usually about " + Math.round(x) + " a month";
  }
  var visual = offChips(isYear ? m.off.byType : countTypes(cur.away));
  if(isYear && m.off.total) visual += offByMonth(m);
  // A weekday that holds most of the days off is the one pattern worth a line.
  var pat = isYear ? { byDow: m.off.byDow, total: m.off.total, top: m.off.top } : m.away;
  var since = isYear ? "this year" : "since " + monthName(m.away.since.slice(0, 7));
  if(pat.top != null) visual += '<p class="recap-pattern"><b>' + esc("Time off falls mostly on " + DAY_FULL[pat.top] + "s.") + "</b> <span>" +
    esc(days(pat.byDow[pat.top]) + " of " + days(pat.total) + " days off " + since + " were " + DAY_FULL[pat.top] + "s.") + "</span></p>";
  visual += '<p class="recap-foot">Remote days and public holidays are not counted.</p>';
  return area({ id: "recapAreaOff", icon: "off", name: "Time off", surface: "", verdict: null,
    fig: days(total), label: total === 1 ? "day off" : "days off", usual: usualText, visual: visual });
}

// ---------- The year picture ----------

var SQUARE_WORDS = { full: "full day", short: "short day", away: "day off", remote: "remote", missing: "not logged", open: "in progress" };
function picture(y){
  var c = y.cur;
  var full = c.days.filter(function(d){ return d.status === "full"; }).length;
  var short = c.short.length;
  var off = c.days.filter(function(d){ return d.status === "away"; }).length;
  var remote = c.days.filter(function(d){ return d.status === "remote"; }).length;
  var slots = y.order.length;
  var weeks = Math.max.apply(null, y.months.map(function(mo){ return mo.weeks.length; }).concat([1]));
  var grid = y.months.map(function(mo){
    return '<div class="recap-pic-row"><span class="recap-pic-month">' + esc(monthName(mo.key, "short")) + '</span><span class="recap-pic-weeks">' +
      mo.weeks.map(function(w){
        return '<span class="recap-pic-week">' + w.map(function(cell){
          var st = cell && cell.status;
          if(!st) return "<i></i>";
          var k = SQUARE_WORDS[st] ? st : "missing";
          return '<i class="recap-mark is-' + k + '" title="' + esc(fmtDateShort(cell.date) + ": " + SQUARE_WORDS[k]) + '"></i>';
        }).join("") + "</span>";
      }).join("") + "</span></div>";
  }).join("");
  var aria = "Every workday from " + fmtDateNoYear(y.from) + ", one square each: " + full + " full, " + short + " short, " + off + " off, " + remote + " remote.";
  var facts = [];
  if(y.shortRuns.length){
    var r = y.shortRuns.slice(-2);
    var sameSize = r.every(function(x){ return x.count === r[0].count; });
    facts.push("<b>" + esc(sameSize ? "Short days come " + r[0].count + " at a time:" : "Short days come in runs:") + "</b> <span>" +
      esc(r.map(function(x){ return range(x.from, x.to); }).join(" and ") + ". One short day tends to bring the next.") + "</span>");
  }
  var since = y.from > y.year + "-01-01" ? "Logged since " + fmtDateNoYear(y.from) : "From January";
  return '<section class="card recap-year" aria-labelledby="recapYearPic">' +
    '<div class="recap-year-main"><div class="recap-area-head"><h3 class="recap-area-name" id="recapYearPic">Every workday</h3>' +
    '<span class="recap-year-since">' + esc(since) + "</span></div>" +
    '<div class="recap-pic" role="img" aria-label="' + esc(aria) + '" style="--slots:' + slots + ";--weeks:" + weeks + '">' + grid + "</div>" +
    '<p class="recap-foot">' + esc("Each group is a week, " + DAY_FULL[y.order[0]] + " to " + DAY_FULL[y.order[slots - 1]] + ".") + "</p></div>" +
    '<div class="recap-year-side"><div class="recap-counts">' +
    [["full", full, full === 1 ? "full day" : "full days"], ["short", short, short === 1 ? "short day" : "short days"],
     ["away", off, off === 1 ? "day off" : "days off"], ["remote", remote, remote === 1 ? "remote day" : "remote days"]].map(function(k){
      return '<span><i class="recap-mark is-' + k[0] + '" aria-hidden="true"></i><b>' + k[1] + "</b><span>" + esc(k[2]) + "</span></span>";
    }).join("") + "</div>" + facts.map(function(f){ return '<p class="recap-pattern">' + f + "</p>"; }).join("") + "</div></section>";
}

// What the picture shows, in one line: the Year's headline when there is no
// last year to hold it against.
function yearTitle(y){
  var full = y.cur.days.filter(function(d){ return d.status === "full"; }).length, short = y.cur.short.length;
  if(full + short && full / (full + short) >= 0.7) return y.shortRuns.length ? "Mostly full days. The short ones come in runs." : "Mostly full days.";
  return y.isCurrent ? plural(short, "short day") + " so far this year." : plural(short, "short day") + " in " + y.year + ".";
}

// ---------- Entry points ----------

function areas(html){ return '<div class="recap-areas">' + html.join("") + "</div>"; }
function empty(title, text){
  return hero(title, "") + '<section class="card recap-empty"><p>' + esc(text) + "</p></section>";
}

// basis: the line under the headline saying what the month is held against.
// who: null on your own record; { name } when an admin is looking at someone
// else's, so nothing on the page says "your" to the wrong person.
export function monthPage(m, basis, who){
  var cur = m.cur, base = m.base, v = m.verdicts, t = m.tips || {};
  if(!m.hasRecord){
    return who ? empty("No recap yet.", "It fills in as days are logged.")
      : empty("Your first recap is on its way.", "It appears after your first full week of logging, and compares each month with your own usual once you have a few weeks behind you.");
  }
  // (1) A month with nothing logged in it -- before the record began, or in
  // a gap between logging stretches -- says so, and names any time off that
  // was recorded, instead of four cards of nothing.
  if(!(cur.worked + cur.remote.length + cur.missing.length + cur.unclosed.length)){
    if(m.isCurrent && !cur.away.length) return empty("Nothing to recap yet.", "This month's recap starts after its first workday.");
    var parts = offParts(countTypes(cur.away));
    return empty("Nothing logged in " + monthName(m.key) + ".", parts.length ? "Only time off was recorded: " + list(parts) + "." : "Recap counts logged days.");
  }
  // Hours first: making the day's hours is what the team's rule judges.
  return hero(v ? headline(v, m.isCurrent) : facts(m), basis) + jump(v) + areas([
    hoursArea(m, cur, base, v, t.hours, false),
    startArea(m, cur, base, v, t.punctuality, false),
    loggingArea(m, cur, base, v, t.consistency, false),
    timeOffArea(m, cur, base, false)
  ]);
}

export function yearPage(y){
  if(y.empty) return empty("Nothing logged this year yet.", "The year picture starts with the first logged workday.");
  var cmp = !!y.verdicts;
  var cur = cmp ? y.cmpCur : y.cur, base = cmp ? y.cmpBase : null, v = y.verdicts, t = y.tips || {};
  var basis = cmp
    ? "Compared with the same months of " + (+y.year - 1) + ": " + y.pairs.map(function(p){ return monthName(p[0], "short"); }).join(", ") + "."
    : y.isCurrent ? "Nothing from last year to compare yet. Next year, each month is set against the same month of " + y.year + "."
    : "Nothing from " + (+y.year - 1) + " to compare with.";
  var view = Object.assign({}, y, { earliest: false });
  return hero(cmp ? headline(v, y.isCurrent, true) : yearTitle(y), basis) + jump(v) + picture(y) + areas([
    hoursArea(view, cur, base, v, t.hours, true),
    startArea(view, cur, base, v, t.punctuality, true),
    loggingArea(view, cur, base, v, t.consistency, true),
    timeOffArea(y, y.cur, null, true)
  ]);
}
