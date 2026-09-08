const db = require("../db");

// Which days a project plan may put work on, and the date arithmetic that
// follows from it.
//
// Deliberately scoped to planning. Payroll keeps its own Saturday/Sunday rule
// and attendance records whatever actually happened — neither should change
// because a planner picked a six-day week, and wiring one setting into all
// three would make a scheduling decision quietly restate someone's pay.
//
// Not modelled: public holidays. A Mon-Sat plan will still schedule straight
// through Christmas and Holy Week, which in the Philippines is a real number
// of days. The same gap already exists in payrollCalc. Worth knowing before
// trusting a long plan to the day; a holidays table is the natural next step.

const DAY_MS = 86400000;
const FALLBACK = "mon_sun";

// Sunday is 0 through Saturday is 6, matching getUTCDay().
const WEEKS = {
  mon_fri: new Set([1, 2, 3, 4, 5]),
  mon_sat: new Set([1, 2, 3, 4, 5, 6]),
  mon_sun: new Set([0, 1, 2, 3, 4, 5, 6]),
};

const LABELS = {
  mon_fri: "Monday to Friday",
  mon_sat: "Monday to Saturday",
  mon_sun: "Every day",
};

const toUTC = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addCalendarDays = (date, n) => iso(toUTC(date) + n * DAY_MS);
const dayOfWeek = (date) => new Date(toUTC(date)).getUTCDay();

// Read on every schedule calculation, changed about once per installation —
// the same short cache the timezone setting uses, for the same reason.
let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function workingWeek() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const row = await db.prepare("SELECT working_week FROM app_settings WHERE id = 1").get();
    const value = row?.working_week?.trim();
    cached = WEEKS[value] ? value : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  cachedAt = Date.now();
  return cached;
}

function clearWorkingWeekCache() {
  cached = null;
  cachedAt = 0;
}

// A calendar built once per calculation and passed down, rather than each
// helper reading the setting itself: one schedule run touches these hundreds
// of times, and a plan half-computed against two different weeks would be
// worse than either.
function calendarFor(week) {
  const days = WEEKS[week] || WEEKS[FALLBACK];
  const isWorking = (date) => days.has(dayOfWeek(date));

  // Every week is a working week in the mon_sun case, so the loops below can
  // never run away; for the others at most six steps finds the next one.
  const nextWorkingDay = (date) => {
    let d = date;
    for (let i = 0; i < 7 && !isWorking(d); i += 1) d = addCalendarDays(d, 1);
    return d;
  };

  // Inclusive of both ends, which is how a task's span reads on the chart: a
  // job that starts and finishes on the same day is one day long, not zero.
  const workingDaysBetween = (start, end) => {
    if (end < start) return 0;
    let count = 0;
    for (let d = start; d <= end; d = addCalendarDays(d, 1)) if (isWorking(d)) count += 1;
    return count;
  };

  // The last day of a task that starts on `start` and runs for `n` working
  // days. Counts the start day itself when it is a working day, so 1 day means
  // "starts and ends today".
  const endAfterWorkingDays = (start, n) => {
    const from = nextWorkingDay(start);
    if (n <= 1) return from;
    let remaining = n - 1;
    let d = from;
    // Bounded by the span it is building: a runaway here would hang the
    // request, and no legitimate task runs longer than a decade.
    for (let guard = 0; remaining > 0 && guard < 4000; guard += 1) {
      d = addCalendarDays(d, 1);
      if (isWorking(d)) remaining -= 1;
    }
    return d;
  };

  return { week, days, isWorking, nextWorkingDay, workingDaysBetween, endAfterWorkingDays };
}

async function currentCalendar() {
  return calendarFor(await workingWeek());
}

module.exports = {
  workingWeek,
  clearWorkingWeekCache,
  calendarFor,
  currentCalendar,
  addCalendarDays,
  WEEKS,
  LABELS,
  FALLBACK,
};
