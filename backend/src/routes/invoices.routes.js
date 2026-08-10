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

// The remaining unbilled balance on an order: its total amount minus every
// non-cancelled invoice already linked to it. excludeInvoiceId lets an edit
// compare against the order's other invoices without double-counting the
// invoice being edited. Returns null if the order doesn't exist.
async function remainingForOrder(orderId, excludeInvoiceId) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;
  const alreadyBilled = (
    await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM invoices WHERE order_id = ? AND status != 'cancelled' AND id != ?")
      .get(orderId, excludeInvoiceId || 0)
  ).v;
  return { order, remaining: Math.max(order.amount - alreadyBilled, 0) };
}

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
  if (order_id) {
    const info = await remainingForOrder(order_id, 0);
    if (!info) return res.status(400).json({ error: "Related order not found" });
    if ((amount || 0) > info.remaining) {
      return res
        .status(400)
        .json({ error: `Amount exceeds the order's remaining unbilled balance of ₱${info.remaining.toLocaleString()}` });
    }
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

// Pre-fill a draft invoice from an order's remaining unbilled amount, so billing
// an order is one click. An order can carry more than one invoice (order_id is
// not unique on the invoices table) — e.g. a partial invoice now, a second one
// later for the remainder — so this pre-fills the *remaining* balance rather
// than always the order's full amount, which would silently over-bill an order
// that already has a partial invoice against it.
router.post("/from-order/:orderId", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const info = await remainingForOrder(req.params.orderId, 0);
  if (!info) return res.status(404).json({ error: "Order not found" });
  const { order, remaining } = info;
  if (remaining === 0) return res.status(400).json({ error: "This order is already fully billed" });

  // The default invoice number is derived from the order number, so a second
  // invoice on the same order needs a distinguishing suffix to avoid colliding
  // with the first (invoice_number is the column that's actually unique).
  const invoiceCount = (await db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE order_id = ?").get(order.id)).c;
  const invoiceNumber = invoiceCount === 0 ? `INV-${order.order_number}` : `INV-${order.order_number}-${invoiceCount + 1}`;

  try {
    const insertResult = await db
      .prepare(
        `INSERT INTO invoices (invoice_number, order_id, customer_name, amount, status, issue_date)
         VALUES (?, ?, ?, ?, 'draft', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`
      )
      .run(invoiceNumber, order.id, order.customer_name, remaining);
    res.status(201).json(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(insertResult.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "An invoice with that number already exists" });
  }
}));

router.put("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  const { invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes } = req.body || {};
  if (status && !["draft", "sent", "paid", "overdue", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  // Only re-check the cap when the amount or the linked order is actually being
  // changed — a plain status flip (e.g. the quick draft/sent/paid dropdown)
  // shouldn't start failing on a value nobody is touching.
  if (order_id !== undefined || amount !== undefined) {
    const effectiveOrderId = order_id !== undefined ? order_id || null : existing.order_id;
    const effectiveAmount = amount !== undefined ? amount : existing.amount;
    const effectiveStatus = status || existing.status;
    if (effectiveOrderId && effectiveStatus !== "cancelled") {
      const info = await remainingForOrder(effectiveOrderId, existing.id);
      if (info && effectiveAmount > info.remaining) {
        return res
          .status(400)
          .json({ error: `Amount exceeds the order's remaining unbilled balance of ₱${info.remaining.toLocaleString()}` });
      }
    }
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
