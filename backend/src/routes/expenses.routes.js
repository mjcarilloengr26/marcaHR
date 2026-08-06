const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const { notifyExpenseSubmitted, notifyExpenseStatusChanged } = require("../notifications");

const router = express.Router();

function withTotals(report) {
  const totals = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expense_items WHERE report_id = ?")
    .get(report.id);
  const total_expenses = totals.total;
  return {
    ...report,
    total_expenses,
    balance: Number((report.cash_advance_amount - total_expenses).toFixed(2)),
  };
}

router.get("/", requireAuth, (req, res) => {
  let sql = `SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name
             FROM expense_reports r JOIN employees e ON e.id = r.employee_id WHERE 1=1`;
  const params = [];

  if (req.user.role === "employee") {
    sql += " AND r.employee_id = ?";
    params.push(req.user.employee_id);
  } else if (req.query.employee_id) {
    sql += " AND r.employee_id = ?";
    params.push(req.query.employee_id);
  }

  if (req.query.status) {
    sql += " AND r.status = ?";
    params.push(req.query.status);
  }

  sql += " ORDER BY r.created_at DESC";
  const reports = db.prepare(sql).all(...params);
  res.json(reports.map(withTotals));
});

router.get(
  "/:id",
  requireAuth,
  (req, res, next) => {
    const report = db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    req.expenseReport = report;
    next();
  },
  requireSelfOrRole((req) => req.expenseReport.employee_id, "admin", "hr"),
  (req, res) => {
    const employee = db
      .prepare("SELECT first_name, last_name, email FROM employees WHERE id = ?")
      .get(req.expenseReport.employee_id);
    const items = db
      .prepare("SELECT * FROM expense_items WHERE report_id = ? ORDER BY expense_date, id")
      .all(req.params.id);
    res.json({ ...withTotals(req.expenseReport), employee, items });
  }
);

router.post("/", requireAuth, (req, res) => {
  const body = req.body || {};
  const employee_id = req.user.role === "employee" ? req.user.employee_id : body.employee_id || req.user.employee_id;
  const { title, cash_advance_amount, cost_center, notes } = body;
  if (!employee_id || !title) return res.status(400).json({ error: "title is required" });
  const info = db
    .prepare(
      `INSERT INTO expense_reports (employee_id, title, cash_advance_amount, cost_center, notes, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`
    )
    .run(employee_id, title, cash_advance_amount || 0, cost_center || null, notes || null);
  res.status(201).json(withTotals(db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(info.lastInsertRowid)));
});

function loadEditableReport(req, res, next) {
  const report = db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
  if (!report) return res.status(404).json({ error: "Expense report not found" });
  const isOwner = req.user.employee_id === report.employee_id;
  const isHr = ["admin", "hr"].includes(req.user.role);
  if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
  if (report.status !== "draft" && !isHr) {
    return res.status(400).json({ error: "Only draft reports can be edited" });
  }
  req.expenseReport = report;
  next();
}

router.put("/:id", requireAuth, loadEditableReport, (req, res) => {
  const { title, cash_advance_amount, cost_center, notes } = req.body || {};
  const report = req.expenseReport;
  db.prepare("UPDATE expense_reports SET title = ?, cash_advance_amount = ?, cost_center = ?, notes = ? WHERE id = ?").run(
    title ?? report.title,
    cash_advance_amount ?? report.cash_advance_amount,
    cost_center !== undefined ? cost_center : report.cost_center,
    notes !== undefined ? notes : report.notes,
    report.id
  );
  res.json(withTotals(db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(report.id)));
});

router.delete("/:id", requireAuth, loadEditableReport, (req, res) => {
  db.prepare("DELETE FROM expense_reports WHERE id = ?").run(req.expenseReport.id);
  res.status(204).end();
});

router.post("/:id/items", requireAuth, loadEditableReport, (req, res) => {
  const { expense_date, category, description, amount, receipt_ref } = req.body || {};
  if (!expense_date || amount === undefined) {
    return res.status(400).json({ error: "expense_date and amount are required" });
  }
  const info = db
    .prepare(
      `INSERT INTO expense_items (report_id, expense_date, category, description, amount, receipt_ref)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.expenseReport.id, expense_date, category || null, description || null, amount, receipt_ref || null);
  res.status(201).json(db.prepare("SELECT * FROM expense_items WHERE id = ?").get(info.lastInsertRowid));
});

router.delete("/items/:itemId", requireAuth, (req, res) => {
  const item = db.prepare("SELECT * FROM expense_items WHERE id = ?").get(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Expense item not found" });
  const report = db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(item.report_id);
  const isOwner = req.user.employee_id === report.employee_id;
  const isHr = ["admin", "hr"].includes(req.user.role);
  if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
  if (report.status !== "draft" && !isHr) {
    return res.status(400).json({ error: "Only draft reports can be edited" });
  }
  db.prepare("DELETE FROM expense_items WHERE id = ?").run(req.params.itemId);
  res.status(204).end();
});

router.put("/:id/submit", requireAuth, (req, res) => {
  const report = db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
  if (!report) return res.status(404).json({ error: "Expense report not found" });
  const isOwner = req.user.employee_id === report.employee_id;
  const isHr = ["admin", "hr"].includes(req.user.role);
  if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
  if (report.status !== "draft") return res.status(400).json({ error: "Only draft reports can be submitted" });

  const itemCount = db.prepare("SELECT COUNT(*) AS c FROM expense_items WHERE report_id = ?").get(report.id).c;
  if (itemCount === 0) return res.status(400).json({ error: "Add at least one expense item before submitting" });

  db.prepare("UPDATE expense_reports SET status = 'submitted', submitted_at = datetime('now') WHERE id = ?").run(report.id);
  notifyExpenseSubmitted({ employee_id: report.employee_id, title: report.title });
  res.json(withTotals(db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(report.id)));
});

router.put("/:id/status", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status, review_note } = req.body || {};
  if (!["approved", "rejected", "reimbursed"].includes(status)) {
    return res.status(400).json({ error: "status must be approved, rejected or reimbursed" });
  }
  const report = db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
  if (!report) return res.status(404).json({ error: "Expense report not found" });
  if (status === "reimbursed" && report.status !== "approved") {
    return res.status(400).json({ error: "Only approved reports can be marked reimbursed" });
  }
  if ((status === "approved" || status === "rejected") && report.status !== "submitted") {
    return res.status(400).json({ error: "Only submitted reports can be approved or rejected" });
  }
  db.prepare("UPDATE expense_reports SET status = ?, reviewed_by = ?, review_note = ? WHERE id = ?").run(
    status,
    req.user.employee_id || null,
    review_note || null,
    req.params.id
  );
  notifyExpenseStatusChanged({ employee_id: report.employee_id, title: report.title, status });
  res.json(withTotals(db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id)));
});

module.exports = router;
