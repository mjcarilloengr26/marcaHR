const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getExpenseSummary } = require("../services/expenseSummary");

const router = express.Router();

router.get(
  "/stats",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === "employee") {
      const employeeId = req.user.employee_id;
      const pendingLeave = (
        await db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE employee_id = ? AND status = 'pending'").get(employeeId)
      ).c;
      const today = new Date().toISOString().slice(0, 10);
      const todayAttendance = await db
        .prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?")
        .get(employeeId, today);
      const latestReview = await db
        .prepare(
          `SELECT r.*, rc.name AS cycle_name FROM performance_reviews r
         JOIN review_cycles rc ON rc.id = r.cycle_id
         WHERE r.employee_id = ? AND r.status != 'draft' ORDER BY r.created_at DESC LIMIT 1`
        )
        .get(employeeId);
      return res.json({ role: "employee", pendingLeave, todayAttendance: todayAttendance || null, latestReview: latestReview || null });
    }

    const totalEmployees = (await db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'active'").get()).c;
    const totalDepartments = (await db.prepare("SELECT COUNT(*) AS c FROM departments").get()).c;
    const pendingLeaveRequests = (await db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE status = 'pending'").get()).c;
    const today = new Date().toISOString().slice(0, 10);
    const presentToday = (await db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE date = ? AND status = 'present'").get(today)).c;
    const byDepartment = await db
      .prepare(
        `SELECT d.name, COUNT(e.id) AS count FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id AND e.status = 'active'
       GROUP BY d.id ORDER BY d.name`
      )
      .all();

    // Expense/liquidation report funnel: each stage counts reports that reached that
    // stage or further (status is a checkpoint each report passes through in order,
    // except "rejected", which branches off after submission rather than continuing).
    const expenseCounts = (await db.prepare("SELECT status, COUNT(*) AS c FROM expense_reports GROUP BY status").all()).reduce(
      (acc, row) => ({ ...acc, [row.status]: row.c }),
      {}
    );
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

    const expenseSummary = await getExpenseSummary();

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
  })
);

module.exports = router;
