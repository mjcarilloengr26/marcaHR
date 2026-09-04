const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { notifyAssetRequested, notifyAssetRequestDecision } = require("../notifications");

const router = express.Router();

const SELECT = `
  SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name,
         d.name AS department_name,
         (rv.first_name || ' ' || rv.last_name) AS reviewed_by_name,
         a.serial_number AS issued_serial, a.brand AS issued_brand, a.model AS issued_model
  FROM asset_requests r
  JOIN employees e ON e.id = r.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN employees rv ON rv.id = r.reviewed_by
  LEFT JOIN employee_assets a ON a.id = r.asset_id`;

const isHr = (req) => ["admin", "hr"].includes(req.user.role);
const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `${SELECT} WHERE 1=1`;
    const params = [];

    // An employee sees the requests they raised, and nothing else.
    if (!isHr(req)) {
      sql += " AND r.employee_id = ?";
      params.push(req.user.employee_id ?? -1);
    } else if (req.query.employee_id) {
      sql += " AND r.employee_id = ?";
      params.push(req.query.employee_id);
    }
    if (req.query.status) {
      sql += " AND r.status = ?";
      params.push(req.query.status);
    }

    // Waiting-on-someone first: pending needs a decision, approved needs
    // handing over. Both are work; rejected and issued are finished.
    sql += ` ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
             r.created_at DESC, r.id DESC`;
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const asset_type = (b.asset_type || "").trim();
    const reason = (b.reason || "").trim() || null;
    const needed_by = (b.needed_by || "").trim() || null;
    const quantity = b.quantity === undefined || b.quantity === "" ? 1 : Number(b.quantity);

    // HR can raise a request for somebody else (a supervisor ordering PPE for
    // a new starter); everyone else can only ask for themselves.
    const employee_id = isHr(req) && b.employee_id ? b.employee_id : req.user.employee_id;
    if (!employee_id) {
      return res.status(400).json({ error: "Your login is not linked to an employee record, so it cannot request assets" });
    }
    if (!asset_type) return res.status(400).json({ error: "asset_type is required" });
    if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: "quantity must be a whole number of one or more" });

    const employee = await db.prepare("SELECT id FROM employees WHERE id = ?").get(employee_id);
    if (!employee) return res.status(400).json({ error: "That employee does not exist" });

    const info = await db
      .prepare(
        `INSERT INTO asset_requests (employee_id, asset_type, quantity, reason, needed_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(employee_id, asset_type, quantity, reason, needed_by);

    const created = await db.prepare(`${SELECT} WHERE r.id = ?`).get(info.lastInsertRowid);
    await logRequestEvent(req, "asset_requested", {
      entityType: "asset_request",
      entityId: created.id,
      details: { employee: created.employee_name, asset: created.asset_type, quantity: created.quantity },
    });
    // Fire-and-forget, in line with the rest of the app: a mail outage must not
    // stop somebody asking for a hard hat.
    notifyAssetRequested({
      employee_id: created.employee_id,
      asset_type: created.asset_type,
      quantity: created.quantity,
      reason: created.reason,
      needed_by: created.needed_by,
    });
    res.status(201).json(created);
  })
);

// Approve or reject. Deliberately a separate endpoint from the generic update:
// a decision is the one thing on a request that must never be settable by the
// person who raised it.
router.put(
  "/:id/decision",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM asset_requests WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status === "issued") return res.status(400).json({ error: "That request has already been issued" });

    const decision = (req.body?.decision || "").trim();
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }

    await db
      .prepare("UPDATE asset_requests SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(decision, (req.body?.review_note || "").trim() || null, req.user.employee_id || null, nowStamp(), req.params.id);

    const updated = await db.prepare(`${SELECT} WHERE r.id = ?`).get(req.params.id);
    await logRequestEvent(req, "asset_request_decision", {
      entityType: "asset_request",
      entityId: updated.id,
      details: { employee: updated.employee_name, asset: updated.asset_type, from: existing.status, to: decision },
    });
    notifyAssetRequestDecision({
      employee_id: updated.employee_id,
      asset_type: updated.asset_type,
      status: decision,
      review_note: updated.review_note,
    });
    res.json(updated);
  })
);

// Hand the item over: creates the register entry and links it back, so an
// issued request can always be traced to the actual serial number.
router.post(
  "/:id/issue",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const request = await db.prepare("SELECT * FROM asset_requests WHERE id = ?").get(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "issued") return res.status(400).json({ error: "That request has already been issued" });
    if (request.status !== "approved") return res.status(400).json({ error: "Only an approved request can be issued" });

    const b = req.body || {};
    const text = (v) => {
      const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
      return s === "" ? null : s;
    };
    const date_issued = text(b.date_issued) || new Date().toISOString().slice(0, 10);
    const quantity =
      b.quantity === "" || b.quantity === null || b.quantity === undefined
        ? request.quantity || 1
        : Number(b.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "quantity must be a whole number of one or more" });
    }
    const market_value =
      b.market_value === "" || b.market_value === null || b.market_value === undefined ? null : Number(b.market_value);
    if (market_value !== null && (!Number.isFinite(market_value) || market_value < 0)) {
      return res.status(400).json({ error: "market_value must be a number of zero or more" });
    }

    const info = await db
      .prepare(
        `INSERT INTO employee_assets
           (employee_id, asset_type, brand, model, serial_number, asset_tag, quantity, date_issued, status, notes, market_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        request.employee_id,
        text(b.asset_type) || request.asset_type,
        text(b.brand),
        text(b.model),
        text(b.serial_number),
        text(b.asset_tag),
        // The request said how many. Issuing was dropping that, so a request
        // for five pairs of gloves became one row reading "gloves".
        quantity,
        date_issued,
        text(b.notes) || `Issued against request #${request.id}`,
        market_value
      );

    await db
      .prepare("UPDATE asset_requests SET status = 'issued', asset_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(info.lastInsertRowid, req.user.employee_id || null, nowStamp(), req.params.id);

    const updated = await db.prepare(`${SELECT} WHERE r.id = ?`).get(req.params.id);
    await logRequestEvent(req, "asset_request_issued", {
      entityType: "asset_request",
      entityId: updated.id,
      details: { employee: updated.employee_name, asset: updated.asset_type, assetId: info.lastInsertRowid },
    });
    res.status(201).json(updated);
  })
);

router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM asset_requests WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Request not found" });

    // Someone may withdraw their own request while it is still waiting; once it
    // has been decided or issued it is a record, and only HR may remove it.
    const isOwner = req.user.employee_id && req.user.employee_id === existing.employee_id;
    if (!isHr(req)) {
      if (!isOwner) return res.status(403).json({ error: "Insufficient permissions" });
      if (existing.status !== "pending") {
        return res.status(400).json({ error: "Only a request still awaiting a decision can be withdrawn" });
      }
    }

    await db.prepare("DELETE FROM asset_requests WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
