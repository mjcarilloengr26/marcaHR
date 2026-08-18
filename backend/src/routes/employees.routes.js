const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const {
  currentPeriodHalf,
  periodsPerMonth,
  periodHalfFor,
  getPayrollSettings,
  computeEmployeePayroll,
  monthlyEquivalentSalary,
} = require("../services/payrollCalc");

const SALARY_BASES = ["monthly", "semi_monthly"];

const router = express.Router();

const EMPLOYEE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "department_id",
  "location_id",
  "position",
  "manager_id",
  "hire_date",
  "status",
  "base_salary",
  "salary_basis",
  "address",
  "photo",
  "deduction_sss",
  "deduction_hdmf",
  "deduction_philhealth",
  "deduction_taxes",
  "deduction_loans",
  "deduction_cash_advances",
];

// If payroll has already been generated for the current half-month period, a
// newly hired employee should show up in it immediately rather than sitting
// invisible in the Payroll list until HR notices and re-runs "Generate
// payroll for period". Targets the same real unique constraint
// (employee_id, period_month, period_year, period_half) the bulk
// /payroll/generate endpoint uses — this used to be a separate, drifted
// reimplementation targeting a two-column ON CONFLICT that stopped matching
// any real constraint once semi-monthly payroll periods were added, which
// made this insert throw on every call once payroll had already been
// generated for the month (silently corrupting the "employee created"
// response into a false "Could not create employee" error, even though the
// employee row itself had already committed).
//
// Base pay defaults to half the employee's monthly base salary rather than
// going through computeEmployeePayroll's attendance-proportional formula (as
// /payroll/generate does): a brand-new employee can never have prior
// attendance for this period (the employee_id didn't exist yet), so that
// formula would always floor this at ₱0 here specifically — which reads as
// "base salary isn't wired up" even though it's technically a correct zero-
// attendance computation. Overtime/night differential still start at 0 since
// there's nothing to compute them from — HR can adjust everything via Edit
// once the employee's actual attendance for the period is known.
async function backfillCurrentPayrollIfGenerated(employee) {
  if (employee.status !== "active") return;
  const now = new Date();
  const period_month = now.getMonth() + 1;
  const period_year = now.getFullYear();
  const settings = await getPayrollSettings();
  const period_half = periodHalfFor(settings, currentPeriodHalf(now));
  const alreadyGenerated = await db
    .prepare("SELECT 1 FROM payroll_records WHERE period_month = ? AND period_year = ? AND period_half = ? LIMIT 1")
    .get(period_month, period_year, period_half);
  if (!alreadyGenerated) return;
  const sss = employee.deduction_sss || 0;
  const hdmf = employee.deduction_hdmf || 0;
  const philhealth = employee.deduction_philhealth || 0;
  const taxes = employee.deduction_taxes || 0;
  const loans = employee.deduction_loans || 0;
  const cashAdvances = employee.deduction_cash_advances || 0;
  const deductions = sss + hdmf + philhealth + taxes + loans + cashAdvances;
  const pay = {
    // One period's share of the salary once it is normalised to a monthly
    // figure, which is the whole of it on a monthly frequency. This was a
    // hardcoded /2 and so underpaid a monthly-frequency backfill by half.
    base_salary: Math.round((monthlyEquivalentSalary(employee) / periodsPerMonth(settings)) * 100) / 100,
    overtime_pay: 0,
    night_differential_pay: 0,
  };
  pay.net_pay = Math.round((pay.base_salary - deductions) * 100) / 100;
  await db
    .prepare(
      `INSERT INTO payroll_records (employee_id, period_month, period_year, period_half, base_salary, bonuses, overtime_pay, night_differential_pay, deductions, deduction_sss, deduction_hdmf, deduction_philhealth, deduction_taxes, deduction_loans, deduction_cash_advances, net_pay, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
       ON CONFLICT(employee_id, period_month, period_year, period_half) DO NOTHING`
    )
    .run(
      employee.id,
      period_month,
      period_year,
      period_half,
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
      pay.net_pay
    );
}

router.get(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { department_id, status, q } = req.query;
    let sql = `SELECT e.*, d.name AS department_name, l.name AS location_name,
               (m.first_name || ' ' || m.last_name) AS manager_name
               FROM employees e
               LEFT JOIN departments d ON d.id = e.department_id
               LEFT JOIN locations l ON l.id = e.location_id
               LEFT JOIN employees m ON m.id = e.manager_id
               WHERE 1=1`;
    const params = [];
    if (department_id) {
      sql += " AND e.department_id = ?";
      params.push(department_id);
    }
    if (status) {
      sql += " AND e.status = ?";
      params.push(status);
    }
    if (q) {
      sql += " AND (e.first_name ILIKE ? OR e.last_name ILIKE ? OR e.email ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY e.last_name, e.first_name";
    res.json(await db.prepare(sql).all(...params));
  })
);

router.get(
  "/:id",
  requireAuth,
  requireSelfOrRole((req) => req.params.id, "admin", "hr"),
  asyncHandler(async (req, res) => {
    const employee = await db
      .prepare(
        `SELECT e.*, d.name AS department_name, l.name AS location_name,
         (m.first_name || ' ' || m.last_name) AS manager_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE e.id = ?`
      )
      .get(req.params.id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    res.json(employee);
  })
);

// Changing someone's salary has to reach the payroll they have not been paid
// yet, or the Payroll page keeps showing the figure from before the change and
// looks like it was never wired to the employee record at all. Recalculates
// their DRAFT records only — finalized and paid runs are history and must not
// move — and preserves any bonuses HR typed onto the draft.
async function refreshDraftPayrollFor(employee) {
  const settings = await getPayrollSettings();
  const drafts = await db
    .prepare(
      "SELECT id, period_month, period_year, period_half FROM payroll_records WHERE employee_id = ? AND status = 'draft'"
    )
    .all(employee.id);
  for (const d of drafts) {
    const pay = await computeEmployeePayroll(employee, d.period_month, d.period_year, d.period_half, settings);
    await db
      .prepare(
        `UPDATE payroll_records
         SET base_salary = ?, overtime_pay = ?, night_differential_pay = ?,
             net_pay = ? + ? + ? + bonuses - deductions
         WHERE id = ? AND status = 'draft'`
      )
      .run(
        pay.base_salary,
        pay.overtime_pay,
        pay.night_differential_pay,
        pay.base_salary,
        pay.overtime_pay,
        pay.night_differential_pay,
        d.id
      );
  }
  return drafts.length;
}

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.first_name || !body.last_name || !body.email) {
      return res.status(400).json({ error: "first_name, last_name and email are required" });
    }
    if (body.salary_basis !== undefined && !SALARY_BASES.includes(body.salary_basis)) {
      return res.status(400).json({ error: `salary_basis must be one of: ${SALARY_BASES.join(", ")}` });
    }
    const cols = EMPLOYEE_FIELDS.filter((f) => body[f] !== undefined);
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((f) => body[f]);
    try {
      const info = await db
        .prepare(`INSERT INTO employees (${cols.join(", ")}) VALUES (${placeholders})`)
        .run(...values);
      const employee = await db.prepare("SELECT * FROM employees WHERE id = ?").get(info.lastInsertRowid);
      await backfillCurrentPayrollIfGenerated(employee);
      await logRequestEvent(req, "create_employee", {
        entityType: "employee",
        entityId: employee.id,
        details: { name: `${employee.first_name} ${employee.last_name}`, email: employee.email },
      });
      res.status(201).json(employee);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({ error: "An employee with that email already exists" });
      }
      if (err.code === "23503") {
        return res.status(400).json({ error: "The selected department, location, or manager no longer exists — refresh the page and try again" });
      }
      res.status(400).json({ error: "Could not create employee" });
    }
  })
);

router.put(
  "/:id",
  requireAuth,
  requireSelfOrRole((req) => req.params.id, "admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Employee not found" });

    const body = req.body || {};
    if (body.salary_basis !== undefined && !SALARY_BASES.includes(body.salary_basis)) {
      return res.status(400).json({ error: `salary_basis must be one of: ${SALARY_BASES.join(", ")}` });
    }
    // Employees editing themselves can only update contact info, not salary/status/dept/manager.
    const allowedFields =
      req.user.role === "admin" || req.user.role === "hr"
        ? EMPLOYEE_FIELDS
        : ["phone", "address"];

    const cols = allowedFields.filter((f) => body[f] !== undefined);
    if (cols.length === 0) return res.json(existing);
    const setClause = cols.map((f) => `${f} = ?`).join(", ");
    const values = cols.map((f) => body[f]);
    try {
      await db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({ error: "An employee with that email already exists" });
      }
      if (err.code === "23503") {
        return res.status(400).json({ error: "The selected department, location, or manager no longer exists — refresh the page and try again" });
      }
      return res.status(400).json({ error: "Could not update employee" });
    }
    const updated = await db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);

    // Only when something that actually drives pay moved, so an edit to a
    // phone number does not quietly rewrite payroll.
    let refreshed = 0;
    const salaryMoved =
      (cols.includes("base_salary") && Number(existing.base_salary) !== Number(updated.base_salary)) ||
      (cols.includes("salary_basis") && existing.salary_basis !== updated.salary_basis);
    if (salaryMoved) {
      refreshed = await refreshDraftPayrollFor(updated);
    }

    await logRequestEvent(req, "update_employee", {
      entityType: "employee",
      entityId: Number(req.params.id),
      details: { fields: cols, drafts_recalculated: refreshed },
    });
    res.json(updated);
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Employee not found" });
    await db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_employee", {
      entityType: "employee",
      entityId: Number(req.params.id),
      details: { name: `${existing.first_name} ${existing.last_name}`, email: existing.email },
    });
    res.status(204).end();
  })
);

module.exports = router;
