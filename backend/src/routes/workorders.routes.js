const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notifyWorkOrderAssigned } = require("../notifications");

const router = express.Router();

const SELECT_BASE = `
  SELECT w.*,
    (asg.first_name || ' ' || asg.last_name) AS assigned_to_name,
    o.order_number
  FROM work_orders w
  LEFT JOIN employees asg ON asg.id = w.assigned_to
  LEFT JOIN orders o ON o.id = w.order_id
`;

router.get("/", requireAuth, (req, res) => {
  let sql = `${SELECT_BASE} WHERE 1=1`;
  const params = [];

  if (req.user.role === "employee") {
    sql += " AND w.assigned_to = ?";
    params.push(req.user.employee_id);
  } else {
    if (req.query.status) {
      sql += " AND w.status = ?";
      params.push(req.query.status);
    }
    if (req.query.assigned_to) {
      sql += " AND w.assigned_to = ?";
      params.push(req.query.assigned_to);
    }
  }

  sql += " ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, w.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { work_order_number, title, customer_name, description, address, order_id, assigned_to, priority, scheduled_date, notes } =
    req.body || {};
  if (!work_order_number || !title || !customer_name) {
    return res.status(400).json({ error: "work_order_number, title and customer_name are required" });
  }
  const status = assigned_to ? "assigned" : "open";
  try {
    const info = db
      .prepare(
        `INSERT INTO work_orders (work_order_number, title, customer_name, description, address, order_id, assigned_to, priority, status, scheduled_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        work_order_number,
        title,
        customer_name,
        description || null,
        address || null,
        order_id || null,
        assigned_to || null,
        priority || "medium",
        status,
        scheduled_date || null,
        notes || null
      );
    if (assigned_to) notifyWorkOrderAssigned({ employee_id: assigned_to, title });
    res.status(201).json(db.prepare(`${SELECT_BASE} WHERE w.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "A work order with that number already exists" });
  }
});

router.put("/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Work order not found" });

  const isHr = ["admin", "hr"].includes(req.user.role);
  const isAssignee = req.user.employee_id === existing.assigned_to;
  if (!isHr && !isAssignee) return res.status(403).json({ error: "Insufficient permissions" });

  const body = req.body || {};
  if (body.status && !["open", "assigned", "in_progress", "completed", "cancelled"].includes(body.status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  if (!isHr && Object.keys(body).some((k) => k !== "status" && k !== "notes")) {
    return res.status(403).json({ error: "Only HR/admin can edit work order details" });
  }

  const title = isHr ? body.title ?? existing.title : existing.title;
  const customer_name = isHr ? body.customer_name ?? existing.customer_name : existing.customer_name;
  const description = isHr ? (body.description !== undefined ? body.description : existing.description) : existing.description;
  const address = isHr ? (body.address !== undefined ? body.address : existing.address) : existing.address;
  const order_id = isHr ? (body.order_id !== undefined ? body.order_id || null : existing.order_id) : existing.order_id;
  const assigned_to = isHr ? (body.assigned_to !== undefined ? body.assigned_to || null : existing.assigned_to) : existing.assigned_to;
  const priority = isHr ? body.priority || existing.priority : existing.priority;
  const scheduled_date = isHr ? (body.scheduled_date !== undefined ? body.scheduled_date : existing.scheduled_date) : existing.scheduled_date;
  const notes = body.notes !== undefined ? body.notes : existing.notes;
  const status = body.status || existing.status;
  const completed_at = status === "completed" && existing.status !== "completed" ? new Date().toISOString() : existing.completed_at;

  db.prepare(
    `UPDATE work_orders SET title = ?, customer_name = ?, description = ?, address = ?, order_id = ?, assigned_to = ?,
     priority = ?, status = ?, scheduled_date = ?, notes = ?, completed_at = ? WHERE id = ?`
  ).run(title, customer_name, description, address, order_id, assigned_to, priority, status, scheduled_date, notes, completed_at, req.params.id);

  if (assigned_to && assigned_to !== existing.assigned_to) {
    notifyWorkOrderAssigned({ employee_id: assigned_to, title });
  }

  res.json(db.prepare(`${SELECT_BASE} WHERE w.id = ?`).get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Work order not found" });
  db.prepare("DELETE FROM work_orders WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
