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
  // Every logging stretch, [first, last]. The latest runs on to today while
  // its silence is short: days since the last entry are days still to log,
  // not a stretch that has ended.
  function stretches(dates, today){
    var out = [];
    dates.forEach(function(d){
      var last = out[out.length - 1];
      if(last && daysBetween(last[1], d) <= STRETCH_GAP_DAYS) last[1] = d; else out.push([d, d]);
    });
    var tail = out[out.length - 1];
    if(tail && today > tail[1] && daysBetween(tail[1], today) <= STRETCH_GAP_DAYS) tail[1] = today;
    return out;
  }
  function tracked(st, d){
    for(var i = 0; i < st.length; i++) if(d >= st[i][0] && d <= st[i][1]) return true;
    return false;
  }

  // Everything the cards read, over the workdays from `from` to `to`. Today
  // counts only once it is closed: an open shift has no hours yet, and a
  // morning with nothing logged is not a missed day.
  function collect(by, from, to, today, spans){
    var s = { from: from, to: to, workdays: 0, logged: 0, missing: [], unclosed: [],
      worked: 0, weight: 0, workedSum: 0, short: [], shortMin: 0,
      starts: [], startByDate: {}, finishes: [], lateDays: [], liveKnown: 0, live: 0, notLive: [],
      sameDayKnown: 0, sameDay: 0, loggedLater: [], away: [], offDays: 0, remote: [], days: [] };
    if(!from || !to || from > to) return s;
    for(var d = from; d <= to; d = addDays(d, 1)){
      if(d > today) break;
      if(!isScheduled(d)) continue;
      var e = by[d];
      var c = e ? computeEntry(e) : null;
      if(d === today && (!e || c.open)) continue;
      // A workday outside every logging stretch with nothing on it was not
      // missed: the person was not using the app then (2026-11-23: a record
      // with an imported spring showed its gap months as dozens of "not
      // logged" days, each with an Add).
      if(!e && spans && !tracked(spans, d)) continue;
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
        s.offDays += 1;
      } else if(NO_TARGET_TYPES.indexOf(e.type) !== -1){
        // A remote, trip or training day is a day's work somewhere else, not
        // time off (2026-11-23: counted as "time off" until then).
        status = "remote";
        s.remote.push({ date: d, type: e.type });
      } else if(c.open || c.workedMin === null){
        status = "unclosed";
        s.unclosed.push(d);
      } else {
        // Half a day off, counted as half, as the leave balance counts it.
        if(c.half){ s.away.push({ date: d, type: e.type }); s.offDays += 0.5; }
        s.worked++;
        s.weight += c.half ? 0.5 : 1;
        s.workedSum += c.workedMin;
        var st = timeToMinutes(e.clockIn);
        var std = timeToMinutes(c.sched.standardIn);
        s.starts.push(st);
        s.startByDate[d] = st;
        // Late the way the rest of the app means it (2026-11-18): a start
        // after Start on a day that came up short. A day that makes its hours
        // is never late, however it started -- computeEntry's own lateMin.
        if(c.lateMin > 0) s.lateDays.push({ date: d, min: st, std: std, target: c.targetMin, half: c.half });
        if(!c.half && e.clockOut){
          var fo = timeToMinutes(e.clockOut);
          if(fo >= st) s.finishes.push(fo);
        }
        if(c.workedMin < c.targetMin){
          status = "short";
          s.short.push({ date: d, worked: c.workedMin, target: c.targetMin, half: c.half, late: c.lateMin > 0 });
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
    s.lateRate = s.worked ? s.lateDays.length / s.worked : null;
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
  //
  // Each verdict also says what moved it (why.hours, why.consistency), so the
  // card can put that on screen. A "Slipped" over a line reading "same as
  // usual" -- which the logging card could show, its verdict having come from
  // late entries -- is a verdict nobody can act on (2026-11-23).
  function verdicts(cur, base){
    if(!base || base.worked < MIN_BASE_DAYS || cur.worked < 3) return null;
    var p = "steady", h = "steady", k = "steady", hWhy = null, kWhy = null;
    // Start time is judged on late days as the app counts them -- after
    // Start on a day that came up short -- never on the clock alone: coming
    // in at 8:20 and staying to 4:20 is on time here (2026-11-18). Until
    // 2026-11-23 this held the typical start against the usual one, and
    // coached people to come in earlier on days the app counts as on time.
    var dStart = cur.medStart - base.medStart;
    var dLate = cur.lateRate - base.lateRate;
    if(dLate >= 0.08 && cur.lateDays.length >= 2) p = "slipped"; else if(dLate <= -0.08) p = "better";

    // Hours is the daily target: how often a day comes up short, and by how
    // much in all. Days that run past the target by less than they used to
    // are not a slip -- the Overview's bank is where overtime lives.
    var dRate = cur.shortRate - base.shortRate;
    var perDay = cur.shortMin / cur.worked, basePerDay = base.shortMin / base.worked;
    if(dRate >= 0.08){ h = "slipped"; hWhy = "rate"; }
    else if(cur.shortMin >= 30 && perDay >= basePerDay * 2){ h = "slipped"; hWhy = "depth"; }
    else if(dRate <= -0.08){ h = "better"; hWhy = "rate"; }

    // Logging: every workday has an entry, and a worked day's entry was made
    // on arrival rather than typed in afterwards.
    var dLogged = cur.loggedRate - base.loggedRate;
    var dLive = (cur.liveRate != null && base.liveRate != null) ? cur.liveRate - base.liveRate : 0;
    if(dLogged <= -0.05){ k = "slipped"; kWhy = "logged"; }
    else if(dLive <= -0.15){ k = "slipped"; kWhy = "live"; }
    else if(dLogged >= 0.05){ k = "better"; kWhy = "logged"; }
    else if(dLive >= 0.15){ k = "better"; kWhy = "live"; }
    return { punctuality: p, hours: h, consistency: k, dStart: dStart, why: { hours: hWhy, consistency: kWhy } };
  }

  // The one thing to try in an area that slipped, chosen from what the
  // period actually shows. Each is a fact pattern; the wording is the view's.
  function hoursTip(cur, lateSaid){
    var halfShort = cur.short.filter(function(x){ return x.half; });
    var halfMin = halfShort.reduce(function(a, x){ return a + x.target - x.worked; }, 0);
    if(halfShort.length && halfMin * 2 >= cur.shortMin){
      var worst = halfShort.slice().sort(function(a, b){ return (b.target - b.worked) - (a.target - a.worked); })[0];
      return { kind: "halfDay", date: worst.date, min: worst.target - worst.worked, total: cur.shortMin, target: worst.target };
    }
    var lateShort = cur.short.filter(function(x){ return x.late && !x.half; });
    if(!lateSaid && lateShort.length && lateShort.length * 2 >= cur.short.length){
      return { kind: "lateStart", count: lateShort.length, of: cur.short.length, target: lateShort[0].target };
    }
    return { kind: "stayLonger", min: Math.ceil(cur.shortMin / Math.max(1, cur.short.length)), days: cur.short.length };
  }
  function punctualityRun(cur){
    var late = {};
    cur.lateDays.forEach(function(x){ late[x.date] = true; });
    var worked = cur.days.filter(function(d){ return d.status === "full" || d.status === "short"; });
    return runs(worked, function(d){ return late[d.date]; }, 3)[0] || null;
  }
  // The advice is the rule's own: on a late start, stay the full day. Said
  // with the person's typical late start, so it is a time to leave by, not
  // a principle: "in at 8:21, out at 4:21".
  function punctualityTip(cur){
    var late = cur.lateDays, full = late.filter(function(x){ return !x.half; });
    var day = (full[0] || late[0]).target, inAt = median((full.length ? full : late).map(function(x){ return x.min; }));
    var extra = { target: day, inAt: inAt, outAt: inAt + day };
    var run = punctualityRun(cur);
    if(run) return Object.assign({ kind: "lateRun", run: run }, extra);
    var byDow = [0, 0, 0, 0, 0, 0, 0];
    late.forEach(function(x){ byDow[dateFromStr(x.date).getDay()]++; });
    var top = byDow.indexOf(Math.max.apply(null, byDow));
    if(byDow[top] >= 2 && byDow[top] * 2 >= late.length) return Object.assign({ kind: "lateWeekday", dow: top, count: byDow[top], of: late.length }, extra);
    return Object.assign({ kind: "lateCount", count: late.length }, extra);
  }
  function consistencyTip(cur){
    if(cur.missing.length) return { kind: "missing", dates: cur.missing.slice(0, 3), count: cur.missing.length };
    return { kind: "typedLater", count: cur.notLive.length };
  }

  // Days off by weekday since the stretch began, public holidays left out:
  // they are nobody's choice. A weekday holding at least half of them (and
  // three or more) is a pattern worth a headline.
  // Counted the way the card counts them, a half-day leave as half, so the
  // sentence never says "4 of your 4 days off" under a figure of 2; whether
  // there is a pattern at all is decided on the days themselves.
  function awayPattern(by, from, to, today, st){
    var s = collect(by, from, to, today, st);
    var hits = [0, 0, 0, 0, 0, 0, 0], byDow = [0, 0, 0, 0, 0, 0, 0];
    s.away.forEach(function(a){
      var w = dateFromStr(a.date).getDay();
      hits[w]++; byDow[w] += a.type === "halfleave" ? 0.5 : 1;
    });
    var top = hits.indexOf(Math.max.apply(null, hits));
    return { byDow: byDow, total: s.offDays, since: from,
      top: (hits[top] >= 3 && hits[top] * 2 >= s.away.length) ? top : null };
  }

  // The whole Month view: the month so far against the usual before it.
  function monthRecap(entries, mk, today){
    var by = index(entries), dates = workedDates(by), st = stretches(dates, today);
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
    var cur = collect(by, from, to, today, st);
    var startOfStretch = stretchStart(dates, addDays(from, -1));
    var base = null;
    if(startOfStretch){
      var baseFrom = shiftMonth(mk, -3) + "-01";
      if(startOfStretch > baseFrom) baseFrom = startOfStretch;
      base = collect(by, baseFrom, addDays(from, -1), today, st);
      if(base.worked < MIN_BASE_DAYS) base = null;
    }
    var v = verdicts(cur, base);
    // "Your earliest month yet": every earlier month of the stretch, each
    // with enough starts to have a typical one.
    var earliest = false;
    if(v && v.punctuality === "better" && startOfStretch){
      var prior = [], m = startOfStretch.slice(0, 7);
      while(m < mk){
        var ms = collect(by, m + "-01" < startOfStretch ? startOfStretch : m + "-01", monthEnd(m), today, st);
        if(ms.starts.length >= 5) prior.push(ms.medStart);
        m = shiftMonth(m, 1);
      }
      earliest = prior.length >= 2 && prior.every(function(x){ return cur.medStart < x; });
    }
    var patternFrom = stretchStart(dates, to) || from;
    return {
      kind: "month", key: mk, from: from, to: to, isCurrent: today <= end && today >= mk + "-01", hasRecord: dates.length > 0,
      cur: cur, base: base, verdicts: v, earliest: earliest,
      lateRun: punctualityRun(cur),
      tips: v ? {
        punctuality: v.punctuality === "slipped" ? punctualityTip(cur) : null,
        hours: v.hours === "slipped" ? hoursTip(cur, v.punctuality === "slipped") : null,
        consistency: v.consistency === "slipped" ? consistencyTip(cur) : null
      } : {},
      away: awayPattern(by, patternFrom, to, today, st)
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
      lateDays: [], liveKnown: 0, live: 0, sameDayKnown: 0, sameDay: 0, workdays: 0, logged: 0,
      away: [], offDays: 0, remote: [], missing: [], notLive: [], loggedLater: [], days: [] };
    parts.forEach(function(p){
      ["worked", "weight", "workedSum", "shortMin", "liveKnown", "live", "sameDayKnown", "sameDay", "workdays", "logged", "offDays"]
        .forEach(function(k){ out[k] += p[k]; });
      ["short", "starts", "finishes", "lateDays", "away", "remote", "missing", "notLive", "loggedLater", "days"]
        .forEach(function(k){ out[k] = out[k].concat(p[k]); });
    });
    out.avgMin = out.weight ? out.workedSum / out.weight : null;
    out.shortRate = out.worked ? out.short.length / out.worked : null;
    out.medStart = median(out.starts);
    out.medFinish = median(out.finishes);
    out.lateRate = out.worked ? out.lateDays.length / out.worked : null;
    out.liveRate = out.liveKnown ? out.live / out.liveKnown : null;
    out.loggedRate = out.workdays ? out.logged / out.workdays : null;
    out.sameDayRate = out.sameDayKnown ? out.sameDay / out.sameDayKnown : null;
    return out;
  }

  // The whole Year view: a picture of the year from where logging started,
  // the year's own figures, and -- only where both years logged the same
  // months -- a comparison with last year.
  function yearRecap(entries, year, today, workDays, weekStartDate){
    var by = index(entries), dates = workedDates(by), st = stretches(dates, today);
    var yFrom = year + "-01-01", yEnd = year + "-12-31";
    var yTo = yEnd < today ? yEnd : today;
    var inYear = dates.filter(function(d){ return d >= yFrom && d <= yTo; });
    if(!inYear.length) return { kind: "year", year: year, empty: true };
    var last = inYear[inYear.length - 1];
    var start = stretchStart(dates, last);
    if(start < yFrom) start = yFrom;
    var end = today <= yEnd ? yTo : last;
    var cur = collect(by, start, end, today, st);

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
        wk[order.indexOf(dateFromStr(d).getDay())] = { date: d, status: statusOf[d] || (d >= today || !tracked(st, d) ? null : "missing") };
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
      cmpCur = merge(pairs.map(function(p){ return collect(by, p[0] + "-01", monthEnd(p[0]), today, st); }));
      cmpBase = merge(pairs.map(function(p){ return collect(by, p[1] + "-01", monthEnd(p[1]), today, st); }));
      cmpCur.standardIn = cur.standardIn;
      v = verdicts(cmpCur, cmpBase);
    }

    // Time off is the whole calendar year, not just the stretch: April's
    // leave is this year's leave whether or not April was clocked.
    var off = collect(by, yFrom, yTo, today);
    var offByMonth = {}, offByDow = [0, 0, 0, 0, 0, 0, 0], offHits = [0, 0, 0, 0, 0, 0, 0], offByType = {};
    off.away.forEach(function(a){
      // A half-day leave is half a day off, here as on the leave balance.
      var k = a.date.slice(0, 7), w = a.type === "halfleave" ? 0.5 : 1, dow = dateFromStr(a.date).getDay();
      offByMonth[k] = (offByMonth[k] || 0) + w;
      offByDow[dow] += w; offHits[dow]++;
      offByType[a.type] = (offByType[a.type] || 0) + 1;
    });
    var offTop = offHits.indexOf(Math.max.apply(null, offHits));
    var topMonth = null;
    Object.keys(offByMonth).forEach(function(k){ if(!topMonth || offByMonth[k] > offByMonth[topMonth]) topMonth = k; });

    // Each month of the picture on its own, for the cards that list months.
    var perMonth = months.map(function(mo){
      var f = mo.key + "-01" < start ? start : mo.key + "-01";
      var t = monthEnd(mo.key) > end ? end : monthEnd(mo.key);
      var s = collect(by, f, t, today, st);
      return { key: mo.key, medStart: s.medStart, worked: s.worked, late: s.lateDays.length, short: s.short.length, shortMin: s.shortMin,
        workdays: s.workdays, logged: s.logged, live: s.live, liveKnown: s.liveKnown };
    });

    return {
      kind: "year", year: year, from: start, to: end, isCurrent: today <= yEnd,
      cur: cur, months: months, order: order, pairs: pairs, cmpCur: cmpCur, cmpBase: cmpBase, verdicts: v,
      shortRuns: runs(cur.days.filter(function(d){ return d.status === "full" || d.status === "short"; }),
        function(d){ return d.status === "short"; }, 3),
      perMonth: perMonth,
      off: { total: off.offDays, remote: off.remote.length, topMonth: topMonth, topCount: topMonth ? offByMonth[topMonth] : 0,
        byDow: offByDow, byType: offByType, byMonth: offByMonth,
        top: (offHits[offTop] >= 3 && offHits[offTop] * 2 >= off.away.length) ? offTop : null },
      away: awayPattern(by, start, end, today, st),
      tips: v ? {
        punctuality: v.punctuality === "slipped" ? punctualityTip(cmpCur) : null,
        hours: v.hours === "slipped" ? hoursTip(cmpCur, v.punctuality === "slipped") : null,
        consistency: v.consistency === "slipped" ? consistencyTip(cmpCur) : null
      } : {}
    };
  }

  // Which month the Month view opens on: the current one, unless it is only
  // a few workdays old, in which case last month's finished recap.
  function defaultMonth(entries, today){
    var mk = today.slice(0, 7), by = index(entries);
    var s = collect(by, mk + "-01", today, today, stretches(workedDates(by), today));
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
