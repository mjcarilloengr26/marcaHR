const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
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

  sql += " ORDER BY p.period_year DESC, p.period_month DESC";
  res.json(db.prepare(sql).all(...params));
});

router.get(
  "/:id",
  requireAuth,
  (req, res, next) => {
    const record = db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found" });
    if (req.user.role === "employee" && req.user.employee_id !== record.employee_id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    req.payrollRecord = record;
    next();
  },
  (req, res) => {
    const employee = db.prepare("SELECT first_name, last_name, email, position FROM employees WHERE id = ?").get(
      req.payrollRecord.employee_id
    );
    res.json({ ...req.payrollRecord, employee });
  }
);

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { employee_id, period_month, period_year, base_salary, bonuses, overtime_pay, deductions, notes } = req.body || {};
  if (!employee_id || !period_month || !period_year) {
    return res.status(400).json({ error: "employee_id, period_month and period_year are required" });
  }
  const employee = db.prepare("SELECT * FROM employees WHERE id = ?").get(employee_id);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const base = base_salary ?? employee.base_salary;
  const bonus = bonuses || 0;
  const overtime = overtime_pay || 0;
  const deduction = deductions || 0;
  const net = base + bonus + overtime - deduction;

  db.prepare(
    `INSERT INTO payroll_records (employee_id, period_month, period_year, base_salary, bonuses, overtime_pay, deductions, net_pay, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(employee_id, period_month, period_year)
       DO UPDATE SET base_salary = excluded.base_salary, bonuses = excluded.bonuses,
         overtime_pay = excluded.overtime_pay, deductions = excluded.deductions,
         net_pay = excluded.net_pay, notes = excluded.notes`
  ).run(employee_id, period_month, period_year, base, bonus, overtime, deduction, net, notes || null);

  // lastInsertRowid is unreliable on the UPDATE path of an upsert, so look the row up by its natural key.
  const record = db
    .prepare("SELECT * FROM payroll_records WHERE employee_id = ? AND period_month = ? AND period_year = ?")
    .get(
        employee_id,
        period_month,
        period_year
      );
  res.status(201).json(record);
});

router.put("/:id/status", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status } = req.body || {};
  if (!["draft", "finalized", "paid"].includes(status)) {
    return res.status(400).json({ error: "status must be draft, finalized or paid" });
  }
  const record = db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id);
  if (!record) return res.status(404).json({ error: "Payroll record not found" });
  db.prepare("UPDATE payroll_records SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM payroll_records WHERE id = ?").get(req.params.id));
});

router.post("/generate", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { period_month, period_year } = req.body || {};
  if (!period_month || !period_year) {
    return res.status(400).json({ error: "period_month and period_year are required" });
  }
  const employees = db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
  const insert = db.prepare(
    `INSERT INTO payroll_records (employee_id, period_month, period_year, base_salary, bonuses, overtime_pay, deductions, net_pay, status)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, 'draft')
     ON CONFLICT(employee_id, period_month, period_year) DO NOTHING`
  );
  const generated = [];
  const runAll = db.transaction((rows) => {
    for (const e of rows) {
      insert.run(e.id, period_month, period_year, e.base_salary, e.base_salary);
      generated.push(e.id);
    }
  });
  runAll(employees);
  res.status(201).json({ generated_count: generated.length });
});

module.exports = router;
