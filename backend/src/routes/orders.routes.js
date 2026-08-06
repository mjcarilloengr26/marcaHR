const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status, owner_id } = req.query;
  let sql = `SELECT o.*, (e.first_name || ' ' || e.last_name) AS owner_name
             FROM orders o LEFT JOIN employees e ON e.id = o.owner_id WHERE 1=1`;
  const params = [];
  if (status) {
    sql += " AND o.status = ?";
    params.push(status);
  }
  if (owner_id) {
    sql += " AND o.owner_id = ?";
    params.push(owner_id);
  }
  sql += " ORDER BY o.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { order_number, customer_name, amount, status, owner_id, order_date, notes } = req.body || {};
  if (!order_number || !customer_name) return res.status(400).json({ error: "order_number and customer_name are required" });
  try {
    const info = db
      .prepare(
        `INSERT INTO orders (order_number, customer_name, amount, status, owner_id, order_date, notes)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, date('now')), ?)`
      )
      .run(order_number, customer_name, amount || 0, status || "placed", owner_id || null, order_date || null, notes || null);
    res.status(201).json(db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "An order with that order number already exists" });
  }
});

router.put("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Order not found" });
  const { order_number, customer_name, amount, status, owner_id, order_date, notes } = req.body || {};
  if (status && !["placed", "processing", "shipped", "delivered", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    db.prepare(
      `UPDATE orders SET order_number = ?, customer_name = ?, amount = ?, status = ?, owner_id = ?, order_date = ?, notes = ?
       WHERE id = ?`
    ).run(
      order_number ?? existing.order_number,
      customer_name ?? existing.customer_name,
      amount !== undefined ? amount : existing.amount,
      status || existing.status,
      owner_id !== undefined ? owner_id || null : existing.owner_id,
      order_date ?? existing.order_date,
      notes !== undefined ? notes : existing.notes,
      req.params.id
    );
  } catch (err) {
    return res.status(400).json({ error: "An order with that order number already exists" });
  }
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Order not found" });
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
