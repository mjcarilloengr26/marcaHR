const db = require("../db");

// Cut-off is the 15th and the last day of the month (30/31, or 28/29 in Feb):
// half 1 covers the 1st-15th, half 2 covers the 16th-end. period_half 0 is
// reserved for legacy whole-month records created before this existed.
function payrollPeriodRange(period_month, period_year, period_half) {
  const mm = String(period_month).padStart(2, "0");
  const lastDay = String(new Date(period_year, period_month, 0).getDate()).padStart(2, "0");
  const half = Number(period_half);
  if (half === 1) {
    return { start: `${period_year}-${mm}-01`, end: `${period_year}-${mm}-15` };
  }
  if (half === 2) {
    return { start: `${period_year}-${mm}-16`, end: `${period_year}-${mm}-${lastDay}` };
  }
  // half 0 is the whole month: monthly pay frequency, and legacy whole-month
  // records created before the halves existed. This used to fall through to
  // the 16th-onward branch, which charged those records half a month of
  // working days and silently halved the pay they were built from.
  return { start: `${period_year}-${mm}-01`, end: `${period_year}-${mm}-${lastDay}` };
}

// How many payroll periods a month is split into, and so what share of the
// monthly base salary one period is worth.
// An employee's own pay schedule wins; the company setting is only the default
// for anyone who has not been given one. Someone on a monthly schedule is paid
// once for the whole month even at a company that otherwise runs twice a month.
function scheduleFor(employee, settings) {
  return employee?.salary_basis || settings?.pay_frequency || "semi_monthly";
}

function periodsPerMonth(settings) {
  return settings?.pay_frequency === "monthly" ? 1 : 2;
}

// The period this employee is actually paid over. Monthly is stored as half 0
// (the whole month) so it can never collide with a semi-monthly run, and so a
// monthly employee gets ONE record per month rather than appearing in both
// cut-offs at half the money.
function periodHalfForEmployee(employee, settings, requestedHalf) {
  return scheduleFor(employee, settings) === "monthly" ? 0 : Number(requestedHalf);
}

// Kept for callers that still ask about the company-wide default.
function periodHalfFor(settings, requestedHalf) {
  return periodsPerMonth(settings) === 1 ? 0 : Number(requestedHalf);
}

// The stated salary IS the pay for one of that employee's own periods —
// P30,000 monthly means P30,000 for the month, P15,000 semi-monthly means
// P15,000 each cut-off. No dividing: the schedule already says which.
function salaryForOnePeriod(employee) {
  return Number(employee?.base_salary) || 0;
}

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

// Which half-month period "now" falls into — used to know which period an
// employee created mid-month should be backfilled into.
function currentPeriodHalf(date = new Date()) {
  return date.getDate() <= 15 ? 1 : 2;
}

// Expected working days in the range — weekdays only, since the app has no
// holiday calendar to consult. Used to prorate the half-month base salary
// into a daily rate.
function countWeekdays(start, end) {
  let count = 0;
  const d = new Date(`${start}T00:00:00Z`);
  const endD = new Date(`${end}T00:00:00Z`);
  while (d <= endD) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function hoursOf(timeStr) {
  const [h, m, s] = timeStr.split(":").map(Number);
  return h + m / 60 + (s || 0) / 3600;
}

// Hours of overlap between a same-day shift [shiftStart, shiftEnd) (shiftEnd
// assumed >= shiftStart — this schema stores clock_in/clock_out on a single
// calendar date, so a true overnight shift isn't representable) and a named
// window [winStart, winEnd) that may itself wrap past midnight (winEnd <=
// winStart, e.g. the night differential window) — split into the two
// segments a wrapping window implies.
function overlapHours(shiftStart, shiftEnd, winStart, winEnd) {
  if (shiftEnd <= shiftStart) return 0;
  const segments = winEnd > winStart ? [[winStart, winEnd]] : [[winStart, 24], [0, winEnd]];
  let total = 0;
  for (const [s, e] of segments) {
    const start = Math.max(shiftStart, s);
    const end = Math.min(shiftEnd, e);
    if (end > start) total += end - start;
  }
  return total;
}

// Fixed statutory night shift differential window (10PM-6AM) — a legal
// definition (Philippine DOLE), not a scheduling choice, so unlike the
// regular/overtime windows this one isn't a configurable setting.
const NIGHT_WINDOW_START = 22;
const NIGHT_WINDOW_END = 6;

// Reads actual attendance for the period and turns it into three pay-driving
// quantities:
//   - daysWorked: day credit toward base pay. When a record has real
//     clock in/out times, credit is proportional to how much of the
//     configured regular shift window was actually covered (a late arrival
//     or early leave now visibly reduces base pay, where it previously
//     didn't) — capped at 1 day. Records without clock times (e.g. an HR
//     manual entry that only sets status) fall back to a flat day per the
//     status, same as before.
//   - overtimeHours: time actually clocked within the configured overtime
//     window, replacing the old "any time beyond standard hours" rule.
//   - nightHours: time actually clocked within the fixed night window,
//     for the night shift differential.
async function computeAttendanceForPeriod(employeeId, start, end, settings) {
  const rows = await db
    .prepare("SELECT date, status, clock_in, clock_out FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?")
    .all(employeeId, start, end);

  const standardHours = settings.standard_hours_per_day;
  const regularStart = hoursOf(settings.regular_start_time);
  const regularEnd = hoursOf(settings.regular_end_time);
  const otStart = hoursOf(settings.overtime_start_time);
  const otEnd = hoursOf(settings.overtime_end_time);

  let daysWorked = 0;
  let shortfallDays = 0;
  let overtimeHours = 0;
  let nightHours = 0;

  for (const r of rows) {
    let dayCredit = 0;
    if (r.clock_in && r.clock_out) {
      const inH = hoursOf(r.clock_in);
      const outH = hoursOf(r.clock_out);
      const regularHours = overlapHours(inH, outH, regularStart, regularEnd);
      dayCredit = Math.min(1, standardHours > 0 ? regularHours / standardHours : 0);
      overtimeHours += overlapHours(inH, outH, otStart, otEnd);
      nightHours += overlapHours(inH, outH, NIGHT_WINDOW_START, NIGHT_WINDOW_END);
    } else if (r.status === "present" || r.status === "late" || r.status === "leave") {
      dayCredit = 1;
    } else if (r.status === "half_day") {
      dayCredit = 0.5;
    }
    daysWorked += dayCredit;

    // How much of an expected working day this record failed to cover. It is
    // what the 'fixed' basis deducts from a full period's salary. Weekend
    // records are skipped because no salary was owed for those days in the
    // first place, so falling short of one cannot cost anything — while the
    // hours themselves still count toward overtime above.
    if (!isWeekend(r.date)) shortfallDays += 1 - dayCredit;
  }
  return { daysWorked, shortfallDays, overtimeHours, nightHours };
}

async function getPayrollSettings() {
  return db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get();
}

// The single source of truth for "how much does this employee earn for this
// period" — used both by bulk payroll generation and by the new-employee
// mid-period backfill, so the two can never again compute pay differently
// (that drift is what caused base pay to come out as 0/wrong for employees
// backfilled after the fact).
async function computeEmployeePayroll(employee, period_month, period_year, period_half, settings) {
  // The employee's own schedule decides the span, not whatever half the caller
  // asked for: a monthly employee is always computed over the whole month.
  const half = periodHalfForEmployee(employee, settings, period_half);
  const { start, end } = payrollPeriodRange(period_month, period_year, half);
  const expectedDays = countWeekdays(start, end) || 1;
  const { daysWorked, shortfallDays, overtimeHours, nightHours } = await computeAttendanceForPeriod(
    employee.id,
    start,
    end,
    settings
  );

  const periodSalary = salaryForOnePeriod(employee);
  const dailyRate = periodSalary / expectedDays;
  const hourlyRate = settings.standard_hours_per_day > 0 ? dailyRate / settings.standard_hours_per_day : 0;

  // 'fixed' starts from a full period and takes off recorded absences, so a
  // salaried employee is paid whether or not anyone uses the time clock.
  // 'worked_days' pays only for days attendance can account for — under which
  // a period with no attendance records at all correctly earns nothing.
  const paidDays =
    settings.attendance_basis === "worked_days"
      ? daysWorked
      : Math.max(0, Math.min(expectedDays, expectedDays - shortfallDays));

  const base_salary = Math.round(dailyRate * paidDays * 100) / 100;
  const overtime_pay = Math.round(overtimeHours * hourlyRate * settings.overtime_multiplier * 100) / 100;
  const night_differential_pay = Math.round(nightHours * hourlyRate * (settings.night_shift_multiplier - 1) * 100) / 100;
  const net_pay = Math.round((base_salary + overtime_pay + night_differential_pay) * 100) / 100;
  return {
    base_salary,
    overtime_pay,
    night_differential_pay,
    net_pay,
    // Returned so a caller can explain the figure rather than just assert it.
    period_start: start,
    period_end: end,
    period_half: half,
    schedule: scheduleFor(employee, settings),
    expected_days: expectedDays,
    paid_days: Math.round(paidDays * 100) / 100,
    period_salary: Math.round(periodSalary * 100) / 100,
    daily_rate: Math.round(dailyRate * 100) / 100,
  };
}

module.exports = {
  payrollPeriodRange,
  periodsPerMonth,
  periodHalfFor,
  scheduleFor,
  periodHalfForEmployee,
  salaryForOnePeriod,
  currentPeriodHalf,
  countWeekdays,
  hoursOf,
  overlapHours,
  computeAttendanceForPeriod,
  getPayrollSettings,
  computeEmployeePayroll,
};
