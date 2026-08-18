const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const {
  payrollPeriodRange,
  countWeekdays,
  computeEmployeePayroll,
  periodsPerMonth,
  periodHalfFor,
  periodHalfForEmployee,
} = require("../services/payrollCalc");

const PAY_FREQUENCIES = ["semi_monthly", "monthly"];
const ATTENDANCE_BASES = ["fixed", "worked_days"];

const router = express.Router();

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

router.get(
  "/settings",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get());
  })
);

router.put(
  "/settings",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get();
    const {
      standard_hours_per_day,
      overtime_multiplier,
      regular_start_time,
      regular_end_time,
      overtime_start_time,
      overtime_end_time,
      night_shift_multiplier,
      pay_frequency,
      attendance_basis,
    } = req.body || {};

    for (const [label, value] of [
      ["regular_start_time", regular_start_time],
      ["regular_end_time", regular_end_time],
      ["overtime_start_time", overtime_start_time],
      ["overtime_end_time", overtime_end_time],
    ]) {
      if (value !== undefined && !TIME_RE.test(value)) {
        return res.status(400).json({ error: `${label} must be a 24-hour HH:MM time` });
      }
    }
    if (night_shift_multiplier !== undefined && !(Number(night_shift_multiplier) > 0)) {
      return res.status(400).json({ error: "night_shift_multiplier must be a positive number" });
    }
    if (pay_frequency !== undefined && !PAY_FREQUENCIES.includes(pay_frequency)) {
      return res.status(400).json({ error: `pay_frequency must be one of: ${PAY_FREQUENCIES.join(", ")}` });
    }
    if (attendance_basis !== undefined && !ATTENDANCE_BASES.includes(attendance_basis)) {
      return res.status(400).json({ error: `attendance_basis must be one of: ${ATTENDANCE_BASES.join(", ")}` });
    }

    await db
      .prepare(
        `UPDATE payroll_settings SET standard_hours_per_day = ?, overtime_multiplier = ?,
         regular_start_time = ?, regular_end_time = ?, overtime_start_time = ?, overtime_end_time = ?,
         night_shift_multiplier = ?, pay_frequency = ?, attendance_basis = ?,
         updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = 1`
      )
      .run(
        standard_hours_per_day !== undefined ? standard_hours_per_day : existing.standard_hours_per_day,
        overtime_multiplier !== undefined ? overtime_multiplier : existing.overtime_multiplier,
        regular_start_time !== undefined ? regular_start_time : existing.regular_start_time,
        regular_end_time !== undefined ? regular_end_time : existing.regular_end_time,
        overtime_start_time !== undefined ? overtime_start_time : existing.overtime_start_time,
        overtime_end_time !== undefined ? overtime_end_time : existing.overtime_end_time,
        night_shift_multiplier !== undefined ? night_shift_multiplier : existing.night_shift_multiplier,
        pay_frequency !== undefined ? pay_frequency : existing.pay_frequency,
        attendance_basis !== undefined ? attendance_basis : existing.attendance_basis
      );
    await logRequestEvent(req, "update_payroll_settings", {
      entityType: "payroll_settings",
      details: {
        standard_hours_per_day,
        overtime_multiplier,
        regular_start_time,
        regular_end_time,
        overtime_start_time,
        overtime_end_time,
        night_shift_multiplier,
        pay_frequency,
        attendance_basis,
      },
    });
    res.json(await db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get());
  })
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `SELECT p.*, (e.first_name || ' ' || e.last_name) AS employee_name
             FROM payroll_records p JOIN employees e ON e.id = p.employee_id WHERE 1=1`;
    const params = [];

    if (req.user.role === "employee") {
      sql += " AND p.employee_id = ?";
      params.push(req.user.employee_id);
    } else if (req.query.employee_id) {
      sql += " AND p.employee_id = ?";
      params.push(req.query.employee_id);
    }

    if (req.query.period_month && req.query.period_year) {
      sql += " AND p.period_month = ? AND p.period_year = ?";
      params.push(req.query.period_month, req.query.period_year);
    }
    if (req.query.period_half !== undefined) {
      sql += " AND p.period_half = ?";
      params.push(req.query.period_half);
    }

    sql += " ORDER BY p.period_year DESC, p.period_month DESC, p.period_half DESC";
    res.json(await db.prepare(sql).all(...params));
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res, next) => {
    const record = await db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found" });
    if (req.user.role === "employee" && req.user.employee_id !== record.employee_id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    req.payrollRecord = record;
    next();
  }),
  asyncHandler(async (req, res) => {
    const employee = await db.prepare("SELECT first_name, last_name, email, position FROM employees WHERE id = ?").get(
      req.payrollRecord.employee_id
    );
    res.json({ ...req.payrollRecord, employee });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const {
      employee_id,
      period_month,
      period_year,
      base_salary,
      bonuses,
      overtime_pay,
      night_differential_pay,
      deduction_sss,
      deduction_hdmf,
      deduction_philhealth,
      deduction_taxes,
      deduction_loans,
      deduction_cash_advances,
      notes,
    } = req.body || {};
    if (!employee_id || !period_month || !period_year) {
      return res.status(400).json({ error: "employee_id, period_month and period_year are required" });
    }
    const half = req.body?.period_half !== undefined ? Number(req.body.period_half) : 0;
    const employee = await db.prepare("SELECT * FROM employees WHERE id = ?").get(employee_id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    // Editing an existing record must not silently reopen a run HR already
    // finalized or paid out.
    const existing = await db
      .prepare("SELECT * FROM payroll_records WHERE employee_id = ? AND period_month = ? AND period_year = ? AND period_half = ?")
      .get(employee_id, period_month, period_year, half);
    if (existing && existing.status !== "draft") {
      return res.status(400).json({ error: "Only draft payroll records can be edited" });
    }

    const base = base_salary ?? employee.base_salary;
    const bonus = bonuses || 0;
    const overtime = overtime_pay || 0;
    const nightDiff = night_differential_pay || 0;
    // Deductions are entered per-category (SSS, HDMF, PhilHealth, taxes, loans,
    // cash advances) rather than as one lump sum — `deductions` is derived as
    // their total, kept as a stored column so existing readers (payroll table,
    // Excel export) don't need to know about the breakdown.
    const sss = deduction_sss || 0;
    const hdmf = deduction_hdmf || 0;
    const philhealth = deduction_philhealth || 0;
    const taxes = deduction_taxes || 0;
    const loans = deduction_loans || 0;
    const cashAdvances = deduction_cash_advances || 0;
    const deduction = sss + hdmf + philhealth + taxes + loans + cashAdvances;
    // Manual final-pay override: if net_pay is explicitly sent, trust it as-is
    // (e.g. HR reconciling to an exact bank transfer figure) instead of always
    // recomputing it from the components.
    const netOverride = req.body?.net_pay;
    const net = netOverride !== undefined && netOverride !== null && netOverride !== "" ? Number(netOverride) : base + bonus + overtime + nightDiff - deduction;

    // Persist the edited deduction breakdown onto the employee as their new
    // standing amounts, so /payroll/generate and the new-employee backfill
    // carry it into every future cut-off automatically instead of resetting
    // to 0 — deductions like SSS/HDMF/PhilHealth/loan amortization are
    // normally unchanged period to period until HR edits them again here.
    const deductionFieldsTouched = [
      deduction_sss,
      deduction_hdmf,
      deduction_philhealth,
      deduction_taxes,
      deduction_loans,
      deduction_cash_advances,
    ].some((v) => v !== undefined);
    if (deductionFieldsTouched) {
      await db
        .prepare(
          `UPDATE employees SET deduction_sss = ?, deduction_hdmf = ?, deduction_philhealth = ?,
           deduction_taxes = ?, deduction_loans = ?, deduction_cash_advances = ? WHERE id = ?`
        )
        .run(
          deduction_sss !== undefined ? sss : employee.deduction_sss,
          deduction_hdmf !== undefined ? hdmf : employee.deduction_hdmf,
          deduction_philhealth !== undefined ? philhealth : employee.deduction_philhealth,
          deduction_taxes !== undefined ? taxes : employee.deduction_taxes,
          deduction_loans !== undefined ? loans : employee.deduction_loans,
          deduction_cash_advances !== undefined ? cashAdvances : employee.deduction_cash_advances,
          employee_id
        );
    }

    await db
      .prepare(
        `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, night_differential_pay, deductions, deduction_sss, deduction_hdmf, deduction_philhealth, deduction_taxes, deduction_loans, deduction_cash_advances, net_pay, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(employee_id, period_month, period_year, period_half)
       DO UPDATE SET base_salary = excluded.base_salary, bonuses = excluded.bonuses,
         overtime_pay = excluded.overtime_pay, night_differential_pay = excluded.night_differential_pay,
         deductions = excluded.deductions, deduction_sss = excluded.deduction_sss, deduction_hdmf = excluded.deduction_hdmf,
         deduction_philhealth = excluded.deduction_philhealth, deduction_taxes = excluded.deduction_taxes,
         deduction_loans = excluded.deduction_loans, deduction_cash_advances = excluded.deduction_cash_advances,
         net_pay = excluded.net_pay, notes = excluded.notes`
      )
      .run(
        employee_id,
        period_month,
        period_year,
        half,
        base,
        bonus,
        overtime,
        nightDiff,
        deduction,
        sss,
        hdmf,
        philhealth,
        taxes,
        loans,
        cashAdvances,
        net,
        notes || null
      );

    // lastInsertRowid is unreliable on the UPDATE path of an upsert, so look the row up by its natural key.
    const record = await db
      .prepare("SELECT * FROM payroll_records WHERE employee_id = ? AND period_month = ? AND period_year = ? AND period_half = ?")
      .get(employee_id, period_month, period_year, half);
    await logRequestEvent(req, "update_payroll", {
      entityType: "payroll",
      entityId: record.id,
      details: { employee_id, period: `${MONTH_NAMES[period_month]} ${period_year}`, net_pay: record.net_pay },
    });
    res.status(201).json(record);
  })
);

router.put(
  "/:id/status",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    if (!["draft", "finalized", "paid"].includes(status)) {
      return res.status(400).json({ error: "status must be draft, finalized or paid" });
    }
    const record = await db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found" });
    await db.prepare("UPDATE payroll_records SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json(await db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id));
  })
);

router.post(
  "/generate",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { period_month, period_year, period_half } = req.body || {};
    if (!period_month || !period_year) {
      return res.status(400).json({ error: "period_month and period_year are required" });
    }
    const settings = await db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get();

    // On a monthly frequency there is no first/second half to choose, so the
    // run is stored as half 0 (the whole month) whatever the caller asked for.
    // Semi-monthly still requires an explicit half — generating the wrong one
    // silently would pay the wrong fortnight.
    const semiMonthly = periodsPerMonth(settings) === 2;
    if (semiMonthly && ![1, 2].includes(Number(period_half))) {
      return res.status(400).json({ error: "period_half (1 or 2) is required on a semi-monthly pay frequency" });
    }
    const half = periodHalfFor(settings, period_half);

    const employees = await db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
    const insert = db.prepare(
      `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, night_differential_pay, deductions, deduction_sss, deduction_hdmf, deduction_philhealth, deduction_taxes, deduction_loans, deduction_cash_advances, net_pay, status)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
     ON CONFLICT(employee_id, period_month, period_year, period_half) DO UPDATE SET
       base_salary = excluded.base_salary,
       overtime_pay = excluded.overtime_pay,
       night_differential_pay = excluded.night_differential_pay,
       deductions = excluded.deductions,
       deduction_sss = excluded.deduction_sss,
       deduction_hdmf = excluded.deduction_hdmf,
       deduction_philhealth = excluded.deduction_philhealth,
       deduction_taxes = excluded.deduction_taxes,
       deduction_loans = excluded.deduction_loans,
       deduction_cash_advances = excluded.deduction_cash_advances,
       net_pay = excluded.base_salary + excluded.overtime_pay + excluded.night_differential_pay
                 + payroll_records.bonuses - excluded.deductions
     WHERE payroll_records.status = 'draft'`
    );
    const generated = [];
    // Re-running a period recalculates its DRAFT rows rather than skipping
    // them, so a corrected salary or a changed payroll setting actually shows
    // up. It used to skip every existing row, which meant a period generated
    // once could never be fixed. Finalized and paid runs are left alone by the
    // WHERE clause, and any bonuses HR typed onto a draft are preserved and
    // still counted into net pay.
    // Deductions carry forward from each employee's standing amounts (set the
    // last time HR edited a payroll record — see POST /) rather than starting
    // at 0 every cut-off, since SSS/HDMF/PhilHealth/loan amortization etc.
    // are normally the same period to period until HR changes them.
    const runAll = db.transaction(async (rows) => {
      for (const e of rows) {
        const pay = await computeEmployeePayroll(e, period_month, period_year, half, settings);
        // Monthly-schedule staff are stored against the whole month (half 0)
        // no matter which cut-off was asked for, so they get one record a
        // month instead of showing up in both halves at half the money.
        const empHalf = periodHalfForEmployee(e, settings, half);
        const sss = e.deduction_sss || 0;
        const hdmf = e.deduction_hdmf || 0;
        const philhealth = e.deduction_philhealth || 0;
        const taxes = e.deduction_taxes || 0;
        const loans = e.deduction_loans || 0;
        const cashAdvances = e.deduction_cash_advances || 0;
        const deductions = sss + hdmf + philhealth + taxes + loans + cashAdvances;
        const netPay = Math.round((pay.net_pay - deductions) * 100) / 100;
        await insert.run(
          e.id,
          period_month,
          period_year,
          empHalf,
          pay.base_salary,
          pay.overtime_pay,
          pay.night_differential_pay,
          deductions,
          sss,
          hdmf,
          philhealth,
          taxes,
          loans,
          cashAdvances,
          netPay
        );
        generated.push(e.id);
      }
    });
    await runAll(employees);
    await logRequestEvent(req, "generate_payroll", {
      entityType: "payroll",
      details: {
        period: `${MONTH_NAMES[period_month]} ${period_year}`,
        period_half: half,
        pay_frequency: settings.pay_frequency,
        attendance_basis: settings.attendance_basis,
        generated_count: generated.length,
      },
    });
    res.status(201).json({ generated_count: generated.length });
  })
);

module.exports = router;
