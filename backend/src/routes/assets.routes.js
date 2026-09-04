const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const STATUSES = ["active", "returned", "replaced"];

const SELECT_WITH_EMPLOYEE = `
  SELECT a.*, (e.first_name || ' ' || e.last_name) AS employee_name, e.status AS employee_status,
         d.name AS department_name
  FROM employee_assets a
  JOIN employees e ON e.id = a.employee_id
  LEFT JOIN departments d ON d.id = e.department_id`;

// What an asset is worth is management information, not something to hand an
// employee about their own laptop. Hiding the column in the UI would still ship
// the number in the JSON, so it is removed from the payload itself.
function stripValueForViewer(req, rows) {
  if (["admin", "hr"].includes(req.user.role)) return rows;
  return rows.map(({ market_value, ...rest }) => rest);
}

// An employee may look at what the company has issued them, and nothing else.
// Everything that changes the register is HR/admin — an employee marking their
// own laptop "returned" is exactly the claim the register exists to check.
function scopeToViewer(req) {
  if (["admin", "hr"].includes(req.user.role)) return { clause: "", params: [] };
  return { clause: " AND a.employee_id = ?", params: [req.user.employee_id ?? -1] };
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `${SELECT_WITH_EMPLOYEE} WHERE 1=1`;
    const params = [];

    const scope = scopeToViewer(req);
    sql += scope.clause;
    params.push(...scope.params);

    if (req.query.employee_id && ["admin", "hr"].includes(req.user.role)) {
      sql += " AND a.employee_id = ?";
      params.push(req.query.employee_id);
    }
    if (req.query.status) {
      sql += " AND a.status = ?";
      params.push(req.query.status);
    }
    if (req.query.asset_type) {
      sql += " AND a.asset_type = ?";
      params.push(req.query.asset_type);
    }

    // Still-held items first, then most recently issued: the question asked of
    // this page is almost always "what does this person have right now?".
    sql += ` ORDER BY CASE a.status WHEN 'active' THEN 0 ELSE 1 END, a.date_issued DESC, a.id DESC`;
    res.json(stripValueForViewer(req, await db.prepare(sql).all(...params)));
  })
);

function readBody(body) {
  const b = body || {};
  const text = (v) => {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    return s === "" ? null : s;
  };
  return {
    employee_id: b.employee_id,
    asset_type: text(b.asset_type),
    brand: text(b.brand),
    model: text(b.model),
    serial_number: text(b.serial_number),
    asset_tag: text(b.asset_tag),
    quantity: b.quantity === "" || b.quantity === null || b.quantity === undefined ? 1 : Number(b.quantity),
    date_issued: text(b.date_issued),
    date_returned: text(b.date_returned),
    status: text(b.status) || "active",
    condition_note: text(b.condition_note),
    notes: text(b.notes),
    market_value:
      b.market_value === "" || b.market_value === null || b.market_value === undefined
        ? null
        : Number(b.market_value),
  };
}

function validate(v) {
  if (!v.employee_id) return "employee_id is required";
  if (!v.asset_type) return "asset_type is required";
  if (!v.date_issued) return "date_issued is required";
  if (!Number.isInteger(v.quantity) || v.quantity < 1) return "quantity must be a whole number of one or more";
  if (!STATUSES.includes(v.status)) return `status must be one of ${STATUSES.join(", ")}`;
  // An item that has come back needs the date it came back on, otherwise the
  // register can say "returned" without anyone being able to say when.
  if (v.status !== "active" && !v.date_returned) return "date_returned is required once an asset is returned or replaced";
  if (v.status === "active" && v.date_returned) return "an asset that is still issued cannot have a return date";
  if (v.date_returned && v.date_returned < v.date_issued) return "date_returned cannot be before date_issued";
  if (v.market_value !== null && (!Number.isFinite(v.market_value) || v.market_value < 0)) {
    return "market_value must be a number of zero or more";
  }
  return null;
}

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const v = readBody(req.body);
    const problem = validate(v);
    if (problem) return res.status(400).json({ error: problem });

    const employee = await db.prepare("SELECT id FROM employees WHERE id = ?").get(v.employee_id);
    if (!employee) return res.status(400).json({ error: "That employee does not exist" });

    const info = await db
      .prepare(
        `INSERT INTO employee_assets
           (employee_id, asset_type, brand, model, serial_number, asset_tag, quantity, date_issued, date_returned, status, condition_note, notes, market_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        v.employee_id,
        v.asset_type,
        v.brand,
        v.model,
        v.serial_number,
        v.asset_tag,
        v.quantity,
        v.date_issued,
        v.date_returned,
        v.status,
        v.condition_note,
        v.notes,
        v.market_value
      );

    const created = await db.prepare(`${SELECT_WITH_EMPLOYEE} WHERE a.id = ?`).get(info.lastInsertRowid);
    await logRequestEvent(req, "asset_issued", {
      entityType: "employee_asset",
      entityId: created.id,
      details: { employee: created.employee_name, asset: created.asset_type, serial: created.serial_number },
    });
    res.status(201).json(created);
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM employee_assets WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Asset not found" });

    // Only the fields actually sent are changed, so a status-only update from
    // the register doesn't have to resend the whole record.
    const merged = { ...existing, ...readBody({ ...existing, ...req.body }) };
    const problem = validate(merged);
    if (problem) return res.status(400).json({ error: problem });

    await db
      .prepare(
        `UPDATE employee_assets SET employee_id = ?, asset_type = ?, brand = ?, model = ?, serial_number = ?,
                asset_tag = ?, quantity = ?, date_issued = ?, date_returned = ?, status = ?, condition_note = ?, notes = ?,
                market_value = ?
         WHERE id = ?`
      )
      .run(
        merged.employee_id,
        merged.asset_type,
        merged.brand,
        merged.model,
        merged.serial_number,
        merged.asset_tag,
        merged.quantity,
        merged.date_issued,
        merged.date_returned,
        merged.status,
        merged.condition_note,
        merged.notes,
        merged.market_value,
        req.params.id
      );

    const updated = await db.prepare(`${SELECT_WITH_EMPLOYEE} WHERE a.id = ?`).get(req.params.id);
    if (updated.status !== existing.status) {
      await logRequestEvent(req, "asset_status_change", {
        entityType: "employee_asset",
        entityId: updated.id,
        details: { asset: updated.asset_type, employee: updated.employee_name, from: existing.status, to: updated.status },
      });
    }
    res.json(updated);
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM employee_assets WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Asset not found" });
    await db.prepare("DELETE FROM employee_assets WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "asset_deleted", {
      entityType: "employee_asset",
      entityId: existing.id,
      details: { asset: existing.asset_type, serial: existing.serial_number },
    });
    res.status(204).end();
  })
);

module.exports = router;
