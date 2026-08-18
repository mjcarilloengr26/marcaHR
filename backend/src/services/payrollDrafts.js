const db = require("../db");
const { computeEmployeePayroll, getPayrollSettings, scheduleFor } = require("./payrollCalc");

// Changing someone's salary has to reach the payroll they have not been paid
// yet, or the Payroll page keeps showing the figure from before the change and
// looks like it was never wired to the employee record at all. Recalculates
// their DRAFT records only — finalized and paid runs are history and must not
// move — and preserves any bonuses HR typed onto the draft.
async function refreshDraftPayrollFor(employee) {
  const settings = await getPayrollSettings();
  // Which periods this employee should now have: one whole-month row, or one
  // per cut-off. Changing the schedule has to MOVE their unpaid payroll, not
  // just recompute it where it sits — a monthly row left behind still reads
  // "whole month" however many times payroll is regenerated, because
  // generation only ever touches the period it was asked for.
  const halves = scheduleFor(employee, settings) === "monthly" ? [0] : [1, 2];

  const periods = await db
    .prepare(
      "SELECT DISTINCT period_month, period_year FROM payroll_records WHERE employee_id = ? AND status = 'draft'"
    )
    .all(employee.id);

  let touched = 0;
  for (const p of periods) {
    // Carry over anything HR typed in, from whichever row currently holds it,
    // so re-filing does not quietly drop a bonus or a deduction.
    const carry = await db
      .prepare(
        `SELECT COALESCE(MAX(bonuses), 0) AS bonuses, COALESCE(MAX(deductions), 0) AS deductions
         FROM payroll_records WHERE employee_id = ? AND period_month = ? AND period_year = ? AND status = 'draft'`
      )
      .get(employee.id, p.period_month, p.period_year);

    for (const half of halves) {
      const pay = await computeEmployeePayroll(employee, p.period_month, p.period_year, half, settings);
      const net = Math.round((pay.base_salary + pay.overtime_pay + pay.night_differential_pay + carry.bonuses - carry.deductions) * 100) / 100;
      await db
        .prepare(
          `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, night_differential_pay, deductions, net_pay, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
           ON CONFLICT(employee_id, period_month, period_year, period_half) DO UPDATE SET
             base_salary = excluded.base_salary,
             overtime_pay = excluded.overtime_pay,
             night_differential_pay = excluded.night_differential_pay,
             net_pay = excluded.net_pay
           WHERE payroll_records.status = 'draft'`
        )
        .run(
          employee.id, p.period_month, p.period_year, half,
          pay.base_salary, carry.bonuses, pay.overtime_pay, pay.night_differential_pay, carry.deductions, net
        );
      touched++;
    }

    // Anything left in a period this employee is no longer paid over.
    await db
      .prepare(
        `DELETE FROM payroll_records
         WHERE employee_id = ? AND period_month = ? AND period_year = ?
           AND status = 'draft' AND period_half <> ALL(?::int[])`
      )
      .run(employee.id, p.period_month, p.period_year, `{${halves.join(",")}}`);
  }
  return touched;
}

module.exports = { refreshDraftPayrollFor };
