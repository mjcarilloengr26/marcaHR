const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { invoiceForPdf, renderInvoicePdf } = require("../services/invoicePdf");
const { sendReadiness, sendInvoiceEmail } = require("../services/invoiceSend");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const SELECT_BASE = `
  SELECT i.*, o.order_number, o.notes AS order_notes, pr.code AS project_code, pr.name AS project_name,
    (c.first_name || ' ' || c.last_name) AS created_by_name,
    (s.first_name || ' ' || s.last_name) AS status_changed_by_name,
    (ap.first_name || ' ' || ap.last_name) AS approved_by_name,
    (sb.first_name || ' ' || sb.last_name) AS sent_by_name,
    cu.email AS customer_email, cu.cc_emails AS customer_cc_emails
  FROM invoices i
  LEFT JOIN orders o ON o.id = i.order_id
  LEFT JOIN employees c ON c.id = i.created_by
  LEFT JOIN employees s ON s.id = i.status_changed_by
  LEFT JOIN employees ap ON ap.id = i.approved_by
  LEFT JOIN employees sb ON sb.id = i.sent_by
  LEFT JOIN customers cu ON cu.id = i.customer_id
  LEFT JOIN projects pr ON pr.id = i.project_id
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

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Orders are quoted VAT-inclusive, so the amount on an invoice is what the
// customer pays in total. VAT is not added on top — it is backed out of that
// figure for the document:
//
//   VATable sales = total / (1 + rate)
//   VAT           = total - VATable sales
//
// The VAT is taken as the remainder rather than computed separately, so the
// two halves always add back to the exact total. Rounding both independently
// is what produces invoices that are a centavo out.
function vatBreakdown(total, rate) {
  const gross = money(total);
  const pct = Number(rate);
  if (!Number.isFinite(pct) || pct <= 0) {
    return { vat_rate: pct || 0, vatable_sales: gross, vat_amount: 0, total_due: gross };
  }
  const vatable = money(gross / (1 + pct / 100));
  return { vat_rate: pct, vatable_sales: vatable, vat_amount: money(gross - vatable), total_due: gross };
}

// Attaches the breakdown to an invoice row so every caller shows the same
// numbers rather than each re-deriving them.
function withVat(invoice) {
  if (!invoice) return invoice;
  return { ...invoice, ...vatBreakdown(invoice.amount, invoice.vat_rate) };
}

const CURRENCIES = ["PHP", "USD"];

function validateCurrency(input) {
  if (input === undefined || input === null || input === "") return { currency: undefined };
  const code = String(input).trim().toUpperCase();
  if (!CURRENCIES.includes(code)) return { error: `Currency must be one of ${CURRENCIES.join(" or ")}` };
  return { currency: code };
}

function validateVatRate(input) {
  if (input === undefined || input === null || input === "") return { rate: undefined };
  const rate = Number(input);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { error: "VAT rate must be between 0 and 100" };
  }
  return { rate: money(rate) };
}


// An invoice's line items, in the order they should be printed.
async function itemsFor(invoiceId) {
  return db
    .prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id")
    .all(invoiceId);
}

// Rejects the whole list rather than silently dropping a bad row: a line that
// quietly vanishes between typing and sending is worse than being told which
// one is wrong.
function validateItems(input) {
  if (!Array.isArray(input)) return { error: "items must be a list" };
  const items = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i] || {};
    const where = `Line ${i + 1}`;
    const description = String(row.description ?? "").trim();
    if (!description) return { error: `${where} needs a description` };

    const quantity = Number(row.quantity ?? 1);
    if (!Number.isFinite(quantity)) return { error: `${where} has an invalid quantity` };
    if (quantity <= 0) return { error: `${where} must have a quantity above zero` };

    const unitPrice = Number(row.unit_price ?? 0);
    if (!Number.isFinite(unitPrice)) return { error: `${where} has an invalid unit price` };
    // A zero line is legitimate — a free item listed for the record — but a
    // negative one is a discount pretending to be a line, and it would let an
    // invoice quietly undercut the order cap.
    if (unitPrice < 0) return { error: `${where} cannot have a negative unit price` };

    items.push({
      description,
      quantity: money(quantity),
      unit: String(row.unit ?? "").trim() || null,
      unit_price: money(unitPrice),
      // Computed here, never taken from the caller: the total a customer is
      // shown has to be the one the numbers actually produce.
      amount: money(quantity * unitPrice),
      sort_order: i,
    });
  }
  return { items, total: money(items.reduce((n, it) => n + it.amount, 0)) };
}

// The customer this invoice belongs to. An explicit customer_id wins; failing
// that the name is matched against the customer list, so invoices raised from
// the existing name-based form still end up linked. Returns null rather than
// inventing a customer — a name nobody has set up yet is a gap to fill on the
// Customers page, not something to guess at from an invoice.
async function resolveCustomerId(customerId, customerName) {
  if (customerId) {
    const byId = await db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
    if (byId) return byId.id;
  }
  if (customerName) {
    const byName = await db
      .prepare("SELECT id FROM customers WHERE lower(btrim(name)) = lower(btrim(?))")
      .get(customerName);
    if (byName) return byName.id;
  }
  return null;
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
  res.json((await db.prepare(sql).all(...params)).map(withVat));
}));

router.post("/", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const {
    invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes, project_id, customer_id,
  } = req.body || {};
  const { error: curError, currency } = validateCurrency(req.body?.currency);
  if (curError) return res.status(400).json({ error: curError });
  if (!invoice_number || !customer_name) {
    return res.status(400).json({ error: "invoice_number and customer_name are required" });
  }
  if (order_id) {
    const info = await remainingForOrder(order_id, 0);
    if (!info) return res.status(400).json({ error: "Related order not found" });
    if ((amount || 0) > info.remaining) {
      return res
        .status(400)
        .json({ error: `Amount exceeds the order's remaining unbilled balance of ${info.remaining.toLocaleString()}` });
    }
  }
  try {
    const info = await db
      .prepare(
        `INSERT INTO invoices (invoice_number, order_id, customer_name, customer_id, amount, status, currency, issue_date, due_date, notes,
                               project_id, created_by, status_changed_by, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')), ?, ?, ?, ?, ?, ?)`
      )
      .run(
        invoice_number,
        order_id || null,
        customer_name,
        await resolveCustomerId(customer_id, customer_name),
        amount || 0,
        status || "draft",
        currency || "PHP",
        issue_date || null,
        due_date || null,
        notes || null,
        project_id || null,
        req.user.employee_id || null,
        req.user.employee_id || null,
        nowStamp()
      );
    res.status(201).json(withVat(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(info.lastInsertRowid)));
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
        `INSERT INTO invoices (invoice_number, order_id, customer_name, customer_id, amount, status, issue_date, project_id)
         VALUES (?, ?, ?, ?, ?, 'draft', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), ?)`
      )
      .run(
        invoiceNumber,
        order.id,
        order.customer_name,
        order.customer_id || (await resolveCustomerId(null, order.customer_name)),
        remaining,
        order.project_id || null
      );
    res.status(201).json(withVat(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(insertResult.lastInsertRowid)));
  } catch (err) {
    res.status(400).json({ error: "An invoice with that number already exists" });
  }
}));



// Sign-off. Nothing reaches a customer without a person putting their name to
// it, so this is a deliberate step of its own rather than a side effect of
// sending. Approving also freezes the lines — see PUT /:id/items.
router.post("/:id/approve", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const invoice = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.status !== "draft") {
    return res.status(400).json({ error: `Only a draft can be approved — this one is ${invoice.status}.` });
  }
  // Approving a nil invoice is almost always an unfinished draft rather than a
  // deliberate zero-value bill.
  if (Number(invoice.amount) <= 0) {
    return res.status(400).json({ error: "This invoice has no amount on it yet." });
  }

  await db
    .prepare(
      `UPDATE invoices SET status = 'approved', approved_by = ?, approved_at = ?,
       status_changed_by = ?, status_changed_at = ? WHERE id = ?`
    )
    .run(req.user.employee_id || null, nowStamp(), req.user.employee_id || null, nowStamp(), invoice.id);

  await logRequestEvent(req, "approve_invoice", {
    entityType: "invoice",
    entityId: invoice.id,
    details: { invoice_number: invoice.invoice_number, amount: invoice.amount, currency: invoice.currency },
  });

  const updated = await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(invoice.id);
  res.json(withVat(updated));
}));

// Back to draft, when review turns something up. Only from approved — once it
// has gone to the customer, the way back is a cancellation and a new invoice.
router.post("/:id/unapprove", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const invoice = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  if (invoice.status !== "approved") {
    return res.status(400).json({ error: `Only an approved invoice can be returned to draft — this one is ${invoice.status}.` });
  }

  await db
    .prepare(
      `UPDATE invoices SET status = 'draft', approved_by = NULL, approved_at = NULL,
       status_changed_by = ?, status_changed_at = ? WHERE id = ?`
    )
    .run(req.user.employee_id || null, nowStamp(), invoice.id);

  await logRequestEvent(req, "unapprove_invoice", {
    entityType: "invoice",
    entityId: invoice.id,
    details: { invoice_number: invoice.invoice_number },
  });

  const updated = await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(invoice.id);
  res.json(withVat(updated));
}));

// What would happen if Send were pressed, without pressing it. Lets the button
// explain itself instead of failing at the moment of use.
router.get("/:id/send-check", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const ready = await sendReadiness(req.params.id);
  if (ready.error) return res.json({ ready: false, reason: ready.error });
  res.json({
    ready: true,
    to: ready.customer.email,
    cc: ready.customer.cc_emails || [],
  });
}));

// The only thing in the app that emails a customer, and it only ever runs
// because somebody pressed the button.
router.post("/:id/send", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const result = await sendInvoiceEmail(req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });

  const alreadySent = result.invoice.status === "sent" || result.invoice.status === "overdue";
  const stamp = nowStamp();

  // A paid or overdue invoice keeps its status — re-sending a copy is chasing
  // payment, not putting the invoice back to "sent".
  const keepStatus = ["paid", "overdue"].includes(result.invoice.status);
  await db
    .prepare(
      `UPDATE invoices SET status = ?, sent_by = ?, sent_at = ?, sent_to = ?,
       status_changed_by = ?, status_changed_at = ? WHERE id = ?`
    )
    .run(
      keepStatus ? result.invoice.status : "sent",
      req.user.employee_id || null,
      stamp,
      result.recipients.join(", "),
      req.user.employee_id || null,
      stamp,
      result.invoice.id
    );

  await logRequestEvent(req, alreadySent ? "resend_invoice" : "send_invoice", {
    entityType: "invoice",
    entityId: result.invoice.id,
    details: {
      invoice_number: result.invoice.invoice_number,
      to: result.recipients.join(", "),
      attachment: result.filename,
    },
  });

  const updated = await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(result.invoice.id);
  res.json({ ...withVat(updated), sent_to_list: result.recipients, resent: alreadySent });
}));

// The invoice as a document. Streamed rather than written to a file — Render's
// disk is ephemeral and there is nothing to keep: the PDF is reproducible from
// the invoice at any time.
router.get("/:id/pdf", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const data = await invoiceForPdf(req.params.id);
  if (!data) return res.status(404).json({ error: "Invoice not found" });

  const safeName = String(data.invoice.invoice_number).replace(/[^A-Za-z0-9._-]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  // inline, so clicking it opens a preview instead of dropping a file in
  // Downloads that nobody asked for.
  res.setHeader("Content-Disposition", `inline; filename="${safeName}.pdf"`);
  renderInvoicePdf(data, res);
}));

// One invoice with its breakdown. There was no single-invoice route before —
// the list carried everything — but a document with line items is too big to
// send for every row in the table.
router.get("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const invoice = await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  invoice.items = await itemsFor(invoice.id);
  res.json(withVat(invoice));
}));

// Replaces the whole breakdown in one go. A per-line API would leave an
// invoice half-edited if a request failed partway, and the total is derived
// from the set — there is no meaningful "one line changed" state to be in.
router.put("/:id/items", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });

  // Once an invoice has gone out, its numbers are what the customer was told.
  // Changing them afterwards means the copy on their desk and the copy here
  // disagree, with nothing recording that it happened.
  if (existing.status !== "draft") {
    return res.status(400).json({
      error: `This invoice is ${existing.status}, so its lines can no longer be changed. Cancel it and raise a new one instead.`,
    });
  }

  const { error, items, total } = validateItems(req.body?.items);
  if (error) return res.status(400).json({ error });

  const { error: rateError, rate } = validateVatRate(req.body?.vat_rate);
  if (rateError) return res.status(400).json({ error: rateError });

  const { error: itemsCurError, currency: itemsCurrency } = validateCurrency(req.body?.currency);
  if (itemsCurError) return res.status(400).json({ error: itemsCurError });

  // The order cap still applies — the breakdown is a new way to reach a total,
  // not a way around the limit on how much an order can be billed for.
  if (existing.order_id && existing.status !== "cancelled") {
    const info = await remainingForOrder(existing.order_id, existing.id);
    if (info && total > info.remaining) {
      return res.status(400).json({
        error: `These lines come to ${total.toLocaleString()}, over the order's remaining unbilled balance of ${info.remaining.toLocaleString()}`,
      });
    }
  }

  await db.transaction(async () => {
    await db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(existing.id);
    for (const it of items) {
      await db
        .prepare(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, amount, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(existing.id, it.description, it.quantity, it.unit, it.unit_price, it.amount, it.sort_order);
    }
    // An invoice with lines is totalled from them. Clearing every line leaves
    // the amount alone rather than zeroing it, so removing a breakdown from an
    // invoice does not silently wipe what it is worth.
    if (items.length > 0) {
      await db.prepare("UPDATE invoices SET amount = ? WHERE id = ?").run(total, existing.id);
    }
    if (rate !== undefined) {
      await db.prepare("UPDATE invoices SET vat_rate = ? WHERE id = ?").run(rate, existing.id);
    }
    if (itemsCurrency !== undefined) {
      await db.prepare("UPDATE invoices SET currency = ? WHERE id = ?").run(itemsCurrency, existing.id);
    }
  })();

  const updated = await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(existing.id);
  updated.items = await itemsFor(existing.id);
  res.json(withVat(updated));
}));

router.put("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  const {
    invoice_number, order_id, customer_name, amount, status, issue_date, due_date, notes, project_id, customer_id, vat_rate,
  } = req.body || {};
  if (status && !["draft", "approved", "sent", "paid", "overdue", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const { error: rateError, rate } = validateVatRate(vat_rate);
  if (rateError) return res.status(400).json({ error: rateError });

  const { error: curError, currency } = validateCurrency(req.body?.currency);
  if (curError) return res.status(400).json({ error: curError });

  // The breakdown owns the total once it exists. Letting the amount be typed
  // over independently is how an invoice ends up whose lines do not add up to
  // what it says at the bottom.
  if (amount !== undefined && Number(amount) !== Number(existing.amount)) {
    const lineCount = (await db.prepare("SELECT COUNT(*) AS c FROM invoice_items WHERE invoice_id = ?").get(existing.id)).c;
    if (lineCount > 0) {
      return res.status(400).json({
        error: "This invoice is totalled from its line items — edit the lines instead of the amount.",
      });
    }
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
          .json({ error: `Amount exceeds the order's remaining unbilled balance of ${info.remaining.toLocaleString()}` });
      }
    }
  }

  const paid_date = status === "paid" && existing.status !== "paid" ? new Date().toISOString().slice(0, 10) : existing.paid_date;
  const invStatusMoved = (status || existing.status) !== existing.status;

  try {
    await db.prepare(
      `UPDATE invoices SET invoice_number = ?, order_id = ?, customer_name = ?, customer_id = ?, amount = ?, status = ?,
       vat_rate = ?, currency = ?, issue_date = ?, due_date = ?, notes = ?, paid_date = ?, project_id = ?,
       status_changed_by = ?, status_changed_at = ? WHERE id = ?`
    ).run(
      invoice_number ?? existing.invoice_number,
      order_id !== undefined ? order_id || null : existing.order_id,
      customer_name ?? existing.customer_name,
      // Re-resolved whenever the name or the link is touched, so correcting a
      // misspelled customer on an invoice actually re-points it.
      customer_id !== undefined || customer_name !== undefined
        ? await resolveCustomerId(customer_id, customer_name ?? existing.customer_name)
        : existing.customer_id,
      amount !== undefined ? amount : existing.amount,
      status || existing.status,
      rate !== undefined ? rate : existing.vat_rate,
      currency !== undefined ? currency : existing.currency,
      issue_date ?? existing.issue_date,
      due_date !== undefined ? due_date : existing.due_date,
      notes !== undefined ? notes : existing.notes,
      paid_date,
      project_id !== undefined ? project_id || null : existing.project_id,
      // Only re-stamped when the status actually moves — the person who marked
      // an invoice paid should not be replaced by whoever later fixed a typo.
      invStatusMoved ? req.user.employee_id || null : existing.status_changed_by,
      invStatusMoved ? nowStamp() : existing.status_changed_at,
      req.params.id
    );
  } catch (err) {
    return res.status(400).json({ error: "An invoice with that number already exists" });
  }
  res.json(withVat(await db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id)));
}));

router.delete("/:id", requireAuth, requireRole("admin", "hr"), asyncHandler(async (req, res) => {
  const existing = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });
  await db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.status(204).end();
}));

module.exports = router;
