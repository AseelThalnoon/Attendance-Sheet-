// The Recap tab's arithmetic: how a month (or a year) went, measured against
// the person's own usual. Nothing here touches the page; src/recap-view.js
// turns what this returns into the cards.
//
// What the owner asked for (2026-11-22), and so what this computes:
//   - "How am I really doing?" -- patterns and changes, never a figure the
//     Overview already shows (month average, overtime bank, streak, leave
//     left). The average is still worked out here, but only ever reaches the
//     screen as a difference from the usual.
//   - "Your usual" is the three months before the month in view, not last
//     month alone: one odd month should not swing the comparison.
//   - The Year view starts where logging did. A record with an imported
//     spring and nothing until August must not draw five months of "missed"
//     squares, so each period is clipped to the logging stretch it belongs to
//     (see stretchStart).
//   - Year comparisons use the same months of both years, and only months
//     both years actually logged.
//
// Every day is judged by the schedule module's own computeEntry, so a day
// that is short here is short on the Overview and in Shortfall too.
import { EXCUSED_TYPES, NO_TARGET_TYPES, countsAsWorked } from "./constants.js";
import { dateFromStr, dateToStr, timeToMinutes } from "./time.js";

// More than this many calendar days without a worked day ends a logging
// stretch. A month's leave is shorter; a record that stops for a season and
// starts again is two stretches.
var STRETCH_GAP_DAYS = 30;
// The usual needs this many worked days before a comparison means anything.
var MIN_BASE_DAYS = 10;
// A month counts as logged, for the Year comparison, when entries cover at
// least this share of its workdays.
var LOGGED_MONTH_SHARE = 0.5;
// On days 1-7 the month so far has too little in it; the recap opens on last
// month until this many workdays of the new one are over.
var EARLY_MONTH_DAYS = 5;

function addDays(s, n){ var d = dateFromStr(s); d.setDate(d.getDate() + n); return dateToStr(d); }
function daysBetween(a, b){ return Math.round((dateFromStr(b) - dateFromStr(a)) / 86400000); }
function monthEnd(mk){ var d = dateFromStr(mk + "-01"); d.setMonth(d.getMonth() + 1); d.setDate(0); return dateToStr(d); }
function shiftMonth(mk, n){ var d = dateFromStr(mk + "-01"); d.setMonth(d.getMonth() + n); return dateToStr(d).slice(0, 7); }
function median(list){
  if(!list.length) return null;
  var s = list.slice().sort(function(a, b){ return a - b; });
  var mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
function isAwayType(t){ return EXCUSED_TYPES.indexOf(t) !== -1 || NO_TARGET_TYPES.indexOf(t) !== -1; }
// When the row was written, on this device's clock: what tells a punch made
// on arrival from a day typed in afterwards. Rows queued offline and older
// copies of the record have no createdAt and are left out of both counts.
function createdLocal(e){
  if(!e.createdAt) return null;
  var d = new Date(e.createdAt);
  if(isNaN(d)) return null;
  return { date: dateToStr(d), min: d.getHours() * 60 + d.getMinutes() };
}

export function makeRecap(sch){
  var isScheduled = sch.isScheduled, computeEntry = sch.computeEntry, scheduleFor = sch.scheduleFor;

  function index(entries){
    var by = {};
    entries.forEach(function(e){ by[e.date] = e; });
    return by;
  }
  // Days that show work: clock times on a worked type, or a remote, trip or
  // training day with or without them. Leave alone does not keep a stretch
  // alive -- a spring of imported leave rows is not logging.
  function workedDates(by){
    return Object.keys(by).filter(function(d){
      var e = by[d];
      return (countsAsWorked(e.type) && e.clockIn) || NO_TARGET_TYPES.indexOf(e.type) !== -1;
    }).sort();
  }
  // The first day of the logging stretch that `upTo` belongs to: walk back
  // from the last worked day on or before it while no gap is longer than
  // STRETCH_GAP_DAYS. Null when nothing is logged by then.
  function stretchStart(dates, upTo){
    var i = dates.length - 1;
    while(i >= 0 && dates[i] > upTo) i--;
    if(i < 0) return null;
    if(daysBetween(dates[i], upTo) > STRETCH_GAP_DAYS) return null;
    while(i > 0 && daysBetween(dates[i - 1], dates[i]) <= STRETCH_GAP_DAYS) i--;
    return dates[i];
  }

  // Everything the cards read, over the workdays from `from` to `to`. Today
  // counts only once it is closed: an open shift has no hours yet, and a
  // morning with nothing logged is not a missed day.
  function collect(by, from, to, today){
    var s = { from: from, to: to, workdays: 0, logged: 0, missing: [], unclosed: [],
      worked: 0, weight: 0, workedSum: 0, short: [], shortMin: 0,
      starts: [], startByDate: {}, finishes: [], afterStart: [], liveKnown: 0, live: 0, notLive: [],
      sameDayKnown: 0, sameDay: 0, loggedLater: [], away: [], days: [] };
    if(!from || !to || from > to) return s;
    for(var d = from; d <= to; d = addDays(d, 1)){
      if(d > today) break;
      if(!isScheduled(d)) continue;
      var e = by[d];
      var c = e ? computeEntry(e) : null;
      if(d === today && (!e || c.open)) continue;
      s.workdays++;
      var status = "missing";
      if(!e){ s.missing.push(d); s.days.push({ date: d, status: status }); continue; }
      s.logged++;
      var cr = createdLocal(e);
      if(cr){
        s.sameDayKnown++;
        if(cr.date <= d) s.sameDay++; else s.loggedLater.push({ date: d, type: e.type, days: daysBetween(d, cr.date) });
      }
      var live = null;
      if(e.type === "holiday"){
        status = "away";
      } else if(EXCUSED_TYPES.indexOf(e.type) !== -1){
        status = "away";
        s.away.push({ date: d, type: e.type });
      } else if(NO_TARGET_TYPES.indexOf(e.type) !== -1){
        status = "remote";
        s.away.push({ date: d, type: e.type });
      } else if(c.open || c.workedMin === null){
        status = "unclosed";
        s.unclosed.push(d);
      } else {
        if(c.half) s.away.push({ date: d, type: e.type });
        s.worked++;
        s.weight += c.half ? 0.5 : 1;
        s.workedSum += c.workedMin;
        var st = timeToMinutes(e.clockIn);
        var std = timeToMinutes(c.sched.standardIn);
        s.starts.push(st);
        s.startByDate[d] = st;
        if(st > std) s.afterStart.push({ date: d, min: st, std: std });
        if(!c.half && e.clockOut){
          var fo = timeToMinutes(e.clockOut);
          if(fo >= st) s.finishes.push(fo);
        }
        if(c.workedMin < c.targetMin){
          status = "short";
          s.short.push({ date: d, worked: c.workedMin, target: c.targetMin, half: c.half, late: st > std });
          s.shortMin += c.targetMin - c.workedMin;
        } else {
          status = "full";
        }
        if(cr){
          s.liveKnown++;
          live = cr.date === d && Math.abs(cr.min - st) <= 10;
          if(live) s.live++; else s.notLive.push({ date: d, late: daysBetween(d, cr.date) > 0 ? null : cr.min - st });
        }
      }
      s.days.push({ date: d, status: status, live: live });
    }
    s.avgMin = s.weight ? s.workedSum / s.weight : null;
    s.shortRate = s.worked ? s.short.length / s.worked : null;
    s.medStart = median(s.starts);
    s.medFinish = median(s.finishes);
    s.afterRate = s.worked ? s.afterStart.length / s.worked : null;
    s.liveRate = s.liveKnown ? s.live / s.liveKnown : null;
    s.loggedRate = s.workdays ? s.logged / s.workdays : null;
    s.sameDayRate = s.sameDayKnown ? s.sameDay / s.sameDayKnown : null;
    s.months = s.workdays ? (daysBetween(from, s.days[s.days.length - 1].date) + 1) / 30.44 : 0;
    s.standardIn = scheduleFor(to < today ? to : today).standardIn;
    return s;
  }

  // Consecutive workdays (by the schedule, skipping days off) that all pass
  // `test`, as [first, last, count] runs of at least `min`.
  function runs(days, test, min){
    var out = [], cur = null;
    days.forEach(function(day){
      if(test(day)){
        if(cur){ cur.to = day.date; cur.count++; } else { cur = { from: day.date, to: day.date, count: 1 }; }
      } else {
        if(cur && cur.count >= min) out.push(cur);
        cur = null;
      }
    });
    if(cur && cur.count >= min) out.push(cur);
    return out;
  }

  // Better / steady / slipped per area, or null when there is no usual to
  // hold the period against. The bands are wide on purpose: a verdict that
  // flips on two minutes is noise dressed as advice.
  function verdicts(cur, base){
    if(!base || base.worked < MIN_BASE_DAYS || cur.worked < 3) return null;
    var p = "steady", h = "steady", k = "steady";
    var dStart = cur.medStart - base.medStart;
    if(dStart <= -3) p = "better"; else if(dStart >= 3) p = "slipped";

    var dRate = cur.shortRate - base.shortRate;
    var dAvg = cur.avgMin - base.avgMin;
    var perDay = cur.worked ? cur.shortMin / cur.worked : 0, basePerDay = base.shortMin / base.worked;
    if(dRate >= 0.08 || dAvg <= -10 || (cur.shortMin >= 30 && perDay >= basePerDay * 2)) h = "slipped";
    else if(dRate <= -0.08 || (dAvg >= 10 && dRate <= 0)) h = "better";

    var dLogged = cur.loggedRate - base.loggedRate;
    var dLive = (cur.liveRate != null && base.liveRate != null) ? cur.liveRate - base.liveRate : 0;
    var dSame = (cur.sameDayRate != null && base.sameDayRate != null) ? cur.sameDayRate - base.sameDayRate : 0;
    if(dLogged <= -0.05 || dLive <= -0.15 || dSame <= -0.15) k = "slipped";
    else if(dLogged >= 0.05 || dLive >= 0.15) k = "better";
    return { punctuality: p, hours: h, consistency: k, dStart: dStart, dAvg: dAvg };
  }

  // The one thing to try in an area that slipped, chosen from what the
  // period actually shows. Each is a fact pattern; the wording is the view's.
  function hoursTip(cur){
    var halfShort = cur.short.filter(function(x){ return x.half; });
    var halfMin = halfShort.reduce(function(a, x){ return a + x.target - x.worked; }, 0);
    if(halfShort.length && halfMin * 2 >= cur.shortMin){
      var worst = halfShort.slice().sort(function(a, b){ return (b.target - b.worked) - (a.target - a.worked); })[0];
      return { kind: "halfDay", date: worst.date, min: worst.target - worst.worked, total: cur.shortMin, target: worst.target };
    }
    var lateShort = cur.short.filter(function(x){ return x.late && !x.half; });
    if(lateShort.length && lateShort.length * 2 >= cur.short.length){
      return { kind: "lateStart", count: lateShort.length, of: cur.short.length };
    }
    return { kind: "stayLonger", min: Math.ceil(cur.shortMin / Math.max(1, cur.short.length)), days: cur.short.length };
  }
  function punctualityRun(cur){
    var late = {};
    cur.afterStart.forEach(function(x){ late[x.date] = true; });
    var worked = cur.days.filter(function(d){ return d.status === "full" || d.status === "short"; });
    return runs(worked, function(d){ return late[d.date]; }, 3)[0] || null;
  }
  function punctualityTip(cur){
    var run = punctualityRun(cur);
    if(run) return { kind: "lateRun", run: run, std: cur.standardIn };
    var byDow = [0, 0, 0, 0, 0, 0, 0];
    cur.afterStart.forEach(function(x){ byDow[dateFromStr(x.date).getDay()]++; });
    var top = byDow.indexOf(Math.max.apply(null, byDow));
    if(byDow[top] >= 2 && byDow[top] * 2 >= cur.afterStart.length) return { kind: "lateWeekday", dow: top, count: byDow[top], of: cur.afterStart.length, std: cur.standardIn };
    return { kind: "lateCount", count: cur.afterStart.length, std: cur.standardIn };
  }
  function consistencyTip(cur){
    if(cur.missing.length) return { kind: "missing", dates: cur.missing.slice(0, 3), count: cur.missing.length };
    return { kind: "typedLater", count: cur.notLive.length };
  }

  // Days away by weekday since the stretch began, public holidays left out:
  // they are nobody's choice. A weekday holding at least half of them (and
  // three or more) is a pattern worth a headline.
  function awayPattern(by, from, to, today){
    var s = collect(by, from, to, today);
    var byDow = [0, 0, 0, 0, 0, 0, 0];
    s.away.forEach(function(a){ byDow[dateFromStr(a.date).getDay()]++; });
    var top = byDow.indexOf(Math.max.apply(null, byDow));
    var total = s.away.length;
    return { byDow: byDow, total: total, since: from,
      top: (byDow[top] >= 3 && byDow[top] * 2 >= total) ? top : null };
  }

  // The whole Month view: the month so far against the usual before it.
  function monthRecap(entries, mk, today){
    var by = index(entries), dates = workedDates(by);
    var from = mk + "-01", end = monthEnd(mk);
    var to = end < today ? end : today;
    // A workday before the record's first entry is not one somebody failed to
    // log: they were not using the app yet. The Calendar learned this the
    // hard way (eleven "Not logged" days on an account opened that morning),
    // and a recap that opened by scolding a newcomer would be worse.
    // No entries at all is the same case taken to its end: nothing to count.
    var firstEntry = Object.keys(by).sort()[0];
    if(!firstEntry) from = addDays(to, 1);
    else if(firstEntry > from) from = firstEntry;
    var cur = collect(by, from, to, today);
    var startOfStretch = stretchStart(dates, addDays(from, -1));
    var base = null;
    if(startOfStretch){
      var baseFrom = shiftMonth(mk, -3) + "-01";
      if(startOfStretch > baseFrom) baseFrom = startOfStretch;
      base = collect(by, baseFrom, addDays(from, -1), today);
      if(base.worked < MIN_BASE_DAYS) base = null;
    }
    var v = verdicts(cur, base);
    // "Your earliest month yet": every earlier month of the stretch, each
    // with enough starts to have a typical one.
    var earliest = false;
    if(v && v.punctuality === "better" && startOfStretch){
      var prior = [], m = startOfStretch.slice(0, 7);
      while(m < mk){
        var ms = collect(by, m + "-01" < startOfStretch ? startOfStretch : m + "-01", monthEnd(m), today);
        if(ms.starts.length >= 5) prior.push(ms.medStart);
        m = shiftMonth(m, 1);
      }
      earliest = prior.length >= 2 && prior.every(function(x){ return cur.medStart < x; });
    }
    var patternFrom = stretchStart(dates, to) || from;
    return {
      kind: "month", key: mk, from: from, to: to, isCurrent: today <= end && today >= from,
      cur: cur, base: base, verdicts: v, earliest: earliest,
      lateRun: punctualityRun(cur),
      tips: v ? {
        punctuality: v.punctuality === "slipped" ? punctualityTip(cur) : null,
        hours: v.hours === "slipped" ? hoursTip(cur) : null,
        consistency: v.consistency === "slipped" ? consistencyTip(cur) : null
      } : {},
      away: awayPattern(by, patternFrom, to, today)
    };
  }

  // A month "logged" for the Year comparison: entries on at least half of
  // its workdays (to date).
  function monthLogged(by, mk, today){
    var s = collect(by, mk + "-01", monthEnd(mk), today);
    return s.workdays > 0 && s.logged / s.workdays >= LOGGED_MONTH_SHARE;
  }
  function merge(parts){
    // One summary over several month-collections, built by re-collecting the
    // concatenated day ranges would double-walk; summing the parts is enough
    // for the rates the cards read.
    var out = { worked: 0, weight: 0, workedSum: 0, short: [], shortMin: 0, starts: [], finishes: [],
      afterStart: [], liveKnown: 0, live: 0, sameDayKnown: 0, sameDay: 0, workdays: 0, logged: 0,
      away: [], missing: [], notLive: [], loggedLater: [], days: [] };
    parts.forEach(function(p){
      ["worked", "weight", "workedSum", "shortMin", "liveKnown", "live", "sameDayKnown", "sameDay", "workdays", "logged"]
        .forEach(function(k){ out[k] += p[k]; });
      ["short", "starts", "finishes", "afterStart", "away", "missing", "notLive", "loggedLater", "days"]
        .forEach(function(k){ out[k] = out[k].concat(p[k]); });
    });
    out.avgMin = out.weight ? out.workedSum / out.weight : null;
    out.shortRate = out.worked ? out.short.length / out.worked : null;
    out.medStart = median(out.starts);
    out.medFinish = median(out.finishes);
    out.afterRate = out.worked ? out.afterStart.length / out.worked : null;
    out.liveRate = out.liveKnown ? out.live / out.liveKnown : null;
    out.loggedRate = out.workdays ? out.logged / out.workdays : null;
    out.sameDayRate = out.sameDayKnown ? out.sameDay / out.sameDayKnown : null;
    return out;
  }

  // The whole Year view: a picture of the year from where logging started,
  // the year's own figures, and -- only where both years logged the same
  // months -- a comparison with last year.
  function yearRecap(entries, year, today, workDays, weekStartDate){
    var by = index(entries), dates = workedDates(by);
    var yFrom = year + "-01-01", yEnd = year + "-12-31";
    var yTo = yEnd < today ? yEnd : today;
    var inYear = dates.filter(function(d){ return d >= yFrom && d <= yTo; });
    if(!inYear.length) return { kind: "year", year: year, empty: true };
    var last = inYear[inYear.length - 1];
    var start = stretchStart(dates, last);
    if(start < yFrom) start = yFrom;
    var end = today <= yEnd ? yTo : last;
    var cur = collect(by, start, end, today);

    // The picture: one row per month, one group per week, one slot per
    // working weekday, so a weekday is always the same column.
    var order = [];
    var first = weekStartDate(start).getDay();
    for(var i = 0; i < 7; i++){ var dow = (first + i) % 7; if(workDays.indexOf(dow) !== -1) order.push(dow); }
    var statusOf = {};
    cur.days.forEach(function(d){ statusOf[d.date] = d.status; });
    var todayEntry = by[today];
    if(todayEntry && today >= start && today <= end && computeEntry(todayEntry).open) statusOf[today] = "open";
    var months = [];
    for(var mk = start.slice(0, 7); mk <= end.slice(0, 7); mk = shiftMonth(mk, 1)){
      var weeks = [], wk = null, wkKey = null;
      for(var d = mk + "-01"; d <= monthEnd(mk); d = addDays(d, 1)){
        if(!isScheduled(d)) continue;
        var k = dateToStr(weekStartDate(d));
        if(k !== wkKey){ wk = order.map(function(){ return null; }); weeks.push(wk); wkKey = k; }
        if(d < start || d > end) continue;
        // Today with nothing closed yet is not a missed day, it is a day
        // still going; it stays blank like the days after it.
        wk[order.indexOf(dateFromStr(d).getDay())] = { date: d, status: statusOf[d] || (d >= today ? null : "missing") };
      }
      while(weeks.length && weeks[0].every(function(x){ return !x; })) weeks.shift();
      while(weeks.length && weeks[weeks.length - 1].every(function(x){ return !x; })) weeks.pop();
      if(weeks.length) months.push({ key: mk, weeks: weeks });
    }

    // Same months, both years logged.
    var pairs = [];
    for(var m = start.slice(0, 7); m <= end.slice(0, 7); m = shiftMonth(m, 1)){
      var lm = (+m.slice(0, 4) - 1) + m.slice(4);
      if(monthLogged(by, m, today) && monthLogged(by, lm, today)) pairs.push([m, lm]);
    }
    var cmpCur = null, cmpBase = null, v = null;
    if(pairs.length){
      cmpCur = merge(pairs.map(function(p){ return collect(by, p[0] + "-01", monthEnd(p[0]), today); }));
      cmpBase = merge(pairs.map(function(p){ return collect(by, p[1] + "-01", monthEnd(p[1]), today); }));
      cmpCur.standardIn = cur.standardIn;
      v = verdicts(cmpCur, cmpBase);
    }

    // Time off is the whole calendar year, not just the stretch: April's
    // leave is this year's leave whether or not April was clocked.
    var off = collect(by, yFrom, yTo, today);
    var offByMonth = {}, offByDow = [0, 0, 0, 0, 0, 0, 0], offByType = {};
    off.away.forEach(function(a){
      var k = a.date.slice(0, 7); offByMonth[k] = (offByMonth[k] || 0) + 1;
      offByDow[dateFromStr(a.date).getDay()]++;
      offByType[a.type] = (offByType[a.type] || 0) + 1;
    });
    var topMonth = null;
    Object.keys(offByMonth).forEach(function(k){ if(!topMonth || offByMonth[k] > offByMonth[topMonth]) topMonth = k; });

    // Each month of the picture on its own, for the cards that list months.
    var perMonth = months.map(function(mo){
      var f = mo.key + "-01" < start ? start : mo.key + "-01";
      var t = monthEnd(mo.key) > end ? end : monthEnd(mo.key);
      var s = collect(by, f, t, today);
      return { key: mo.key, medStart: s.medStart, worked: s.worked, short: s.short.length, shortMin: s.shortMin,
        workdays: s.workdays, logged: s.logged, live: s.live, liveKnown: s.liveKnown };
    });

    return {
      kind: "year", year: year, from: start, to: end, isCurrent: today <= yEnd,
      cur: cur, months: months, order: order, pairs: pairs, cmpCur: cmpCur, cmpBase: cmpBase, verdicts: v,
      shortRuns: runs(cur.days.filter(function(d){ return d.status === "full" || d.status === "short"; }),
        function(d){ return d.status === "short"; }, 3),
      perMonth: perMonth,
      off: { total: off.away.length, topMonth: topMonth, topCount: topMonth ? offByMonth[topMonth] : 0,
        byDow: offByDow, byType: offByType },
      away: awayPattern(by, start, end, today),
      tips: v ? {
        punctuality: v.punctuality === "slipped" ? punctualityTip(cmpCur) : null,
        hours: v.hours === "slipped" ? hoursTip(cmpCur) : null,
        consistency: v.consistency === "slipped" ? consistencyTip(cmpCur) : null
      } : {}
    };
  }

  // Which month the Month view opens on: the current one, unless it is only
  // a few workdays old, in which case last month's finished recap.
  function defaultMonth(entries, today){
    var mk = today.slice(0, 7);
    var s = collect(index(entries), mk + "-01", today, today);
    return s.workdays < EARLY_MONTH_DAYS ? shiftMonth(mk, -1) : mk;
  }

  // The months and years there is anything to show for, for the arrows.
  function range(entries, today){
    var dates = workedDates(index(entries));
    if(!dates.length) return null;
    return { firstMonth: dates[0].slice(0, 7), lastMonth: today.slice(0, 7) };
  }

  return { monthRecap: monthRecap, yearRecap: yearRecap, defaultMonth: defaultMonth, range: range,
    shiftMonth: shiftMonth, stretchStart: stretchStart };
}
