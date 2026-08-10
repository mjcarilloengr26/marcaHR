const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const { notifyLeaveSubmitted, notifyLeaveStatusChanged } = require("../notifications");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

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
router.get(
  "/types",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM leave_types ORDER BY name").all());
  })
);

router.post(
  "/types",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { name, default_days_per_year } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    const info = await db
      .prepare("INSERT INTO leave_types (name, default_days_per_year) VALUES (?, ?)")
      .run(name, default_days_per_year || 0);
    res.status(201).json(await db.prepare("SELECT * FROM leave_types WHERE id = ?").get(info.lastInsertRowid));
  })
);

// Editing default_days_per_year here only changes what NEW balance rows get
// allocated (via ensureLeaveBalancesForYear below) — it never retroactively
// changes an employee's already-allocated balance for a year, since HR may
// have deliberately customized that.
router.put(
  "/types/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM leave_types WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Leave type not found" });
    const { name, default_days_per_year } = req.body || {};
    await db.prepare("UPDATE leave_types SET name = ?, default_days_per_year = ? WHERE id = ?").run(
      name ?? existing.name,
      default_days_per_year !== undefined ? default_days_per_year : existing.default_days_per_year,
      req.params.id
    );
    await logRequestEvent(req, "update_leave_type", {
      entityType: "leave_type",
      entityId: Number(req.params.id),
      details: { name: name ?? existing.name, default_days_per_year: default_days_per_year ?? existing.default_days_per_year },
    });
    res.json(await db.prepare("SELECT * FROM leave_types WHERE id = ?").get(req.params.id));
  })
);

// --- Balances ---

// Lazily provisions this employee's balance row for every leave type for the
// given year, using each type's default_days_per_year — so "allowed leave
// per year per employee" exists automatically for both new and pre-existing
// employees without a bulk migration, and never overwrites a balance HR has
// already customized (ON CONFLICT DO NOTHING).
async function ensureLeaveBalancesForYear(employeeId, year) {
  const types = await db.prepare("SELECT id, default_days_per_year FROM leave_types").all();
  for (const t of types) {
    await db
      .prepare(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`
      )
      .run(employeeId, t.id, year, t.default_days_per_year);
  }
}

router.get(
  "/balances/:employeeId",
  requireAuth,
  requireSelfOrRole((req) => req.params.employeeId, "admin", "hr"),
  asyncHandler(async (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    await ensureLeaveBalancesForYear(req.params.employeeId, year);
    const balances = await db
      .prepare(
        `SELECT b.*, lt.name AS leave_type_name
         FROM leave_balances b JOIN leave_types lt ON lt.id = b.leave_type_id
         WHERE b.employee_id = ? AND b.year = ?
         ORDER BY lt.name`
      )
      .all(req.params.employeeId, year);
    res.json(balances);
  })
);

router.post(
  "/balances",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year, allocated_days } = req.body || {};
    if (!employee_id || !leave_type_id || !year) {
      return res.status(400).json({ error: "employee_id, leave_type_id and year are required" });
    }
    await db
      .prepare(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(employee_id, leave_type_id, year)
     DO UPDATE SET allocated_days = excluded.allocated_days`
      )
      .run(employee_id, leave_type_id, year, allocated_days || 0);
    res.status(201).json(
      await db
        .prepare("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?")
        .get(employee_id, leave_type_id, year)
    );
  })
);

// --- Requests ---
router.get(
  "/requests",
  requireAuth,
  asyncHandler(async (req, res) => {
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
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/requests",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const employee_id = req.user.role === "employee" ? req.user.employee_id : body.employee_id;
    const { leave_type_id, start_date, end_date, reason } = body;

    if (!employee_id || !leave_type_id || !start_date || !end_date) {
      return res.status(400).json({ error: "employee_id, leave_type_id, start_date and end_date are required" });
    }
    const days = daysBetween(start_date, end_date);
    if (days <= 0) return res.status(400).json({ error: "end_date must be on or after start_date" });

    const attachment = parseAttachment(body);
    const info = await db
      .prepare(
        `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status, attachment_name, attachment_type, attachment_data)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(employee_id, leave_type_id, start_date, end_date, days, reason || null, attachment.name, attachment.type, attachment.data);

    const created = await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(info.lastInsertRowid);
    const leaveType = await db.prepare("SELECT name FROM leave_types WHERE id = ?").get(leave_type_id);
    notifyLeaveSubmitted({
      employee_id,
      leave_type_name: leaveType?.name || "leave",
      start_date,
      end_date,
      days,
    });

    res.status(201).json(created);
  })
);

router.put(
  "/requests/:id/status",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status, review_note } = req.body || {};
    if (!["approved", "rejected", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "status must be approved, rejected or cancelled" });
    }
    const request = await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
    if (!request) return res.status(404).json({ error: "Leave request not found" });

    const reviewerId = req.user.employee_id || null;
    await db.prepare("UPDATE leave_requests SET status = ?, reviewed_by = ?, review_note = ? WHERE id = ?").run(
      status,
      reviewerId,
      review_note || null,
      req.params.id
    );

    // Deduct on approval; restore if a previously-approved request is later
    // rejected or cancelled — otherwise reversing an approval would leave the
    // employee's balance permanently short, since nothing else ever gives
    // those days back.
    if (status === "approved" && request.status !== "approved") {
      const year = new Date(request.start_date).getFullYear();
      await db
        .prepare(
          `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(employee_id, leave_type_id, year)
       DO UPDATE SET used_days = leave_balances.used_days + excluded.used_days`
        )
        .run(request.employee_id, request.leave_type_id, year, request.days);
    } else if (status !== "approved" && request.status === "approved") {
      const year = new Date(request.start_date).getFullYear();
      await db
        .prepare(
          `UPDATE leave_balances SET used_days = GREATEST(used_days - ?, 0)
           WHERE employee_id = ? AND leave_type_id = ? AND year = ?`
        )
        .run(request.days, request.employee_id, request.leave_type_id, year);
    }

    if (status === "approved" || status === "rejected") {
      const leaveType = await db.prepare("SELECT name FROM leave_types WHERE id = ?").get(request.leave_type_id);
      notifyLeaveStatusChanged({
        employee_id: request.employee_id,
        leave_type_name: leaveType?.name || "leave",
        start_date: request.start_date,
        end_date: request.end_date,
        status,
      });
    }

    res.json(await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id));
  })
);

// After a rejection (often for something fixable, like a missing supporting
// document — see review_note), the employee can fix it up and send the same
// request back to "pending" instead of having to start a brand new one.
router.put(
  "/requests/:id/resubmit",
  requireAuth,
  asyncHandler(async (req, res) => {
    const request = await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
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

    await db
      .prepare(
        `UPDATE leave_requests SET leave_type_id = ?, start_date = ?, end_date = ?, days = ?, reason = ?,
     status = 'pending', reviewed_by = NULL, review_note = NULL,
     attachment_name = COALESCE(?, attachment_name), attachment_type = COALESCE(?, attachment_type), attachment_data = COALESCE(?, attachment_data)
     WHERE id = ?`
      )
      .run(
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

    const updated = await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
    const leaveType = await db.prepare("SELECT name FROM leave_types WHERE id = ?").get(updated.leave_type_id);
    notifyLeaveSubmitted({
      employee_id: updated.employee_id,
      leave_type_name: leaveType?.name || "leave",
      start_date: updated.start_date,
      end_date: updated.end_date,
      days: updated.days,
    });

    res.json(updated);
  })
);

router.delete(
  "/requests/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const request = await db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(req.params.id);
    if (!request) return res.status(404).json({ error: "Leave request not found" });
    const isOwner = req.user.employee_id === request.employee_id;
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
    if (request.status !== "pending" && !isHr) {
      return res.status(400).json({ error: "Only pending requests can be cancelled" });
    }
    // HR can delete an already-approved request — give the days back so the
    // balance doesn't stay permanently short.
    if (request.status === "approved") {
      const year = new Date(request.start_date).getFullYear();
      await db
        .prepare(
          `UPDATE leave_balances SET used_days = GREATEST(used_days - ?, 0)
           WHERE employee_id = ? AND leave_type_id = ? AND year = ?`
        )
        .run(request.days, request.employee_id, request.leave_type_id, year);
    }
    await db.prepare("DELETE FROM leave_requests WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
