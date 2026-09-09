const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// A customer is worth more than its own row: what matters day to day is what
// they have been billed and what is still outstanding. Cancelled invoices are
// excluded from both — they were withdrawn, not owed.
const SELECT_BASE = `
  SELECT c.*,
    (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'cancelled')::int AS invoice_count,
    (SELECT COALESCE(SUM(i.amount), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'cancelled') AS total_billed,
    (SELECT COALESCE(SUM(i.amount), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('sent','overdue')) AS outstanding,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id)::int AS order_count,
    (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id)::int AS project_count
  FROM customers c
`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepts either a real array or the one-per-line / comma-separated text a
// person is likely to paste, so pasting a list out of Outlook works.
function parseEmailList(input) {
  if (input === undefined || input === null) return null;
  const raw = Array.isArray(input) ? input : String(input).split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const addr = String(item).trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue; // the same person twice is one copy, not two
    seen.add(key);
    out.push(addr);
  }
  return out;
}

// Everything an invoice needs before it can be sent, checked in one place so
// the billing side can rely on it rather than re-deriving what "ready" means.
function validate(body, existing) {
  const v = {
    name: (body.name ?? existing?.name ?? "").trim(),
    email: (body.email ?? existing?.email ?? "").trim() || null,
    contact_person: (body.contact_person ?? existing?.contact_person ?? "").trim() || null,
    phone: (body.phone ?? existing?.phone ?? "").trim() || null,
    billing_address: (body.billing_address ?? existing?.billing_address ?? "").trim() || null,
    tin: (body.tin ?? existing?.tin ?? "").trim() || null,
    payment_terms_days: body.payment_terms_days ?? existing?.payment_terms_days ?? 30,
    status: body.status ?? existing?.status ?? "active",
    notes: (body.notes ?? existing?.notes ?? "").trim() || null,
  };

  if (!v.name) return { error: "A customer name is required" };
  // Rejected rather than stored, because an address that only looks like an
  // email fails silently at send time — long after anyone remembers typing it.
  if (v.email && !EMAIL_RE.test(v.email)) return { error: `"${v.email}" is not a valid email address` };

  const cc = parseEmailList(body.cc_emails) ?? existing?.cc_emails ?? [];
  for (const addr of cc) {
    if (!EMAIL_RE.test(addr)) return { error: `"${addr}" is not a valid email address` };
  }
  // Copying the primary recipient sends them the same invoice twice.
  if (v.email && cc.some((a) => a.toLowerCase() === v.email.toLowerCase())) {
    return { error: `${v.email} is already the main recipient — it does not need to be copied as well` };
  }
  // A copy with nobody addressed leaves the invoice going out to no one in
  // particular, which is not something to discover at send time.
  if (!v.email && cc.length > 0) {
    return { error: "Set a main email address before adding people to copy" };
  }
  v.cc_emails = cc;

  const terms = Number(v.payment_terms_days);
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
    return { error: "Payment terms must be a whole number of days between 0 and 365" };
  }
  v.payment_terms_days = terms;

  if (!["active", "inactive"].includes(v.status)) return { error: "Status must be active or inactive" };
  return { value: v };
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `${SELECT_BASE} WHERE 1=1`;
    const params = [];
    if (req.query.status) {
      sql += " AND c.status = ?";
      params.push(req.query.status);
    }
    if (req.query.search) {
      sql += " AND (c.name ILIKE ? OR c.email ILIKE ? OR c.contact_person ILIKE ?)";
      const like = `%${req.query.search}%`;
      params.push(like, like, like);
    }
    sql += " ORDER BY c.name";
    res.json(await db.prepare(sql).all(...params));
  })
);

// Everyone who can raise an order or a project needs to pick a customer, so
// this stays open to any signed-in user while the sheet itself does not.
router.get(
  "/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await db
        .prepare(
          `SELECT id, name, email, payment_terms_days FROM customers WHERE status = 'active' ORDER BY name`
        )
        .all()
    );
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const customer = await db.prepare(`${SELECT_BASE} WHERE c.id = ?`).get(req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // The history that makes the sheet worth opening.
    customer.invoices = await db
      .prepare(
        `SELECT id, invoice_number, amount, status, issue_date, due_date
         FROM invoices WHERE customer_id = ? ORDER BY issue_date DESC, id DESC LIMIT 50`
      )
      .all(req.params.id);
    customer.orders = await db
      .prepare(
        `SELECT id, order_number, amount, status, order_date FROM orders WHERE customer_id = ? ORDER BY order_date DESC, id DESC LIMIT 50`
      )
      .all(req.params.id);
    customer.projects = await db
      .prepare(`SELECT id, code, name, status, contract_value FROM projects WHERE customer_id = ? ORDER BY id DESC`)
      .all(req.params.id);
    res.json(customer);
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr", "finance"),
  asyncHandler(async (req, res) => {
    const { error, value } = validate(req.body || {}, null);
    if (error) return res.status(400).json({ error });

    try {
      const info = await db
        .prepare(
          `INSERT INTO customers (name, email, cc_emails, contact_person, phone, billing_address, tin, payment_terms_days, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          value.name,
          value.email,
          value.cc_emails,
          value.contact_person,
          value.phone,
          value.billing_address,
          value.tin,
          value.payment_terms_days,
          value.status,
          value.notes,
          req.user.employee_id || null
        );
      res.status(201).json(await db.prepare(`${SELECT_BASE} WHERE c.id = ?`).get(info.lastInsertRowid));
    } catch (err) {
      if (String(err.message).includes("customers_name_key")) {
        return res.status(400).json({ error: `A customer named "${value.name}" already exists` });
      }
      throw err;
    }
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr", "finance"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const { error, value } = validate(req.body || {}, existing);
    if (error) return res.status(400).json({ error });

    try {
      await db
        .prepare(
          `UPDATE customers SET name = ?, email = ?, cc_emails = ?, contact_person = ?, phone = ?, billing_address = ?,
             tin = ?, payment_terms_days = ?, status = ?, notes = ? WHERE id = ?`
        )
        .run(
          value.name,
          value.email,
          value.cc_emails,
          value.contact_person,
          value.phone,
          value.billing_address,
          value.tin,
          value.payment_terms_days,
          value.status,
          value.notes,
          req.params.id
        );
      res.json(await db.prepare(`${SELECT_BASE} WHERE c.id = ?`).get(req.params.id));
    } catch (err) {
      if (String(err.message).includes("customers_name_key")) {
        return res.status(400).json({ error: `A customer named "${value.name}" already exists` });
      }
      throw err;
    }
  })
);

// Deleting a customer would strip the identity off invoices and orders that
// have already gone out, so a customer with history is retired instead. The
// caller is told which it was rather than being left to guess.
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const linked = await db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM invoices WHERE customer_id = ?)::int AS invoices,
          (SELECT COUNT(*) FROM orders WHERE customer_id = ?)::int AS orders,
          (SELECT COUNT(*) FROM deals WHERE customer_id = ?)::int AS deals,
          (SELECT COUNT(*) FROM work_orders WHERE customer_id = ?)::int AS work_orders,
          (SELECT COUNT(*) FROM projects WHERE customer_id = ?)::int AS projects`
      )
      .get(req.params.id, req.params.id, req.params.id, req.params.id, req.params.id);

    const total = Object.values(linked).reduce((n, v) => n + v, 0);
    if (total > 0) {
      await db.prepare("UPDATE customers SET status = 'inactive' WHERE id = ?").run(req.params.id);
      const parts = Object.entries(linked)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k.replace("_", " ")}`)
        .join(", ");
      return res.json({
        retired: true,
        message: `${existing.name} has ${parts} on record, so they were marked inactive rather than deleted.`,
      });
    }

    await db.prepare("DELETE FROM customers WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  })
);

module.exports = router;
