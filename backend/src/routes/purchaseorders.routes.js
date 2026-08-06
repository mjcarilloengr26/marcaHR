const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const SELECT_BASE = `
  SELECT p.*, (e.first_name || ' ' || e.last_name) AS requested_by_name
  FROM purchase_orders p
  LEFT JOIN employees e ON e.id = p.requested_by
`;

router.get("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  let sql = `${SELECT_BASE} WHERE 1=1`;
  const params = [];
  if (req.query.status) {
    sql += " AND p.status = ?";
    params.push(req.query.status);
  }
  sql += " ORDER BY p.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { po_number, vendor_name, description, amount, requested_by, order_date, expected_delivery_date, notes } = req.body || {};
  if (!po_number || !vendor_name) {
    return res.status(400).json({ error: "po_number and vendor_name are required" });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (po_number, vendor_name, description, amount, status, requested_by, order_date, expected_delivery_date, notes)
         VALUES (?, ?, ?, ?, 'draft', ?, COALESCE(?, date('now')), ?, ?)`
      )
      .run(
        po_number,
        vendor_name,
        description || null,
        amount || 0,
        requested_by || req.user.employee_id || null,
        order_date || null,
        expected_delivery_date || null,
        notes || null
      );
    res.status(201).json(db.prepare(`${SELECT_BASE} WHERE p.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "A purchase order with that number already exists" });
  }
});

router.put("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Purchase order not found" });
  const { po_number, vendor_name, description, amount, order_date, expected_delivery_date, notes } = req.body || {};
  try {
    db.prepare(
      `UPDATE purchase_orders SET po_number = ?, vendor_name = ?, description = ?, amount = ?,
       order_date = ?, expected_delivery_date = ?, notes = ? WHERE id = ?`
    ).run(
      po_number ?? existing.po_number,
      vendor_name ?? existing.vendor_name,
      description !== undefined ? description : existing.description,
      amount !== undefined ? amount : existing.amount,
      order_date ?? existing.order_date,
      expected_delivery_date !== undefined ? expected_delivery_date : existing.expected_delivery_date,
      notes !== undefined ? notes : existing.notes,
      req.params.id
    );
  } catch (err) {
    return res.status(400).json({ error: "A purchase order with that number already exists" });
  }
  res.json(db.prepare(`${SELECT_BASE} WHERE p.id = ?`).get(req.params.id));
});

// Status workflow: draft -> submitted -> approved -> received, or cancelled at any point.
router.put("/:id/status", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status } = req.body || {};
  if (!["draft", "submitted", "approved", "received", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const existing = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Purchase order not found" });
  const received_date = status === "received" && existing.status !== "received" ? new Date().toISOString().slice(0, 10) : existing.received_date;
  db.prepare("UPDATE purchase_orders SET status = ?, received_date = ? WHERE id = ?").run(status, received_date, req.params.id);
  res.json(db.prepare(`${SELECT_BASE} WHERE p.id = ?`).get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Purchase order not found" });
  db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
