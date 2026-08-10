const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Cut-off is the 15th and the last day of the month (30/31, or 28/29 in Feb):
// half 1 covers the 1st–15th, half 2 covers the 16th–end. period_half 0 is
// reserved for legacy whole-month records created before this existed.
function payrollPeriodRange(period_month, period_year, period_half) {
  const mm = String(period_month).padStart(2, "0");
  if (Number(period_half) === 1) {
    return { start: `${period_year}-${mm}-01`, end: `${period_year}-${mm}-15` };
  }
  const lastDay = new Date(period_year, period_month, 0).getDate();
  return { start: `${period_year}-${mm}-16`, end: `${period_year}-${mm}-${String(lastDay).padStart(2, "0")}` };
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

// Reads actual attendance for the period: days credited toward base pay
// (present/late/leave = 1 day, half_day = 0.5, absent or no record = 0) and
// overtime hours (time actually clocked beyond the standard workday, summed
// across the period — never negative, and a missing clock_out just isn't
// counted rather than guessed at).
async function computeAttendanceForPeriod(employeeId, start, end, standardHours) {
  const rows = await db
    .prepare("SELECT status, clock_in, clock_out FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?")
    .all(employeeId, start, end);
  let daysWorked = 0;
  let overtimeHours = 0;
  for (const r of rows) {
    if (r.status === "present" || r.status === "late" || r.status === "leave") daysWorked += 1;
    else if (r.status === "half_day") daysWorked += 0.5;
    if (r.clock_in && r.clock_out) {
      const worked = hoursOf(r.clock_out) - hoursOf(r.clock_in);
      if (worked > standardHours) overtimeHours += worked - standardHours;
    }
  }
  return { daysWorked, overtimeHours };
}

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
    const { standard_hours_per_day, overtime_multiplier } = req.body || {};
    await db
      .prepare(
        `UPDATE payroll_settings SET standard_hours_per_day = ?, overtime_multiplier = ?,
         updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = 1`
      )
      .run(
        standard_hours_per_day !== undefined ? standard_hours_per_day : existing.standard_hours_per_day,
        overtime_multiplier !== undefined ? overtime_multiplier : existing.overtime_multiplier
      );
    await logRequestEvent(req, "update_payroll_settings", {
      entityType: "payroll_settings",
      details: { standard_hours_per_day, overtime_multiplier },
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
    const { employee_id, period_month, period_year, base_salary, bonuses, overtime_pay, deductions, notes } = req.body || {};
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
    const deduction = deductions || 0;
    // Manual final-pay override: if net_pay is explicitly sent, trust it as-is
    // (e.g. HR reconciling to an exact bank transfer figure) instead of always
    // recomputing it from the components.
    const netOverride = req.body?.net_pay;
    const net = netOverride !== undefined && netOverride !== null && netOverride !== "" ? Number(netOverride) : base + bonus + overtime - deduction;

    await db
      .prepare(
        `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, deductions, net_pay, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(employee_id, period_month, period_year, period_half)
       DO UPDATE SET base_salary = excluded.base_salary, bonuses = excluded.bonuses,
         overtime_pay = excluded.overtime_pay, deductions = excluded.deductions,
         net_pay = excluded.net_pay, notes = excluded.notes`
      )
      .run(employee_id, period_month, period_year, half, base, bonus, overtime, deduction, net, notes || null);

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
    if (!period_month || !period_year || ![1, 2].includes(Number(period_half))) {
      return res.status(400).json({ error: "period_month, period_year and period_half (1 or 2) are required" });
    }
    const half = Number(period_half);
    const { start, end } = payrollPeriodRange(period_month, period_year, half);
    const expectedDays = countWeekdays(start, end) || 1;
    const settings = await db.prepare("SELECT * FROM payroll_settings WHERE id = 1").get();
    const standardHours = settings.standard_hours_per_day;
    const otMultiplier = settings.overtime_multiplier;

    const employees = await db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
    const insert = db.prepare(
      `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, deductions, net_pay, status)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, 'draft')
     ON CONFLICT(employee_id, period_month, period_year, period_half) DO NOTHING`
    );
    const generated = [];
    const runAll = db.transaction(async (rows) => {
      for (const e of rows) {
        const { daysWorked, overtimeHours } = await computeAttendanceForPeriod(e.id, start, end, standardHours);
        const dailyRate = e.base_salary / 2 / expectedDays;
        const hourlyRate = dailyRate / standardHours;
        const earnedBase = Math.round(dailyRate * daysWorked * 100) / 100;
        const overtimePay = Math.round(overtimeHours * hourlyRate * otMultiplier * 100) / 100;
        const net = Math.round((earnedBase + overtimePay) * 100) / 100;
        await insert.run(e.id, period_month, period_year, half, earnedBase, overtimePay, net);
        generated.push(e.id);
      }
    });
    await runAll(employees);
    await logRequestEvent(req, "generate_payroll", {
      entityType: "payroll",
      details: { period: `${MONTH_NAMES[period_month]} ${period_year}`, period_half: half, generated_count: generated.length },
    });
    res.status(201).json({ generated_count: generated.length });
  })
);

module.exports = router;
