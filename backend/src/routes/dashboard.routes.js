const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/stats", requireAuth, (req, res) => {
  if (req.user.role === "employee") {
    const employeeId = req.user.employee_id;
    const pendingLeave = db
      .prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE employee_id = ? AND status = 'pending'")
      .get(employeeId).c;
    const today = new Date().toISOString().slice(0, 10);
    const todayAttendance = db
      .prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?")
      .get(employeeId, today);
    const latestReview = db
      .prepare(
        `SELECT r.*, rc.name AS cycle_name FROM performance_reviews r
         JOIN review_cycles rc ON rc.id = r.cycle_id
         WHERE r.employee_id = ? AND r.status != 'draft' ORDER BY r.created_at DESC LIMIT 1`
      )
      .get(employeeId);
    return res.json({ role: "employee", pendingLeave, todayAttendance: todayAttendance || null, latestReview: latestReview || null });
  }

  const totalEmployees = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'active'").get().c;
  const totalDepartments = db.prepare("SELECT COUNT(*) AS c FROM departments").get().c;
  const pendingLeaveRequests = db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE status = 'pending'").get().c;
  const today = new Date().toISOString().slice(0, 10);
  const presentToday = db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE date = ? AND status = 'present'").get(today).c;
  const byDepartment = db
    .prepare(
      `SELECT d.name, COUNT(e.id) AS count FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id AND e.status = 'active'
       GROUP BY d.id ORDER BY d.name`
    )
    .all();

  // Expense/liquidation report funnel: each stage counts reports that reached that
  // stage or further (status is a checkpoint each report passes through in order,
  // except "rejected", which branches off after submission rather than continuing).
  const expenseCounts = db
    .prepare("SELECT status, COUNT(*) AS c FROM expense_reports GROUP BY status")
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.c }), {});
  const created =
    (expenseCounts.draft || 0) +
    (expenseCounts.submitted || 0) +
    (expenseCounts.approved || 0) +
    (expenseCounts.reimbursed || 0) +
    (expenseCounts.rejected || 0);
  const submittedOrBeyond =
    (expenseCounts.submitted || 0) + (expenseCounts.approved || 0) + (expenseCounts.reimbursed || 0) + (expenseCounts.rejected || 0);
  const approvedOrBeyond = (expenseCounts.approved || 0) + (expenseCounts.reimbursed || 0);
  const reimbursed = expenseCounts.reimbursed || 0;
  const expenseFunnel = {
    stages: [
      { key: "created", label: "Created", count: created },
      { key: "submitted", label: "Submitted", count: submittedOrBeyond },
      { key: "approved", label: "Approved", count: approvedOrBeyond },
      { key: "reimbursed", label: "Reimbursed", count: reimbursed },
    ],
    rejected: expenseCounts.rejected || 0,
  };

  // Expense summary per employee — every liquidated/claimed expense item,
  // bucketed by its expense_date: current month, current quarter, current
  // year, and all-time total (monthly ⊆ quarterly ⊆ annually ⊆ total by
  // construction), same pattern as the Sales Lead Summary. expense_date is
  // already a plain calendar date (no time component), so no timezone shift
  // is needed here unlike created_at-based timestamps elsewhere.
  const nowParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" })
    .format(new Date())
    .split("-")
    .map(Number);
  const [currentYear, currentMonth] = nowParts;
  const currentQuarter = Math.floor((currentMonth - 1) / 3) + 1;

  const emptyBucket = () => ({ count: 0, value: 0 });
  const expenseSummaryByEmployee = {};
  const expenseItemRows = db
    .prepare(
      `SELECT r.employee_id, i.amount, i.expense_date FROM expense_items i
       JOIN expense_reports r ON r.id = i.report_id`
    )
    .all();
  for (const it of expenseItemRows) {
    const [y, m] = it.expense_date.split("-").map(Number);
    const q = Math.floor((m - 1) / 3) + 1;
    if (!expenseSummaryByEmployee[it.employee_id]) {
      expenseSummaryByEmployee[it.employee_id] = {
        monthly: emptyBucket(),
        quarterly: emptyBucket(),
        annually: emptyBucket(),
        total: emptyBucket(),
      };
    }
    const s = expenseSummaryByEmployee[it.employee_id];
    s.total.count += 1;
    s.total.value += it.amount;
    if (y === currentYear) {
      s.annually.count += 1;
      s.annually.value += it.amount;
      if (q === currentQuarter) {
        s.quarterly.count += 1;
        s.quarterly.value += it.amount;
        if (m === currentMonth) {
          s.monthly.count += 1;
          s.monthly.value += it.amount;
        }
      }
    }
  }
  const expenseSummary = Object.keys(expenseSummaryByEmployee)
    .map((id) => {
      const employee = db.prepare("SELECT first_name, last_name FROM employees WHERE id = ?").get(id);
      const s = expenseSummaryByEmployee[id];
      return {
        employee_id: Number(id),
        employee_name: employee ? `${employee.first_name} ${employee.last_name}` : "Unknown",
        monthly_count: s.monthly.count,
        monthly_total: s.monthly.value,
        quarterly_count: s.quarterly.count,
        quarterly_total: s.quarterly.value,
        annual_count: s.annually.count,
        annual_total: s.annually.value,
        total_count: s.total.count,
        total_total: s.total.value,
      };
    })
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  res.json({
    role: req.user.role,
    totalEmployees,
    totalDepartments,
    pendingLeaveRequests,
    presentToday,
    byDepartment,
    expenseFunnel,
    expenseSummary,
  });
});

module.exports = router;
