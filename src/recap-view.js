// The Recap tab's cards, as HTML. src/recap.js does the arithmetic; this only
// says it. Every figure is written the way the rest of the app writes it
// (formatTime12, minutesToHoursStr, the locale's short dates), and every
// colour is a class whose rule in index.html reads the palette tokens, so the
// cards follow the person's theme and dark mode like every other screen.
//
// Tone, as the owner chose it: an honest coach. An area that slipped gets one
// concrete thing to try; an area that held or improved gets a short line
// saying so, and nothing to do.
import { DAY_FULL } from "./constants.js";
import { formatTime12, minutesToHoursStr, pad2, dateFromStr, fmtDateShort, fmtDateNoYear } from "./time.js";

function esc(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function clock(min){ return min == null ? "—" : formatTime12(pad2(Math.floor(min / 60) % 24) + ":" + pad2(min % 60)); }
function clockShort(min){ return clock(min).replace(/\s*[AP]M$/i, ""); }
function dur(min){ return minutesToHoursStr(min); }
function plural(n, one, many){ return n + " " + (n === 1 ? one : (many || one + "s")); }
function monthName(mk, style){ return dateFromStr(mk + "-01").toLocaleDateString(undefined, { month: style || "long" }); }
var RANGE_FMT = null;
function range(a, b){
  if(a === b) return fmtDateNoYear(a);
  try{
    RANGE_FMT = RANGE_FMT || new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    if(RANGE_FMT.formatRange) return RANGE_FMT.formatRange(dateFromStr(a), dateFromStr(b));
  }catch(e){}
  return fmtDateNoYear(a) + " – " + fmtDateNoYear(b);
}
// "1 in 3" reads faster than 31%, and nobody has 0.31 of a short day.
function oneIn(rate){
  if(rate == null) return "—";
  if(rate === 0) return "none";
  // "10 in 10" is a fraction nobody says.
  if(rate === 1) return "all";
  if(rate >= 0.95) return "nearly all";
  if(rate >= 0.5) return Math.round(rate * 10) + " in 10";
  return "1 in " + Math.round(1 / rate);
}
function minutesWord(min){ return Math.abs(Math.round(min)) + "m"; }

var AREA = { punctuality: "Punctuality", hours: "Hours", consistency: "Consistency", time: "Time off" };
var VERDICT = { better: "Better", steady: "Steady", slipped: "Slipped" };
var AWAY_WORDS = {
  wfh: ["remote day", "remote days"], trip: ["day on a trip", "days on a trip"],
  training: ["training day", "training days"], leave: ["day of annual leave", "days of annual leave"],
  halfleave: ["half-day leave", "half-day leaves"], sick: ["sick day", "sick days"], other: ["excused day", "excused days"]
};

function chip(text, tone){ return '<span class="recap-chip' + (tone ? " is-" + tone : "") + '">' + esc(text) + "</span>"; }
function dots(i, n){
  var out = '<span class="recap-dots" role="img" aria-label="Card ' + (i + 1) + " of " + n + '">';
  for(var k = 0; k < n; k++) out += '<span' + (k === i ? ' class="on"' : "") + "></span>";
  return out + "</span>";
}
function card(surface, kicker, i, n, title, body){
  return '<section class="card recap-card' + (surface ? " is-" + surface : "") + '" aria-roledescription="card" aria-label="' +
    esc(kicker + ", card " + (i + 1) + " of " + n) + '">' +
    '<div class="recap-card-head"><span class="recap-kicker">' + esc(kicker) + "</span>" + dots(i, n) + "</div>" +
    '<h3 class="recap-title display">' + esc(title) + "</h3>" + body + "</section>";
}
function big(value, label, chipHtml){
  return '<div class="recap-big"><span class="recap-big-num">' + esc(value) + '</span><span class="recap-big-side">' +
    '<span class="recap-big-label">' + esc(label) + "</span>" + (chipHtml || "") + "</span></div>";
}
function minis(items){
  return '<div class="recap-minis" style="--n:' + items.length + '">' + items.map(function(m){
    return '<div class="recap-mini"><span class="recap-mini-label">' + esc(m[0]) + '</span><span class="recap-mini-value">' +
      esc(m[1]) + "</span>" + (m[2] ? '<span class="recap-mini-sub">' + esc(m[2]) + "</span>" : "") + "</div>";
  }).join("") + "</div>";
}
function box(kind, text){
  if(!text) return "";
  return '<div class="recap-box is-' + kind + '"><span class="recap-box-label">' + (kind === "tip" ? "Try this" : "Well done") +
    '</span><span class="recap-box-text">' + esc(text) + "</span></div>";
}
function note(html){ return '<p class="recap-note">' + html + "</p>"; }
function legend(items){
  return '<div class="recap-legend">' + items.map(function(it){
    return '<span><i class="recap-mark is-' + it[0] + '" aria-hidden="true"></i>' + esc(it[1]) + "</span>";
  }).join("") + "</div>";
}
function vsUsual(delta, unitWord, laterWord, earlierWord){
  if(delta == null) return "";
  // Under three minutes is a clock's rounding, not a change.
  if(Math.abs(delta) < 3) return "same as " + unitWord;
  return minutesWord(delta) + " " + (delta > 0 ? laterWord : earlierWord) + " than " + unitWord;
}

// ---------- The month (and the year's matching cards) ----------

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

function summaryCard(m, n, opts){
  var v = m.verdicts, cur = opts.cur, base = opts.base;
  function row(go, area, verdict, reason, slipped){
    return '<button type="button" class="recap-row' + (slipped ? " is-slipped" : "") + '" data-recap-go="' + go + '">' +
      '<span class="recap-row-top"><span class="recap-row-name">' + esc(AREA[area]) + "</span>" + verdict + "</span>" +
      '<span class="recap-row-reason">' + esc(reason) + "</span>" +
      (slipped ? '<span class="recap-row-go">What to change<span aria-hidden="true"> →</span></span>' : "") + "</button>";
  }
  function vchip(k){
    if(!v) return "";
    return chip(VERDICT[v[k]], v[k] === "better" ? "good" : v[k] === "slipped" ? "bad" : "");
  }
  var dStart = (cur.medStart != null && base && base.medStart != null) ? cur.medStart - base.medStart : null;
  var pReason = dStart == null ? "Typical start " + clock(cur.medStart)
    // The same three-minute line the Punctuality card's chip uses, so the
    // summary never says "2m earlier" above a card that says "same as usual".
    : Math.abs(dStart) < 3 ? "Starting at your usual time" : "Starting " + minutesWord(dStart) + (dStart < 0 ? " earlier" : " later") + " than usual";
  var hReason = cur.short.length === 0 ? "No short days" : cur.shortRate === 1 ? "Every workday came up short" :
    "Short " + oneIn(cur.shortRate) + " days" + (base ? ", usually " + oneIn(base.shortRate) : "");
  var cReason = cur.missing.length ? plural(cur.missing.length, "workday") + " not logged" :
    "Every workday logged" + (cur.liveRate != null ? (cur.liveRate >= 0.85 ? ", nearly all live" : ", " + oneIn(cur.liveRate) + " live") : "");
  var awayN = cur.away.length;
  var tReason = base ? "Usual is about " + usualPerMonth(base) + " a month" : (awayN ? "Days away from the office" : "No time away");
  var off = opts.offTotal != null ? opts.offTotal : awayN;
  var body = (opts.lead ? note(opts.lead) : "") +
    '<div class="recap-rows">' +
      row(opts.go.punctuality, "punctuality", vchip("punctuality"), pReason, v && v.punctuality === "slipped") +
      row(opts.go.hours, "hours", vchip("hours"), hReason, v && v.hours === "slipped") +
      row(opts.go.consistency, "consistency", vchip("consistency"), cReason, v && v.consistency === "slipped") +
      row(opts.go.time, "time", chip(plural(off, "day")), tReason, false) +
    "</div>" +
    '<p class="recap-hint">Each area has its own card<span aria-hidden="true"> →</span></p>';
  return card("gray", "Summary", opts.index, n, opts.title || headline(v), body);
}
function usualRate(base){ return base.away.length / Math.max(base.months || 1, 0.5); }
function usualPerMonth(base){
  var x = usualRate(base);
  if(x < 0.5) return "less than 1";
  return String(Math.round(x));
}

function startsChart(cur){
  var cols = cur.days.filter(function(d){ return d.status !== "missing"; });
  if(!cols.length || !cur.starts.length) return "";
  var startOf = cur.startByDate;
  var lo = Math.min.apply(null, cur.starts), hi = Math.max.apply(null, cur.starts);
  var stdMin = cur.standardIn ? +cur.standardIn.slice(0, 2) * 60 + +cur.standardIn.slice(3, 5) : lo;
  lo = Math.floor((Math.min(lo, stdMin) - 10) / 30) * 30;
  hi = Math.ceil((Math.max(hi, stdMin) + 10) / 30) * 30;
  if(hi - lo < 60) hi = lo + 60;
  var span = hi - lo;
  var marks = cols.map(function(d){
    var day = +d.date.slice(8);
    var st = startOf[d.date];
    var mark = st == null
      ? '<i class="recap-mark is-' + (d.status === "remote" ? "remote" : "away") + '" style="top:' + (((stdMin - lo) / span) * 100).toFixed(1) + '%"></i>'
      : '<i class="recap-mark is-' + (st > stdMin ? "after" : "before") + '" style="top:' + (((st - lo) / span) * 100).toFixed(1) + '%"></i>';
    return '<span class="recap-col">' + mark + "</span>";
  }).join("");
  var labels = cols.map(function(d){ return "<span>" + (+d.date.slice(8)) + "</span>"; }).join("");
  var after = cur.afterStart.map(function(x){ return fmtDateNoYear(x.date); });
  var aria = "Start time on each workday. " + (after.length ? plural(after.length, "start") + " came after " + clock(stdMin) + ": " + after.join(", ") + "." : "Every start was by " + clock(stdMin) + ".");
  return '<div class="recap-chart' + (cols.length > 16 ? " is-dense" : "") + '" role="img" aria-label="' + esc(aria) + '" style="--cols:' + cols.length + '">' +
    '<div class="recap-axis" aria-hidden="true"><span style="top:0">' + esc(clockShort(lo)) + '</span><span class="is-std" style="top:' + (((stdMin - lo) / span) * 100).toFixed(1) + '%">' +
    esc(clockShort(stdMin)) + '</span><span style="top:100%">' + esc(clockShort(hi)) + "</span></div>" +
    '<div class="recap-plot" aria-hidden="true"><span class="recap-std" style="top:' + (((stdMin - lo) / span) * 100).toFixed(1) + '%"></span>' + marks + "</div>" +
    '<div class="recap-xlabels" aria-hidden="true">' + labels + "</div></div>";
}

function punctualityCard(m, n, i, cur, base, v, tip, isYear){
  var std = cur.standardIn ? clock(+cur.standardIn.slice(0, 2) * 60 + +cur.standardIn.slice(3, 5)) : "your start time";
  var stdMin = cur.standardIn ? +cur.standardIn.slice(0, 2) * 60 + +cur.standardIn.slice(3, 5) : null;
  var verdict = v ? v.punctuality : null;
  var title = m.earliest ? "Your earliest month yet." :
    verdict === "better" ? "Earlier starts than usual." : verdict === "slipped" ? "Later starts than usual." :
    verdict === "steady" ? "Starting at your usual time." : "How your days started.";
  var dStart = base && cur.medStart != null && base.medStart != null ? cur.medStart - base.medStart : null;
  var unit = isYear ? "last year" : "usual";
  var body = big(clock(cur.medStart), "typical start",
    dStart == null ? "" : chip(vsUsual(dStart, unit, "later", "earlier"), dStart <= -3 ? "good" : dStart >= 3 ? "bad" : ""));
  if(isYear){
    body += monthRows(m.perMonth.filter(function(x){ return x.medStart != null; }).map(function(x){
      return [monthName(x.key, "short"), clock(x.medStart), stdMin != null ? Math.max(0, Math.min(100, 50 + (x.medStart - stdMin) * 50 / 30)) : 50];
    }), "start");
  } else {
    body += startsChart(cur) + legend([["before", "By " + std], ["after", "After " + std], ["remote", "Remote, no times"]]);
  }
  var latest = cur.afterStart.concat().sort(function(a, b){ return b.min - a.min; })[0];
  var dFin = base && cur.medFinish != null && base.medFinish != null ? cur.medFinish - base.medFinish : null;
  body += minis([
    ["Typical finish", clock(cur.medFinish), dFin == null ? "" : vsUsual(dFin, unit, "later", "earlier")],
    ["After " + std, cur.afterStart.length + " of " + cur.worked, base ? "usually " + oneIn(base.afterRate) : ""],
    latest ? ["Latest", clock(latest.min), fmtDateShort(latest.date)] : ["Latest", "—", "every start on time"]
  ]);
  var tipText = null, wellText = null;
  if(tip){
    var aim = stdMin != null ? clock(stdMin - 10) : "ten minutes earlier";
    if(tip.kind === "lateRun") tipText = "One late start pulled in more: " + range(tip.run.from, tip.run.to) + ". After a late day, aim to be in by " + aim + " the next morning.";
    else if(tip.kind === "lateWeekday") tipText = DAY_FULL[tip.dow] + "s are your late starts, " + tip.count + " of " + tip.of + ". Aim to be in by " + aim + " on " + DAY_FULL[tip.dow] + "s.";
    else tipText = plural(tip.count, "start") + " came after " + std + ". Aim to be in by " + aim + ".";
  } else if(verdict === "better"){
    wellText = "Keep starting before " + std + "." + (m.lateRun ? " Only " + range(m.lateRun.from, m.lateRun.to) + " broke the habit." : "");
  } else if(verdict === "steady"){
    wellText = "Your usual start. Nothing to change.";
  }
  body += tipText ? box("tip", tipText) : box("well", wellText);
  return card("", "Punctuality", i, n, title, body);
}

function monthRows(rows, kind){
  return '<div class="recap-months">' + rows.map(function(r){
    return '<div class="recap-month-row"><span class="recap-month-name">' + esc(r[0]) + "</span>" +
      (kind === "start"
        ? '<span class="recap-track-line" aria-hidden="true"><i style="left:' + r[2].toFixed(1) + '%"></i></span>'
        : "") +
      '<span class="recap-month-value">' + esc(r[1]) + "</span></div>";
  }).join("") + "</div>";
}

function hoursCard(m, n, i, cur, base, v, tip, isYear){
  var verdict = v ? v.hours : null;
  var title = cur.short.length === 0 ? "No short days." :
    verdict === "slipped" ? (v.dAvg <= -10 && (cur.shortRate - (base ? base.shortRate : 0)) < 0.08 ? "Shorter days than usual." : "Short days are up.") :
    verdict === "better" ? "Fewer short days than usual." : verdict === "steady" ? "Your hours, as usual." : "Your hours" + (isYear ? " this year." : " this month.");
  var unit = isYear ? "last year" : "usual";
  var body = big(cur.short.length ? oneIn(cur.shortRate) : "None", cur.short.length ? "workdays came up short" : "every workday made its hours",
    base ? chip("usually " + oneIn(base.shortRate), verdict === "slipped" ? "bad" : verdict === "better" ? "good" : "") : "");
  var lead = "<b>" + esc(dur(cur.shortMin)) + " short in all.</b>";
  if(base && !isYear) lead += " A usual month comes to about " + esc(dur(base.shortMin / Math.max(base.months || 1, 0.5))) + ".";
  if(base && v && Math.abs(v.dAvg) >= 5) lead += " Your days ran " + esc(minutesWord(v.dAvg)) + (v.dAvg < 0 ? " shorter" : " longer") + " than " + unit + " on average.";
  if(cur.short.length) body += note(lead);
  if(isYear){
    body += monthRows(m.perMonth.map(function(x){
      return [monthName(x.key, "short"), x.short ? plural(x.short, "short day") + ", " + dur(x.shortMin) : "no short days"];
    }));
  } else if(cur.short.length){
    var list = cur.short.slice();
    var more = 0;
    if(list.length > 5){
      list = list.slice().sort(function(a, b){ return (b.target - b.worked) - (a.target - a.worked); }).slice(0, 5)
        .sort(function(a, b){ return a.date < b.date ? -1 : 1; });
      more = cur.short.length - 5;
    }
    body += '<div class="recap-list"><span class="recap-list-head">The short days</span>' + list.map(function(x){
      return '<div class="recap-list-row"><span class="recap-list-date">' + esc(fmtDateShort(x.date)) + '</span><span class="recap-list-detail">' +
        esc(dur(x.worked) + " of " + dur(x.target) + (x.half ? ", half day" : "")) + '</span><span class="recap-list-amount">' + esc(dur(x.target - x.worked)) + "</span></div>";
    }).join("") + (more ? '<span class="recap-list-more">and ' + plural(more, "more short day") + "</span>" : "") + "</div>";
  }
  var tipText = null, wellText = null;
  if(tip){
    if(tip.kind === "halfDay") tipText = "On a half day, stay the full " + dur(tip.target) + ". " + fmtDateNoYear(tip.date) + " alone was " + dur(tip.min) + " of the " + dur(tip.total) + ".";
    else if(tip.kind === "lateStart") tipText = "On a late start, leave at the time your clock card shows, not at your usual time. " + tip.count + " of your " + plural(tip.of, "short day") + " started late.";
    else tipText = "Your short days were about " + dur(tip.min) + " short each. Staying that much longer on those days covers them.";
  } else if(verdict === "better"){
    wellText = "Fewer short days than " + unit + ". Keep it up.";
  } else if(verdict === "steady"){
    wellText = "Your hours are where they usually are.";
  }
  body += tipText ? box("tip", tipText) : box("well", wellText);
  return card("cream", "Hours", i, n, title, body);
}

function strip(cur){
  var cells = cur.days.map(function(d){
    var k = d.status === "missing" ? "missing" : d.status === "unclosed" ? "unclosed" :
      (d.status === "remote" || d.status === "away") ? "away" : d.live === false ? "typed" : "live";
    return '<i class="recap-mark is-' + k + '"></i>';
  }).join("");
  var labels = cur.days.map(function(d){ return "<span>" + (+d.date.slice(8)) + "</span>"; }).join("");
  return '<div class="recap-strip' + (cur.days.length > 16 ? " is-dense" : "") + '" aria-hidden="true" style="--cols:' + cur.days.length + '"><div class="recap-strip-cells">' + cells +
    '</div><div class="recap-xlabels">' + labels + "</div></div>";
}

function consistencyCard(m, n, i, cur, base, v, tip, isYear){
  var verdict = v ? v.consistency : null;
  var title = cur.missing.length ? plural(cur.missing.length, "workday") + " not logged." : "Every workday logged.";
  var body = cur.liveKnown
    ? big(cur.live + " of " + cur.liveKnown, "clocked in live", base && base.liveRate != null ? chip("usually " + oneIn(base.liveRate), "") : "")
    : big(cur.logged + " of " + cur.workdays, "workdays logged", "");
  if(isYear){
    body += monthRows(m.perMonth.map(function(x){
      return [monthName(x.key, "short"), x.logged + " of " + x.workdays + " logged" + (x.liveKnown ? ", " + x.live + " live" : "")];
    }));
  } else {
    body += strip(cur) + legend([["live", "Clocked in live"], ["typed", "Typed in later"], ["away", "Away or remote"]].concat(
      cur.missing.length ? [["missing", "Not logged"]] : []));
  }
  body += minis([
    ["Workdays logged", cur.logged + " of " + cur.workdays, base ? (Math.abs(cur.loggedRate - base.loggedRate) < 0.02 ? "same as " + (isYear ? "last year" : "usual") : "usually " + oneIn(base.loggedRate)) : ""],
    ["Logged on the day", cur.sameDay + " of " + cur.sameDayKnown, base && base.sameDayRate != null ? (base.sameDayRate >= 0.95 ? "usually nearly all" : "usually " + oneIn(base.sameDayRate)) : ""]
  ]);
  var facts = [];
  cur.notLive.slice(0, 2).forEach(function(x){
    facts.push(fmtDateNoYear(x.date) + " was typed in " + (x.late != null && x.late > 0 ? (x.late >= 90 ? Math.round(x.late / 60) + " hours" : x.late + " minutes") + " after you arrived" : "later"));
  });
  cur.loggedLater.filter(function(x){ return x.days > 0; }).slice(0, 2).forEach(function(x){
    facts.push("the " + fmtDateNoYear(x.date) + " entry went in " + plural(x.days, "day") + " later");
  });
  if(!isYear && facts.length) body += note(esc(facts.join("; ").replace(/^./, function(c){ return c.toUpperCase(); })) + ".");
  var tipText = null, wellText = null;
  if(tip){
    if(tip.kind === "missing") tipText = tip.dates.map(fmtDateNoYear).join(", ") + (tip.count > tip.dates.length ? " and " + (tip.count - tip.dates.length) + " more" : "") +
      (tip.count === 1 ? " was" : " were") + " not logged. Add " + (tip.count === 1 ? "it" : "them") + " from the Log tab so " + (tip.count === 1 ? "it counts." : "they count.");
    else tipText = plural(tip.count, "day was", "days were") + " typed in later. Clock in when you arrive; it is one tap.";
  } else if(verdict){
    wellText = !cur.missing.length && (cur.liveRate == null || cur.liveRate >= 0.85) ? "Nothing to change. This is your steadiest area." : "Steady, as usual.";
  }
  body += tipText ? box("tip", tipText) : box("well", wellText);
  return card("", "Consistency", i, n, title, body);
}

function weekdayBars(byDow, order, top){
  var max = Math.max.apply(null, order.map(function(d){ return byDow[d]; }).concat([1]));
  return '<div class="recap-bars" aria-hidden="true" style="--cols:' + order.length + '">' + order.map(function(d){
    var c = byDow[d];
    return '<span class="recap-bar' + (d === top ? " is-top" : "") + '"><b>' + c + '</b><span class="recap-bar-area"><i style="height:' +
      (c ? Math.max(6, (c / max) * 100) : 3) + '%"></i></span><span class="recap-bar-day">' + esc(DAY_FULL[d].slice(0, 3)) + "</span></span>";
  }).join("") + "</div>";
}
function awayBreakdown(list){
  var by = {};
  list.forEach(function(a){ by[a.type] = (by[a.type] || 0) + 1; });
  var parts = Object.keys(by).map(function(t){
    var w = AWAY_WORDS[t] || [t, t];
    return (by[t] === 1 ? (t === "halfleave" ? "a" : "one") : by[t]) + " " + (by[t] === 1 ? w[0] : w[1]);
  });
  if(!parts.length) return "";
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
}

function timeOffCard(m, n, i, cur, base, order, isYear){
  // The Year card counts the whole calendar year (April's leave is this
  // year's leave), so its weekday pattern is worked out over that same year;
  // a headline taken from one span over figures from another said "falls on
  // Thursdays" above 12 Thursdays out of 33.
  var pat = m.away;
  if(isYear){
    var yb = m.off.byDow, yt = yb.indexOf(Math.max.apply(null, yb));
    pat = { byDow: yb, total: m.off.total, since: m.from, top: (yb[yt] >= 3 && yb[yt] * 2 >= m.off.total) ? yt : null };
  }
  var count = isYear ? m.off.total : cur.away.length;
  // Without a weekday pattern the headline says how much against usual (a
  // month) or where it went (a year) -- never the count again, which the big
  // number under it already says.
  var title;
  if(pat.top != null) title = "Your time away falls on " + DAY_FULL[pat.top] + "s.";
  else if(count === 0) title = isYear ? "No time away this year." : "No time away this month.";
  else if(isYear) title = m.off.topMonth && m.off.topCount >= 3 && m.off.topCount * 2 >= count
    ? "Most of it in " + monthName(m.off.topMonth) + "." : "Spread through the year.";
  else if(!base) title = "Your time away this month.";
  else {
    // The usual, scaled to the part of the month that has happened.
    var expected = usualRate(base) * Math.min(1, cur.workdays / 21.7);
    title = count - expected >= 1 ? "More time away than usual." :
      expected - count >= 1 ? "Less time away than usual." : "About your usual time away.";
  }
  var body = big(count ? plural(count, "day") : "None", isYear ? "away this year" : "away this month",
    base && !isYear ? chip("usually about " + usualPerMonth(base) + " a month", "") : "");
  var byDow = isYear ? m.off.byDow : pat.byDow;
  var sinceMonth = monthName(pat.since.slice(0, 7));
  if((isYear ? m.off.total : pat.total) > 0){
    body += '<div class="recap-panel-box"><span class="recap-list-head">Days away ' + (isYear ? "this year" : "since " + esc(sinceMonth)) + ", by weekday</span>" +
      weekdayBars(byDow, order, pat.top) + "</div>";
  }
  var lines = [];
  if(pat.top != null) lines.push("<b>" + esc(byDow[pat.top] + " of your " + (isYear ? m.off.total : pat.total) + " days away " + (isYear ? "this year" : "since " + sinceMonth) + " were " + DAY_FULL[pat.top] + "s.") + "</b>");
  if(!isYear && cur.away.length) lines.push(esc("This month: " + awayBreakdown(cur.away) + "."));
  if(isYear && m.off.topMonth && m.off.topCount >= 5) lines.push(esc(monthName(m.off.topMonth) + " alone was " + plural(m.off.topCount, "day") + "."));
  lines.push('<span class="recap-quiet">Public holidays are not counted.</span>');
  body += note(lines.join(" "));
  return card("cream", "Time off", i, n, title, body);
}

// ---------- The year picture ----------

function pictureCard(y, n){
  var full = y.cur.days.filter(function(d){ return d.status === "full"; }).length;
  var short = y.cur.short.length;
  var away = y.cur.days.filter(function(d){ return d.status === "away"; }).length;
  var remote = y.cur.days.filter(function(d){ return d.status === "remote"; }).length;
  var share = (full + short) ? full / (full + short) : 0;
  var title = share >= 0.7 ? (y.shortRuns.length ? "Mostly full days. The short ones come in runs." : "Mostly full days.") :
    plural(short, "short day") + " so far this year.";
  var slots = y.order.length;
  var rows = y.months.map(function(mo){
    return '<div class="recap-pic-row"><span class="recap-pic-month">' + esc(monthName(mo.key, "short")) + '</span><span class="recap-pic-weeks">' +
      mo.weeks.map(function(w){
        return '<span class="recap-pic-week">' + w.map(function(c){
          return c && c.status ? '<i class="recap-mark is-' + (c.status === "full" ? "full" : c.status === "short" ? "short" :
            c.status === "remote" ? "remote" : c.status === "away" ? "away" : c.status === "open" ? "open" : "missing") + '"></i>' : "<i></i>";
        }).join("") + "</span>";
      }).join("") + "</span></div>";
  }).join("");
  var aria = "Every workday from " + fmtDateNoYear(y.from) + ", one square each: " + full + " full, " + short + " short, " + away + " away, " + remote + " remote.";
  var body = '<div class="recap-pic" role="img" aria-label="' + esc(aria) + '" style="--slots:' + slots + '">' + rows +
    '<span class="recap-pic-caption" aria-hidden="true">Each group is a week, ' + esc(DAY_FULL[y.order[0]]) + " to " + esc(DAY_FULL[y.order[slots - 1]]) + ".</span></div>";
  body += '<div class="recap-counts">' +
    [["full", full, "full days"], ["short", short, "short"], ["away", away, "away"], ["remote", remote, "remote"]].map(function(c){
      return '<span><i class="recap-mark is-' + c[0] + '" aria-hidden="true"></i><b>' + c[1] + "</b> " + c[2] + "</span>";
    }).join("") + "</div>";
  var lines = [];
  if(y.shortRuns.length){
    var r = y.shortRuns.slice(-2);
    var sameSize = r.every(function(x){ return x.count === r[0].count; });
    lines.push("<b>Short days come " + (sameSize ? r[0].count + " at a time" : "in runs") + ":</b> " +
      esc(r.map(function(x){ return range(x.from, x.to); }).join(" and ")) + ". One short day tends to bring the next.");
  }
  if(y.away.top != null && y.order.indexOf(y.away.top) !== -1){
    lines.push("<b>Days away mostly fall on " + esc(DAY_FULL[y.away.top]) + "s,</b> " + y.away.byDow[y.away.top] + " of " + y.away.total + ".");
  }
  if(lines.length) body += '<div class="recap-facts">' + lines.map(function(l){ return note(l); }).join("") + "</div>";
  return card("", "At a glance", 0, n, title, body);
}

// ---------- Entry points ----------

export function monthSlides(m, order){
  var n = 5, cur = m.cur, base = m.base, v = m.verdicts, t = m.tips || {};
  if(!cur.worked && !cur.away.length && !base){
    return [card("gray", "Recap", 0, 1, "Your first recap is on its way.",
      note("It appears after your first full week of logging, and compares each month with your own usual once you have a few weeks behind you."))];
  }
  var lead = base ? null : "This compares each month with your usual once you have a few weeks of logging behind you. Until then, it describes the month.";
  return [
    summaryCard(m, n, { cur: cur, base: base, index: 0, lead: lead, go: { punctuality: 1, hours: 2, consistency: 3, time: 4 } }),
    punctualityCard(m, n, 1, cur, base, v, t.punctuality, false),
    hoursCard(m, n, 2, cur, base, v, t.hours, false),
    consistencyCard(m, n, 3, cur, base, v, t.consistency, false),
    timeOffCard(m, n, 4, cur, base, order, false)
  ];
}

export function yearSlides(y, order){
  if(y.empty){
    return [card("gray", "Recap", 0, 1, "Nothing logged this year yet.", note("The year picture starts with your first logged workday."))];
  }
  var n = 6, cmp = !!y.verdicts;
  var cur = cmp ? y.cmpCur : y.cur, base = cmp ? y.cmpBase : null, v = y.verdicts, t = y.tips || {};
  var lead = cmp
    ? "Compared with the same months of " + (+y.year - 1) + ": " + y.pairs.map(function(p){ return monthName(p[0], "short"); }).join(", ") + "."
    : "Nothing from last year to compare yet. Next year, each month is set against the same month of " + y.year + ".";
  var view = Object.assign({}, y, { earliest: false, lateRun: null });
  var c = y.cur;
  var title = cmp ? headline(v) : "Your " + y.year + " so far.";
  return [
    pictureCard(y, n),
    summaryCard(Object.assign({}, y, { verdicts: v }), n, { cur: cur, base: base, index: 1, lead: esc(lead), title: title,
      offTotal: y.off.total, go: { punctuality: 2, hours: 3, consistency: 4, time: 5 } }),
    punctualityCard(view, n, 2, cur, base, v, t.punctuality, true),
    hoursCard(view, n, 3, cur, base, v, t.hours, true),
    consistencyCard(view, n, 4, cur, base, v, t.consistency, true),
    timeOffCard(y, n, 5, c, null, order, true)
  ];
}
