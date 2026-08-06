const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  let sql = `SELECT a.*, (e.first_name || ' ' || e.last_name) AS employee_name
             FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE 1=1`;
  const params = [];

  if (req.user.role === "employee") {
    sql += " AND a.employee_id = ?";
    params.push(req.user.employee_id);
  } else if (req.query.employee_id) {
    sql += " AND a.employee_id = ?";
    params.push(req.query.employee_id);
  }

  if (req.query.date) {
    sql += " AND a.date = ?";
    params.push(req.query.date);
  } else if (req.query.from && req.query.to) {
    sql += " AND a.date BETWEEN ? AND ?";
    params.push(req.query.from, req.query.to);
  }

  sql += " ORDER BY a.date DESC";
  res.json(db.prepare(sql).all(...params));
});

// Employee self clock-in/out for today
router.post("/clock-in", requireAuth, (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(11, 19);
  db.prepare(
    `INSERT INTO attendance (employee_id, date, status, clock_in)
     VALUES (?, ?, 'present', ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET clock_in = excluded.clock_in, status = 'present'`
  ).run(req.user.employee_id, today, now);
  res.json(db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today));
});

router.post("/clock-out", requireAuth, (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(11, 19);
  const record = db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today);
  if (!record) return res.status(400).json({ error: "You have not clocked in today" });
  db.prepare("UPDATE attendance SET clock_out = ? WHERE id = ?").run(now, record.id);
  res.json(db.prepare("SELECT * FROM attendance WHERE id = ?").get(record.id));
});

// HR/admin manually record or edit attendance for anyone
router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { employee_id, date, status, clock_in, clock_out, note } = req.body || {};
  if (!employee_id || !date) return res.status(400).json({ error: "employee_id and date are required" });
  db.prepare(
    `INSERT INTO attendance (employee_id, date, status, clock_in, clock_out, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET
       status = excluded.status, clock_in = excluded.clock_in,
       clock_out = excluded.clock_out, note = excluded.note`
  ).run(employee_id, date, status || "present", clock_in || null, clock_out || null, note || null);
  res.status(201).json(db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(employee_id, date));
});

router.get(
  "/summary/:employeeId",
  requireAuth,
  requireSelfOrRole((req) => req.params.employeeId, "admin", "hr"),
  (req, res) => {
  const { from, to } = req.query;
  const params = [req.params.employeeId];
  let sql = `SELECT status, COUNT(*) AS count FROM attendance WHERE employee_id = ?`;
  if (from && to) {
    sql += " AND date BETWEEN ? AND ?";
    params.push(from, to);
  }
  sql += " GROUP BY status";
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
