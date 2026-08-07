const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const { notifyLeaveSubmitted, notifyLeaveStatusChanged } = require("../notifications");

const router = express.Router();

function daysBetween(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

// Accepts a base64 data URL (image or PDF, compressed/as-is client-side) or
// null. Caps the stored size defensively even though express.json()'s limit
// already bounds the whole request.
function parseAttachment(body) {
  const data = body?.attachment_data;
  if (!data) return { name: null, type: null, data: null };
  if (typeof data !== "string" || !data.startsWith("data:") || data.length > 6_000_000) {
    return { name: null, type: null, data: null };
  }
  return {
    name: typeof body.attachment_name === "string" ? body.attachment_name.slice(0, 255) : null,
    type: typeof body.attachment_type === "string" ? body.attachment_type.slice(0, 100) : null,
    data,
  };
}

// --- Leave types ---
router.get("/types", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM leave_types ORDER BY name").all());
});

router.post("/types", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { name, default_days_per_year } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name is required" });
  const info = db
    .prepare("INSERT INTO leave_types (name, default_days_per_year) VALUES (?, ?)")
    .run(name, default_days_per_year || 0);
  res.status(201).json(db.prepare("SELECT * FROM leave_types WHERE id = ?").get(info.lastInsertRowid));
});

// --- Balances ---
router.get(
  "/balances/:employeeId",
  requireAuth,
  requireSelfOrRole((req) => req.params.employeeId, "admin", "hr"),
  (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const balances = db
      .prepare(
        `SELECT b.*, lt.name AS leave_type_name
         FROM leave_balances b JOIN leave_types lt ON lt.id = b.leave_type_id
         WHERE b.employee_id = ? AND b.year = ?`
      )
      .all(req.params.employeeId, year);
    res.json(balances);
  }
);

router.post("/balances", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { employee_id, leave_type_id, year, allocated_days } = req.body || {};
  if (!employee_id || !leave_type_id || !year) {
    return res.status(400).json({ error: "employee_id, leave_type_id and year are required" });
  }
  db.prepare(
    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(employee_id, leave_type_id, year)
     DO UPDATE SET allocated_days = excluded.allocated_days`
  ).run(employee_id, leave_type_id, year, allocated_days || 0);
  res.status(201).json(
    db
      .prepare("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?")
      .get(employee_id, leave_type_id, year)
  );
});

// --- Requests ---
router.get("/requests", requireAuth, (req, res) => {
  let sql = `SELECT lr.*, lt.name AS leave_type_name,
             (e.first_name || ' ' || e.last_name) AS employee_name
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             JOIN employees e ON e.id = lr.employee_id
             WHERE 1=1`;
  const params = [];

  if (req.user.role === "employee") {
    sql += " AND lr.employee_id = ?";
    params.push(req.user.employee_id);
  } else if (req.query.employee_id) {
    sql += " AND lr.employee_id = ?";
    params.push(req.query.employee_id);
  }

  if (req.query.status) {
    sql += " AND lr.status = ?";
    params.push(req.query.status);
  }

  sql += " ORDER BY lr.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/requests", requireAuth, (req, res) => {
  const body = req.body || {};
  const employee_id = req.user.role === "employee" ? req.user.employee_id : body.employee_id;
  const { leave_type_id, start_date, end_date, reason } = body;

  if (!employee_id || !leave_type_id || !start_date || !end_date) {
    return res.status(400).json({ error: "employee_id, leave_type_id, start_date and end_date are required" });
  }
  const days = daysBetween(start_date, end_date);
  if (days <= 0) return res.status(400).json({ error: "end_date must be on or after start_date" });

  const attachment = parseAttachment(body);
  const info = db
    .prepare(
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status, attachment_name, attachment_type, attachment_data)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(employee_id, leave_type_id, start_date, end_date, days, reason || null, attachment.name, attachment.type, attachment.data);

  const created = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(info.lastInsertRowid);
  const leaveType = db.prepare("SELECT name FROM leave_types WHERE id = ?").get(leave_type_id);
  notifyLeaveSubmitted({
    employee_id,
    leave_type_name: leaveType?.name || "leave",
    start_date,
    end_date,
    days,
  });

  res.status(201).json(created);
});

router.put("/requests/:id/status", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status, review_note } = req.body || {};
  if (!["approved", "rejected", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "status must be approved, rejected or cancelled" });
  }
  const request = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Leave request not found" });

  const reviewerId = req.user.employee_id || null;
  db.prepare("UPDATE leave_requests SET status = ?, reviewed_by = ?, review_note = ? WHERE id = ?").run(
    status,
    reviewerId,
    review_note || null,
    req.params.id
  );

  if (status === "approved") {
    const year = new Date(request.start_date).getFullYear();
    db.prepare(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(employee_id, leave_type_id, year)
       DO UPDATE SET used_days = used_days + excluded.used_days`
    ).run(request.employee_id, request.leave_type_id, year, request.days);
  }

  if (status === "approved" || status === "rejected") {
    const leaveType = db.prepare("SELECT name FROM leave_types WHERE id = ?").get(request.leave_type_id);
    notifyLeaveStatusChanged({
      employee_id: request.employee_id,
      leave_type_name: leaveType?.name || "leave",
      start_date: request.start_date,
      end_date: request.end_date,
      status,
    });
  }

  res.json(db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id));
});

// After a rejection (often for something fixable, like a missing supporting
// document — see review_note), the employee can fix it up and send the same
// request back to "pending" instead of having to start a brand new one.
router.put("/requests/:id/resubmit", requireAuth, (req, res) => {
  const request = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Leave request not found" });
  if (req.user.employee_id !== request.employee_id) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  if (request.status !== "rejected") {
    return res.status(400).json({ error: "Only rejected requests can be resubmitted" });
  }

  const body = req.body || {};
  const start_date = body.start_date || request.start_date;
  const end_date = body.end_date || request.end_date;
  const days = daysBetween(start_date, end_date);
  if (days <= 0) return res.status(400).json({ error: "end_date must be on or after start_date" });

  const attachment = body.attachment_data !== undefined ? parseAttachment(body) : null;

  db.prepare(
    `UPDATE leave_requests SET leave_type_id = ?, start_date = ?, end_date = ?, days = ?, reason = ?,
     status = 'pending', reviewed_by = NULL, review_note = NULL,
     attachment_name = COALESCE(?, attachment_name), attachment_type = COALESCE(?, attachment_type), attachment_data = COALESCE(?, attachment_data)
     WHERE id = ?`
  ).run(
    body.leave_type_id || request.leave_type_id,
    start_date,
    end_date,
    days,
    body.reason !== undefined ? body.reason : request.reason,
    attachment?.name || null,
    attachment?.type || null,
    attachment?.data || null,
    req.params.id
  );

  const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
  const leaveType = db.prepare("SELECT name FROM leave_types WHERE id = ?").get(updated.leave_type_id);
  notifyLeaveSubmitted({
    employee_id: updated.employee_id,
    leave_type_name: leaveType?.name || "leave",
    start_date: updated.start_date,
    end_date: updated.end_date,
    days: updated.days,
  });

  res.json(updated);
});

router.delete("/requests/:id", requireAuth, (req, res) => {
  const request = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Leave request not found" });
  const isOwner = req.user.employee_id === request.employee_id;
  const isHr = ["admin", "hr"].includes(req.user.role);
  if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
  if (request.status !== "pending" && !isHr) {
    return res.status(400).json({ error: "Only pending requests can be cancelled" });
  }
  db.prepare("DELETE FROM leave_requests WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
