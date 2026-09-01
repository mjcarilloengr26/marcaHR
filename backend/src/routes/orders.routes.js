const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// Single-row read that carries the same joined names as the list, so a create
// or an update hands back exactly what the table will show.
const ONE = `
  SELECT o.*, (e.first_name || ' ' || e.last_name) AS owner_name, d.title AS deal_title,
         (c.first_name || ' ' || c.last_name) AS created_by_name,
         (s.first_name || ' ' || s.last_name) AS status_changed_by_name
  FROM orders o
  LEFT JOIN employees e ON e.id = o.owner_id
  LEFT JOIN deals d ON d.id = o.deal_id
  LEFT JOIN employees c ON c.id = o.created_by
  LEFT JOIN employees s ON s.id = o.status_changed_by
  WHERE o.id = ?`;

const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

router.get(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status, owner_id } = req.query;
    let sql = `SELECT o.*, (e.first_name || ' ' || e.last_name) AS owner_name, d.title AS deal_title,
             (c.first_name || ' ' || c.last_name) AS created_by_name,
             (s.first_name || ' ' || s.last_name) AS status_changed_by_name
             FROM orders o
             LEFT JOIN employees e ON e.id = o.owner_id
             LEFT JOIN deals d ON d.id = o.deal_id
             LEFT JOIN employees c ON c.id = o.created_by
             LEFT JOIN employees s ON s.id = o.status_changed_by
             WHERE 1=1`;
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
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { order_number, customer_name, amount, status, owner_id, order_date, notes } = req.body || {};
    if (!order_number || !customer_name) return res.status(400).json({ error: "order_number and customer_name are required" });
    try {
      const info = await db
        .prepare(
          `INSERT INTO orders (order_number, customer_name, amount, status, owner_id, order_date, notes,
                              created_by, status_changed_by, status_changed_at)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')), ?, ?, ?, ?)`
        )
        .run(
          order_number,
          customer_name,
          amount || 0,
          status || "placed",
          owner_id || null,
          order_date || null,
          notes || null,
          req.user.employee_id || null,
          req.user.employee_id || null,
          nowStamp()
        );
      res.status(201).json(await db.prepare(ONE).get(info.lastInsertRowid));
    } catch (err) {
      res.status(400).json({ error: "An order with that order number already exists" });
    }
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Order not found" });
    const { order_number, customer_name, amount, status, owner_id, order_date, notes } = req.body || {};
    if (status && !["placed", "processing", "shipped", "delivered", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const nextStatus = status || existing.status;
    const statusMoved = nextStatus !== existing.status;

    try {
      await db
        .prepare(
          `UPDATE orders SET order_number = ?, customer_name = ?, amount = ?, status = ?, owner_id = ?, order_date = ?, notes = ?,
            status_changed_by = ?, status_changed_at = ?
       WHERE id = ?`
        )
        .run(
          order_number ?? existing.order_number,
          customer_name ?? existing.customer_name,
          amount !== undefined ? amount : existing.amount,
          nextStatus,
          owner_id !== undefined ? owner_id || null : existing.owner_id,
          order_date ?? existing.order_date,
          notes !== undefined ? notes : existing.notes,
          // Only a status move re-stamps this. Correcting a customer's spelling
          // must not make it look like someone re-approved the order.
          statusMoved ? req.user.employee_id || null : existing.status_changed_by,
          statusMoved ? nowStamp() : existing.status_changed_at,
          req.params.id
        );
    } catch (err) {
      return res.status(400).json({ error: "An order with that order number already exists" });
    }
    res.json(await db.prepare(ONE).get(req.params.id));
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Order not found" });
    await db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
