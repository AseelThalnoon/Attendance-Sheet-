// The rules that turn a schedule and a day into hours, lateness and a target.
//
// This is the part of the old Helpers block that could not move on its own,
// because every function here reads `settings` -- which working days count,
// what the target is, how much grace a late arrival gets, which seasonal
// period covers a date.
//
// It takes a GETTER rather than a settings object, and that is the whole
// design. app.js swaps settings out from under this code on purpose: the Team
// roster computes each person's hours against THEIR schedule by assigning
// `settings = personSettings`, reading, and restoring in a finally. Three
// places do it. Had this module been handed a settings object at construction,
// or kept its own synced copy, every one of those swaps would have been
// invisible to it and one person's hours would have been measured against
// another's working week -- silently, and correctly-looking. A getter reads
// whatever is current at the moment of the call, so the swap keeps working
// without this file knowing it happens.
//
// app.js stays the owner of the state. Nothing here writes to settings.
import { DAY_NAMES, DAY_FULL, EXCUSED_TYPES, HALF_TYPES, NO_TARGET_TYPES } from "./constants.js";
import { dateFromStr, dateToStr, todayStr, timeToMinutes, formatTime12, minutesToHoursStr } from "./time.js";

export function makeSchedule(getSettings){
  function isScheduled(dateStr){
    return getSettings().workDays.indexOf(dateFromStr(dateStr).getDay()) !== -1;
  }
  // A generic single-day fallback for charts/labels that need *some* target
  // before any entries exist to average from. Resolves today's seasonal
  // period (Ramadan, summer hours) rather than the flat org default, so it
  // doesn't quietly show 8h while a 5h period is actually in force.
  function targetMinPerDay(){ return scheduleFor(todayStr()).targetMin; }

  // Resolves the schedule in force on a given date. Seasonal periods (Ramadan,
  // summer hours) override the base schedule for the dates they cover.
  function scheduleFor(dateStr){
    var list = getSettings().periods || [];
    for(var i=0;i<list.length;i++){
      var p = list[i];
      if(p.start && p.end && dateStr >= p.start && dateStr <= p.end){
        return {
          targetMin: p.targetMin != null ? p.targetMin : getSettings().targetMin,
          standardIn: p.standardIn || getSettings().standardIn,
          standardOut: p.standardOut || getSettings().standardOut,
          name: p.name || "Seasonal hours"
        };
      }
    }
    return {
      targetMin: getSettings().targetMin,
      standardIn: getSettings().standardIn,
      standardOut: getSettings().standardOut,
      name: ""
    };
  }

  // Shared by the Settings summary line and the audit log's schedule diff,
  // so "Sun–Thu" means the same thing and is spelled the same way in both.
  function workDaysLabel(days){
    days = days.slice().sort(function(a,b){return a-b;});
    // Show as a range when the days are contiguous, otherwise list them.
    var contiguous = days.every(function(d,i){ return i === 0 || d === days[i-1]+1; });
    if(days.length === 1) return DAY_FULL[days[0]];
    if(contiguous) return DAY_NAMES[days[0]] + "–" + DAY_NAMES[days[days.length-1]];
    return days.map(function(d){ return DAY_NAMES[d]; }).join(", ");
  }

  function scheduleSummary(){
    var label = workDaysLabel(getSettings().workDays);
    var today = scheduleFor(todayStr());
    var base = formatTime12(today.standardIn) + "–" + formatTime12(today.standardOut) +
               " · " + label + " · Target " + minutesToHoursStr(today.targetMin) + "/day";
    return today.name ? base + " · " + today.name : base;
  }

  function computeEntry(e){
    var excused = EXCUSED_TYPES.indexOf(e.type) !== -1;
    // Leave/sick/holiday plus WFH/trip/training: none of these owe a fixed
    // daily target, so there is nothing for a blank row to fall short of.
    var noTarget = excused || NO_TARGET_TYPES.indexOf(e.type) !== -1;
    var half = HALF_TYPES.indexOf(e.type) !== -1;
    var scheduled = isScheduled(e.date);
    var sched = scheduleFor(e.date);

    var targetMin = 0;
    if(scheduled && !noTarget){
      targetMin = half ? Math.round(sched.targetMin / 2) : sched.targetMin;
    }

    // Worked hours first — punctuality can depend on whether the target was met.
    var workedMin = null;
    if(e.clockIn && e.clockOut){
      var gross = timeToMinutes(e.clockOut) - timeToMinutes(e.clockIn);
      if(gross < 0) gross += 24*60; // overnight shift
      workedMin = Math.max(0, gross);
    } else if(noTarget && !e.clockIn){
      // Nothing clocked and nothing owed: zero, not a shortfall. A clock-in
      // with no clock-out yet still falls through to the open-day handling
      // below regardless of type — a running WFH/trip/training shift is an
      // open day like any other, not a free pass to look closed.
      workedMin = 0;
    }

    // Punctuality is only meaningful on a scheduled, non-excused day.
    var lateMin = 0, earlyMin = 0;
    var grace = getSettings().graceMin || 0;
    var countable = scheduled && !excused;

    // When "only if short" is on, making up the hours clears the flag. A day
    // that's still open can't be judged yet, so it isn't flagged either way —
    // but it must not be counted as *on time* either. `pending` marks that
    // distinction so the On Time tab can exclude the day rather than silently
    // score it clean and then flip it to late once the user clocks out.
    var metTarget = workedMin !== null && workedMin >= targetMin;
    var pending = getSettings().lateOnlyIfShort && workedMin === null && !!e.clockIn && countable;
    var forgiven = getSettings().lateOnlyIfShort && (metTarget || workedMin === null);

    if(countable && e.clockIn && !forgiven){
      var lm = timeToMinutes(e.clockIn) - timeToMinutes(sched.standardIn);
      if(lm > grace) lateMin = lm;
    }
    // A half day is meant to end early, so leaving early isn't a departure flag.
    if(countable && !half && e.clockIn && e.clockOut && !forgiven){
      var em = timeToMinutes(sched.standardOut) - timeToMinutes(e.clockOut);
      if(em > grace) earlyMin = em;
    }

    // An off-day (weekend, or any day outside the configured work days) is
    // neutral the same way an excused/no-target day is: whatever gets logged
    // — 20 hours or nothing — must not read as credit or a shortfall.
    var neutral = noTarget || !scheduled;

    if(workedMin !== null && !(noTarget && !e.clockIn)){
      return {
        workedMin:workedMin, targetMin:targetMin,
        diffMin: neutral ? 0 : workedMin - targetMin,
        excused:excused, half:half, scheduled:scheduled, open:false,
        lateMin:lateMin, earlyMin:earlyMin, sched:sched, pending:false
      };
    }
    return {
      workedMin: noTarget ? 0 : null, targetMin:targetMin,
      diffMin: noTarget ? 0 : null, excused:excused, half:half, scheduled:scheduled,
      open: !!(e.clockIn && !e.clockOut),
      lateMin:lateMin, earlyMin:0, sched:sched, pending:pending
    };
  }

  // The week starts on the first configured working day rather than always
  // Sunday. Hardcoding Sunday was right for the Sun–Thu default but split every
  // week in half for a Mon–Fri organisation, so weekly cards straddled two
  // working weeks and the "vs. last week" trend compared mismatched periods.
  function weekStartDow(){
    var days = (getSettings().workDays || []).slice().sort(function(a,b){ return a-b; });
    if(!days.length) return 0;
    // Contiguous runs that wrap the week boundary (e.g. Sat–Wed) should start at
    // the run's beginning, not at the lowest numeric day.
    for(var i=0;i<days.length;i++){
      var prev = days[(i - 1 + days.length) % days.length];
      if(((days[i] - prev + 7) % 7) !== 1) return days[i];
    }
    return days[0];
  }
  function weekStartDate(dateStr){
    var d = dateFromStr(dateStr);
    var offset = (d.getDay() - weekStartDow() + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }
  function weekKey(dateStr){ return dateToStr(weekStartDate(dateStr)); }

  return {
    isScheduled, targetMinPerDay, scheduleFor, workDaysLabel, scheduleSummary,
    computeEntry, weekStartDow, weekStartDate, weekKey
  };
}
