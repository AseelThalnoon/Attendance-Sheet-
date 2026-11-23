// The Recap tab, as HTML. src/recap.js does the arithmetic; this only says it.
//
// One page, readable at a glance (rebuilt 2026-11-23, owner: "It is really
// complicated. Make sure it is easy for the user and can be understood from
// the first look"): a headline that answers "how did it go?", then one card
// per area -- Start time, Hours, Logging, Time off -- side by side on a
// desktop and stacked on a phone. Every card has the same five parts in the
// same order: the area and its verdict, one figure, how that compares with
// your usual, a small picture of the days behind it, and one line on what to
// do. Nothing is behind a swipe.
//
// Tone, as the owner chose it: an honest coach. An area that slipped gets one
// concrete thing to try; one that held or improved gets a short line saying
// so. Time off is described, never judged.
//
// Every text node is one whole sentence or label, because the Arabic is
// matched against the English text node by text node (src/i18n.js); a
// sentence split across nodes would come out half translated.
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
// "9 in 10" reads faster than 88%, and nobody has 0.31 of a short day.
function oneIn(rate){
  if(rate == null) return "—";
  if(rate === 0) return "none";
  if(rate === 1) return "all";
  if(rate >= 0.95) return "nearly all";
  if(rate >= 0.5) return Math.round(rate * 10) + " in 10";
  return "1 in " + Math.round(1 / rate);
}

var AWAY_WORDS = {
  wfh: ["remote day", "remote days"], trip: ["day on a trip", "days on a trip"],
  training: ["training day", "training days"], leave: ["day of annual leave", "days of annual leave"],
  halfleave: ["half-day leave", "half-day leaves"], sick: ["sick day", "sick days"], other: ["excused day", "excused days"]
};
function awayParts(byType){
  return Object.keys(byType).map(function(t){
    var w = AWAY_WORDS[t] || [t, t], n = byType[t];
    return n + " " + (n === 1 ? w[0] : w[1]);
  });
}
function countTypes(list){
  var by = {};
  list.forEach(function(a){ by[a.type] = (by[a.type] || 0) + 1; });
  return by;
}

// ---------- The pieces every card is made of ----------

var ICON = {
  better: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  slipped: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  steady: '<path d="M5 12h14"/>'
};
var VERDICT = { better: "Better", steady: "Steady", slipped: "Slipped" };
function verdictPill(v){
  if(!v) return "";
  return '<span class="recap-verdict is-' + v + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICON[v] + "</svg><span>" + esc(VERDICT[v]) + "</span></span>";
}
// One area: name and verdict, the figure, the comparison, a picture, a line.
function area(o){
  return '<section class="card recap-area' + (o.surface ? " is-" + o.surface : "") + (o.verdict ? " v-" + o.verdict : "") + '" aria-labelledby="' + o.id + '">' +
    '<div class="recap-area-head"><h3 class="recap-area-name" id="' + o.id + '">' + esc(o.name) + "</h3>" + verdictPill(o.verdict) + "</div>" +
    '<div class="recap-fig"><span class="recap-fig-num">' + esc(o.fig) + '</span><span class="recap-fig-label">' + esc(o.label) + "</span></div>" +
    (o.compare ? '<p class="recap-compare' + (o.compareTone ? " is-" + o.compareTone : "") + '">' + esc(o.compare) + "</p>" : "") +
    (o.visual ? '<div class="recap-visual">' + o.visual + "</div>" : "") +
    take(o.tip, o.well) + "</section>";
}
function take(tip, well){
  if(tip) return '<div class="recap-take is-tip"><span class="recap-take-label">Try this</span><span class="recap-take-text">' + esc(tip) + "</span></div>";
  if(well) return '<div class="recap-take is-well"><span class="recap-take-label">Well done</span><span class="recap-take-text">' + esc(well) + "</span></div>";
  return "";
}
function caption(text){ return '<p class="recap-caption">' + esc(text) + "</p>"; }
function legend(items){
  return '<div class="recap-legend">' + items.map(function(it){
    return '<span><i class="recap-mark is-' + it[0] + '" aria-hidden="true"></i><span>' + esc(it[1]) + "</span></span>";
  }).join("") + "</div>";
}
// Label on the left, value on the right; the list every card falls back on.
function rows(list, cls){
  return '<div class="recap-rows' + (cls ? " " + cls : "") + '">' + list.map(function(r){
    return '<div class="recap-row"><span class="recap-row-label">' + esc(r[0]) + "</span>" + (r[2] || "") +
      '<span class="recap-row-value' + (r[3] ? " is-" + r[3] : "") + '">' + esc(r[1]) + "</span></div>";
  }).join("") + "</div>";
}
function meter(label, value, rate, sub){
  return '<div class="recap-meter"><div class="recap-meter-top"><span>' + esc(label) + '</span><b>' + esc(value) + "</b></div>" +
    '<span class="recap-meter-bar" aria-hidden="true"><i style="width:' + Math.round((rate || 0) * 100) + '%"></i></span>' +
    (sub ? '<span class="recap-meter-sub">' + esc(sub) + "</span>" : "") + "</div>";
}

// ---------- The headline ----------

function headline(v){
  if(!v) return "How the month has gone.";
  var good = [], bad = [];
  if(v.punctuality === "better") good.push("Earlier starts"); else if(v.punctuality === "slipped") bad.push("your starts");
  if(v.hours === "better") good.push("fuller days"); else if(v.hours === "slipped") bad.push("your hours");
  if(v.consistency === "better") good.push("steadier logging"); else if(v.consistency === "slipped") bad.push("your logging");
  var g = good.length ? good.join(" and ") : "";
  g = g ? g.charAt(0).toUpperCase() + g.slice(1) : "";
  var b = bad.join(" and ");
  if(g && b) return g + ", but " + b + " slipped.";
  if(b) return b.charAt(0).toUpperCase() + b.slice(1) + " slipped.";
  if(g) return g + ", and nothing slipped.";
  return "A steady stretch, much like usual.";
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
  var lo = Math.min.apply(null, cur.starts.concat([std])), hi = Math.max.apply(null, cur.starts.concat([std]));
  lo = Math.floor((lo - 10) / 15) * 15; hi = Math.ceil((hi + 10) / 15) * 15;
  var span = hi - lo, y = function(m){ return (((m - lo) / span) * 100).toFixed(1); };
  var marks = cols.map(function(d){
    var st = cur.startByDate[d.date];
    return '<span class="recap-col"><i class="recap-mark is-' + (st > std ? "after" : "before") + '" style="top:' + y(st) + '%"></i></span>';
  }).join("");
  var after = cur.afterStart.map(function(x){ return fmtDateNoYear(x.date); });
  var aria = "Start time on each workday. " + (after.length ? plural(after.length, "start") + " came after " + clock(std) + ": " + after.join(", ") + "." : "Every start was by " + clock(std) + ".");
  return '<div class="recap-chart" role="img" aria-label="' + esc(aria) + '" style="--cols:' + cols.length + '">' +
    '<span class="recap-chart-axis" aria-hidden="true"><span style="top:' + y(std) + '%">' + esc(clockShort(std)) + "</span></span>" +
    '<div class="recap-plot" aria-hidden="true"><span class="recap-std" style="top:' + y(std) + '%"></span>' + marks + "</div>" +
    '<div class="recap-chart-ends" aria-hidden="true"><span>' + esc(fmtDateNoYear(cols[0].date)) + "</span><span>" +
    esc(fmtDateNoYear(cols[cols.length - 1].date)) + "</span></div></div>";
}
function startArea(m, cur, base, v, tip, isYear){
  var std = stdMinOf(cur), verdict = v ? v.punctuality : null;
  var d = base && cur.medStart != null && base.medStart != null ? cur.medStart - base.medStart : null;
  var compare = null, tone = null;
  if(d != null){
    // Under three minutes is a clock's rounding, not a change.
    if(isYear) compare = Math.abs(d) < 3 ? "Same as last year" : dur(d) + (d > 0 ? " later" : " earlier") + " than last year";
    else compare = Math.abs(d) < 3 ? "Same as your usual " + clock(base.medStart) : dur(d) + (d > 0 ? " later" : " earlier") + " than your usual " + clock(base.medStart);
    tone = d >= 3 ? "bad" : d <= -3 ? "good" : null;
  } else if(std != null){
    compare = "Your day starts at " + clock(std);
  }
  var visual = "";
  if(isYear){
    visual = rows(m.perMonth.filter(function(x){ return x.medStart != null; }).map(function(x){
      return [monthName(x.key, "short"), clock(x.medStart), std != null
        ? '<span class="recap-dot-track" aria-hidden="true"><i style="inset-inline-start:' + Math.max(0, Math.min(100, 50 + (x.medStart - std) * 50 / 30)).toFixed(1) + '%"></i></span>' : ""];
    }));
  } else if(cur.starts.length){
    var late = cur.afterStart.length;
    visual = caption(late ? "After " + clock(std) + " on " + late + " of " + plural(cur.worked, "day") : "In by " + clock(std) + " every day") +
      startsChart(cur) + legend([["before", "By " + clock(std)], ["after", "After " + clock(std)]]);
  }
  var tipText = null, well = null;
  var stdText = std != null ? clock(std) : "your start time";
  if(tip){
    var aim = std != null ? clock(std - 10) : "ten minutes earlier";
    if(tip.kind === "lateRun") tipText = "One late start pulled in more: " + range(tip.run.from, tip.run.to) + ". After a late day, aim to be in by " + aim + " the next morning.";
    else if(tip.kind === "lateWeekday") tipText = DAY_FULL[tip.dow] + "s are your late starts, " + tip.count + " of " + tip.of + ". Aim to be in by " + aim + " on " + DAY_FULL[tip.dow] + "s.";
    else tipText = plural(tip.count, "start") + " came after " + stdText + ". Aim to be in by " + aim + ".";
  } else if(verdict === "better"){
    well = "Keep starting before " + stdText + "." + (m.lateRun ? " Only " + range(m.lateRun.from, m.lateRun.to) + " broke the habit." : "");
  } else if(verdict === "steady"){
    well = "Your usual start. Nothing to change.";
  }
  return area({ id: "recapAreaStart", name: "Start time", surface: "", verdict: verdict,
    fig: clock(cur.medStart), label: "typical start", compare: compare, compareTone: tone,
    visual: visual, tip: tipText, well: well });
}

// ---------- Hours ----------

function hoursArea(m, cur, base, v, tip, isYear){
  var verdict = v ? v.hours : null, n = cur.short.length;
  var compare = null;
  if(base && base.shortRate != null){
    var expected = Math.round(base.shortRate * cur.worked);
    compare = (isYear ? "Last year: about " : "Usually about ") + expected;
    if(expected === 0) compare = isYear ? "Last year: none" : "Usually none";
  } else if(cur.worked){
    compare = "Out of " + plural(cur.worked, "day") + " worked";
  }
  var visual = "";
  if(isYear){
    visual = rows(m.perMonth.map(function(x){
      return [monthName(x.key, "short"), x.short ? plural(x.short, "short day") + ", " + dur(x.shortMin) : "no short days"];
    }));
  } else if(n){
    var list = cur.short.slice().sort(function(a, b){ return (b.target - b.worked) - (a.target - a.worked); });
    var shown = list.slice(0, 3).sort(function(a, b){ return a.date < b.date ? -1 : 1; });
    visual = caption(dur(cur.shortMin) + " short in total") + rows(shown.map(function(x){
      return [fmtDateShort(x.date), dur(x.target - x.worked) + " short", "", "bad"];
    })) + (n > 3 ? '<p class="recap-more">' + esc("and " + plural(n - 3, "more short day")) + "</p>" : "");
  }
  var tipText = null, well = null;
  if(tip){
    if(tip.kind === "halfDay") tipText = "On a half day, stay the full " + dur(tip.target) + ". " + fmtDateNoYear(tip.date) + " alone was " + dur(tip.min) + " of the " + dur(tip.total) + ".";
    else if(tip.kind === "lateStart") tipText = "On a late start, leave at the time your clock card shows, not at your usual time. " + tip.count + " of your " + plural(tip.of, "short day") + " started late.";
    else tipText = "Your short days were about " + dur(tip.min) + " short each. Staying that much longer on those days covers them.";
  } else if(verdict === "better"){
    well = "Fewer short days than " + (isYear ? "last year" : "usual") + ". Keep it up.";
  } else if(verdict === "steady"){
    well = "Your hours are where they usually are.";
  }
  return area({ id: "recapAreaHours", name: "Hours", surface: "cream", verdict: verdict,
    fig: String(n), label: n === 1 ? "short day" : "short days", compare: compare,
    compareTone: verdict === "slipped" ? "bad" : verdict === "better" ? "good" : null,
    visual: visual, tip: tipText, well: well });
}

// ---------- Logging ----------

function loggingArea(m, cur, base, v, tip, isYear){
  var verdict = v ? v.consistency : null;
  var compare = null;
  if(base && base.loggedRate != null && cur.loggedRate != null){
    var same = Math.abs(cur.loggedRate - base.loggedRate) < 0.02;
    compare = isYear ? (same ? "Same as last year" : "Last year: " + oneIn(base.loggedRate)) : (same ? "Same as usual" : "Usually " + oneIn(base.loggedRate));
  }
  var visual = "";
  if(cur.liveKnown){
    visual += meter("Clocked in on arrival", cur.live + " of " + cur.liveKnown, cur.live / cur.liveKnown,
      base && base.liveRate != null ? "usually " + oneIn(base.liveRate) : "");
  }
  if(isYear){
    visual += rows(m.perMonth.map(function(x){ return [monthName(x.key, "short"), x.logged + " of " + x.workdays + " logged"]; }));
  } else if(cur.missing.length){
    // The days with nothing on them, each with the way to fix it.
    var shown = cur.missing.slice(-3);
    visual += caption("Not logged") + rows(shown.map(function(d){
      return [fmtDateShort(d), "", '<button type="button" class="btn ghost small recap-add" data-recap-add="' + d + '" aria-label="' + esc("Add " + fmtDateShort(d)) + '">Add</button>'];
    }), "is-fix") + (cur.missing.length > 3 ? '<p class="recap-more">' + esc("and " + (cur.missing.length - 3) + " more") + "</p>" : "");
  }
  var tipText = null, well = null;
  if(tip){
    if(tip.kind === "missing") tipText = tip.dates.map(fmtDateNoYear).join(", ") + (tip.count > tip.dates.length ? " and " + (tip.count - tip.dates.length) + " more" : "") +
      (tip.count === 1 ? " was" : " were") + " not logged. Add " + (tip.count === 1 ? "it" : "them") + " from the Log tab so " + (tip.count === 1 ? "it counts." : "they count.");
    else tipText = plural(tip.count, "day was", "days were") + " typed in later. Clock in when you arrive; it is one tap.";
  } else if(verdict){
    well = !cur.missing.length && (cur.liveRate == null || cur.liveRate >= 0.85) ? "Nothing to change. This is your steadiest area." : "Steady, as usual.";
  }
  return area({ id: "recapAreaLogging", name: "Logging", surface: "gray", verdict: verdict,
    fig: cur.logged + " of " + cur.workdays, label: "workdays logged", compare: compare,
    visual: visual, tip: tipText, well: well });
}

// ---------- Time off ----------

function usualRate(base){ return base.away.length / Math.max(base.months || 1, 0.5); }
function timeOffArea(m, cur, base, isYear){
  var count = isYear ? m.off.total : cur.away.length;
  var compare = null;
  if(!isYear && base){
    var x = usualRate(base);
    compare = x < 0.5 ? "Usually less than 1 a month" : "Usually about " + Math.round(x) + " a month";
  }
  var visual = "";
  var parts = awayParts(isYear ? m.off.byType : countTypes(cur.away));
  if(parts.length) visual += '<div class="recap-chips">' + parts.map(function(p){ return '<span class="recap-chip">' + esc(p) + "</span>"; }).join("") + "</div>";
  // The year's time off is the whole calendar year (April's leave is this
  // year's leave whether or not April was clocked), so its months are the
  // ones that had any, not the picture's.
  if(isYear){
    visual += rows(Object.keys(m.off.byMonth).sort().map(function(k){ return [monthName(k, "short"), plural(m.off.byMonth[k], "day")]; }));
  }
  // A weekday that holds most of the days away is the one pattern worth a
  // line; public holidays are nobody's choice and are left out.
  var pat = m.away, byDow = pat.byDow, top = pat.top, total = pat.total, since = "since " + monthName(pat.since.slice(0, 7));
  if(isYear){
    byDow = m.off.byDow; total = m.off.total; since = "this year";
    var t = byDow.indexOf(Math.max.apply(null, byDow));
    top = (byDow[t] >= 3 && byDow[t] * 2 >= total) ? t : null;
  }
  var lines = "";
  if(top != null) lines += '<p class="recap-pattern"><b>' + esc("Your time away falls on " + DAY_FULL[top] + "s.") + "</b> <span>" +
    esc(byDow[top] + " of your " + total + " days away " + since + " were " + DAY_FULL[top] + "s.") + "</span></p>";
  lines += '<p class="recap-foot">Public holidays are not counted.</p>';
  return area({ id: "recapAreaOff", name: "Time off", surface: "", verdict: null,
    fig: String(count), label: count === 1 ? "day away" : "days away", compare: compare,
    visual: visual + lines });
}

// ---------- The year picture ----------

function picture(y){
  var c = y.cur;
  var full = c.days.filter(function(d){ return d.status === "full"; }).length;
  var short = c.short.length;
  var away = c.days.filter(function(d){ return d.status === "away"; }).length;
  var remote = c.days.filter(function(d){ return d.status === "remote"; }).length;
  var slots = y.order.length;
  var weeks = Math.max.apply(null, y.months.map(function(mo){ return mo.weeks.length; }).concat([1]));
  var grid = y.months.map(function(mo){
    return '<div class="recap-pic-row"><span class="recap-pic-month">' + esc(monthName(mo.key, "short")) + '</span><span class="recap-pic-weeks">' +
      mo.weeks.map(function(w){
        return '<span class="recap-pic-week">' + w.map(function(cell){
          var s = cell && cell.status;
          return s ? '<i class="recap-mark is-' + (["full", "short", "remote", "away", "open"].indexOf(s) !== -1 ? s : "missing") + '"></i>' : "<i></i>";
        }).join("") + "</span>";
      }).join("") + "</span></div>";
  }).join("");
  var aria = "Every workday from " + fmtDateNoYear(y.from) + ", one square each: " + full + " full, " + short + " short, " + away + " away, " + remote + " remote.";
  var facts = [];
  if(y.shortRuns.length){
    var r = y.shortRuns.slice(-2);
    var sameSize = r.every(function(x){ return x.count === r[0].count; });
    facts.push("<b>" + esc(sameSize ? "Short days come " + r[0].count + " at a time:" : "Short days come in runs:") + "</b> <span>" +
      esc(r.map(function(x){ return range(x.from, x.to); }).join(" and ") + ". One short day tends to bring the next.") + "</span>");
  }
  var since = y.from > y.year + "-01-01" ? "Since you began logging on " + fmtDateNoYear(y.from) : "From January";
  return '<section class="card recap-year" aria-labelledby="recapYearPic">' +
    '<div class="recap-year-main"><div class="recap-area-head"><h3 class="recap-area-name" id="recapYearPic">Every workday</h3>' +
    '<span class="recap-year-since">' + esc(since) + "</span></div>" +
    '<div class="recap-pic" role="img" aria-label="' + esc(aria) + '" style="--slots:' + slots + ';--weeks:' + weeks + '">' + grid + "</div>" +
    '<p class="recap-foot">' + esc("Each group is a week, " + DAY_FULL[y.order[0]] + " to " + DAY_FULL[y.order[slots - 1]] + ".") + "</p></div>" +
    '<div class="recap-year-side"><div class="recap-counts">' +
    [["full", full, "full days"], ["short", short, "short"], ["away", away, "away"], ["remote", remote, "remote"]].map(function(k){
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
export function monthPage(m, basis){
  var cur = m.cur, base = m.base, v = m.verdicts, t = m.tips || {};
  if(!cur.worked && !cur.away.length && !base){
    return empty("Your first recap is on its way.", "It appears after your first full week of logging, and compares each month with your own usual once you have a few weeks behind you.");
  }
  return hero(headline(v), basis) + areas([
    startArea(m, cur, base, v, t.punctuality, false),
    hoursArea(m, cur, base, v, t.hours, false),
    loggingArea(m, cur, base, v, t.consistency, false),
    timeOffArea(m, cur, base, false)
  ]);
}

export function yearPage(y){
  if(y.empty) return empty("Nothing logged this year yet.", "The year picture starts with your first logged workday.");
  var cmp = !!y.verdicts;
  var cur = cmp ? y.cmpCur : y.cur, base = cmp ? y.cmpBase : null, v = y.verdicts, t = y.tips || {};
  var basis = cmp
    ? "Compared with the same months of " + (+y.year - 1) + ": " + y.pairs.map(function(p){ return monthName(p[0], "short"); }).join(", ") + "."
    : "Nothing from last year to compare yet. Next year, each month is set against the same month of " + y.year + ".";
  var view = Object.assign({}, y, { lateRun: null });
  return hero(cmp ? headline(v) : yearTitle(y), basis) + picture(y) + areas([
    startArea(view, cur, base, v, t.punctuality, true),
    hoursArea(view, cur, base, v, t.hours, true),
    loggingArea(view, cur, base, v, t.consistency, true),
    timeOffArea(y, y.cur, null, true)
  ]);
}
