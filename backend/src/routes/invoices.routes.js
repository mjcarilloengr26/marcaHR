const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

const SELECT_BASE = `
  SELECT i.*, o.order_number
  FROM invoices i
  LEFT JOIN orders o ON o.id = i.order_id
`;

router.get("/", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  let sql = `${SELECT_BASE} WHERE 1=1`;
  const params = [];
  if (req.query.status) {
    sql += " AND i.status = ?";
    params.push(req.query.status);
  }
  if (req.query.order_id) {
    sql += " AND i.order_id = ?";
    params.push(req.query.order_id);
  }
  sql += " ORDER BY i.created_at DESC";
  res.json(await db.prepare(sql).all(...params));
}));

router.post("/", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const { invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes } = req.body || {};
  if (!invoice_number || !customer_name) {
    return res.status(400).json({ error: "invoice_number and customer_name are required" });
  }
  try {
    const info = await db
      .prepare(
        `INSERT INTO invoices (invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')), ?, ?)`
      )
      .run(invoice_number, order_id || null, customer_name, amount || 0, status || "draft", issue_date || null, due_date || null, notes || null);
    res.status(201).json(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "An invoice with that number already exists" });
  }
}));

// Pre-fill a draft invoice from an order's amount/customer, so billing an order is one click.
router.post("/from-order/:orderId", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const invoiceNumber = `INV-${order.order_number}`;
  try {
    const info = await db
      .prepare(
        `INSERT INTO invoices (invoice_number, order_id, customer_name, amount, status, issue_date)
         VALUES (?, ?, ?, ?, 'draft', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`
      )
      .run(invoiceNumber, order.id, order.customer_name, order.amount);
    res.status(201).json(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "An invoice for that order already exists" });
  }
}));

router.put("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  const { invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes } = req.body || {};
  if (status && !["draft", "sent", "paid", "overdue", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const paid_date = status === "paid" && existing.status !== "paid" ? new Date().toISOString().slice(0, 10) : existing.paid_date;
  try {
    await db.prepare(
      `UPDATE invoices SET invoice_number = ?, order_id = ?, customer_name = ?, amount = ?, status = ?,
       issue_date = ?, due_date = ?, notes = ?, paid_date = ? WHERE id = ?`
    ).run(
      invoice_number ?? existing.invoice_number,
      order_id !== undefined ? order_id || null : existing.order_id,
      customer_name ?? existing.customer_name,
      amount !== undefined ? amount : existing.amount,
      status || existing.status,
      issue_date ?? existing.issue_date,
      due_date !== undefined ? due_date : existing.due_date,
      notes !== undefined ? notes : existing.notes,
      paid_date,
      req.params.id
    );
  } catch (err) {
    return res.status(400).json({ error: "An invoice with that number already exists" });
  }
  res.json(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id));
}));

router.delete("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  await db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.status(204).end();
}));

module.exports = router;
