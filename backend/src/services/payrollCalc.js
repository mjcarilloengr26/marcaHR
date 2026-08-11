const db = require("../db");

// Cut-off is the 15th and the last day of the month (30/31, or 28/29 in Feb):
// half 1 covers the 1st-15th, half 2 covers the 16th-end. period_half 0 is
// reserved for legacy whole-month records created before this existed.
function payrollPeriodRange(period_month, period_year, period_half) {
  const mm = String(period_month).padStart(2, "0");
  if (Number(period_half) === 1) {
    return { start: `${period_year}-${mm}-01`, end: `${period_year}-${mm}-15` };
  }
  const lastDay = new Date(period_year, period_month, 0).getDate();
  return { start: `${period_year}-${mm}-16`, end: `${period_year}-${mm}-${String(lastDay).padStart(2, "0")}` };
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
    .prepare("SELECT status, clock_in, clock_out FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?")
    .all(employeeId, start, end);

  const standardHours = settings.standard_hours_per_day;
  const regularStart = hoursOf(settings.regular_start_time);
  const regularEnd = hoursOf(settings.regular_end_time);
  const otStart = hoursOf(settings.overtime_start_time);
  const otEnd = hoursOf(settings.overtime_end_time);

  let daysWorked = 0;
  let overtimeHours = 0;
  let nightHours = 0;

  for (const r of rows) {
    if (r.clock_in && r.clock_out) {
      const inH = hoursOf(r.clock_in);
      const outH = hoursOf(r.clock_out);
      const regularHours = overlapHours(inH, outH, regularStart, regularEnd);
      daysWorked += Math.min(1, standardHours > 0 ? regularHours / standardHours : 0);
      overtimeHours += overlapHours(inH, outH, otStart, otEnd);
      nightHours += overlapHours(inH, outH, NIGHT_WINDOW_START, NIGHT_WINDOW_END);
    } else if (r.status === "present" || r.status === "late" || r.status === "leave") {
      daysWorked += 1;
    } else if (r.status === "half_day") {
      daysWorked += 0.5;
    }
  }
  return { daysWorked, overtimeHours, nightHours };
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
  const { start, end } = payrollPeriodRange(period_month, period_year, period_half);
  const expectedDays = countWeekdays(start, end) || 1;
  const { daysWorked, overtimeHours, nightHours } = await computeAttendanceForPeriod(employee.id, start, end, settings);
  const dailyRate = employee.base_salary / 2 / expectedDays;
  const hourlyRate = settings.standard_hours_per_day > 0 ? dailyRate / settings.standard_hours_per_day : 0;
  const base_salary = Math.round(dailyRate * daysWorked * 100) / 100;
  const overtime_pay = Math.round(overtimeHours * hourlyRate * settings.overtime_multiplier * 100) / 100;
  const night_differential_pay = Math.round(nightHours * hourlyRate * (settings.night_shift_multiplier - 1) * 100) / 100;
  const net_pay = Math.round((base_salary + overtime_pay + night_differential_pay) * 100) / 100;
  return { base_salary, overtime_pay, night_differential_pay, net_pay };
}

module.exports = {
  payrollPeriodRange,
  currentPeriodHalf,
  countWeekdays,
  hoursOf,
  overlapHours,
  computeAttendanceForPeriod,
  getPayrollSettings,
  computeEmployeePayroll,
};
