const express = require("express");
const { COUNTED_SQL } = require("../services/expenseScope");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const isHr = (req) => ["admin", "hr"].includes(req.user.role);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Liquidated is the sum of every linked report's items, and rejected reports
// are excluded on purpose: a rejected liquidation has not accounted for
// anything, so counting it would show an advance settled that is still out.
//
// The balance is computed here rather than stored. A stored copy is a second
// source of truth that goes wrong the first time somebody edits a line item
// on a report three weeks later.
const SELECT = `
  SELECT a.*,
         (e.first_name || ' ' || e.last_name) AS employee_name,
         d.name AS department_name,
         COALESCE((
           SELECT SUM(i.amount)
           FROM expense_reports r
           JOIN expense_items i ON i.report_id = r.id
           WHERE r.cash_advance_id = a.id AND r.status IN ${COUNTED_SQL}
         ), 0) AS liquidated,
         COALESCE((
           SELECT COUNT(*) FROM expense_reports r WHERE r.cash_advance_id = a.id
         ), 0)::int AS report_count,
         (dv.first_name || ' ' || dv.last_name) AS decided_by_name
  FROM cash_advances a
  JOIN employees e ON e.id = a.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN employees dv ON dv.id = a.decided_by`;

// outstanding > 0 means the employee still holds company cash.
// outstanding < 0 means they spent more than they were given, and that excess
// is owed back to them as a reimbursement against this same advance rather
// than as a separate claim.
function withBalance(row) {
  if (!row) return null;
  const outstanding = money(row.amount - row.returned_amount - row.liquidated);
  return {
    ...row,
    liquidated: money(row.liquidated),
    outstanding,
    dueToCompany: outstanding > 0 ? outstanding : 0,
    reimbursementDue: outstanding < 0 ? Math.abs(outstanding) : 0,
    fullyAccounted: outstanding === 0,
  };
}

// CA-2026-0001. The year is the release year, so a reference says when the
// money went out without anyone opening the record.
async function nextReference(dateReleased) {
  const year = String(dateReleased).slice(0, 4);
  const row = await db
    .prepare("SELECT reference FROM cash_advances WHERE reference LIKE ? ORDER BY reference DESC LIMIT 1")
    .get(`CA-${year}-%`);
  const last = row ? Number(String(row.reference).split("-")[2]) : 0;
  return `CA-${year}-${String(last + 1).padStart(4, "0")}`;
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `${SELECT} WHERE 1=1`;
    const params = [];

    // An employee sees the advances released to them, and nothing else.
    if (!isHr(req)) {
      sql += " AND a.employee_id = ?";
      params.push(req.user.employee_id ?? -1);
    } else if (req.query.employee_id) {
      sql += " AND a.employee_id = ?";
      params.push(req.query.employee_id);
    }
    if (req.query.status) {
      sql += " AND a.status = ?";
      params.push(req.query.status);
    }

    // Open first: those are the ones still holding company money.
    sql += " ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END, a.date_released DESC, a.id DESC";
    const rows = await db.prepare(sql).all(...params);
    res.json(rows.map(withBalance));
  })
);

// One advance with the reports that have drawn on it, so the running balance
// can be read without hunting through the expenses list.
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.prepare(`${SELECT} WHERE a.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "Cash advance not found" });
    if (!isHr(req) && row.employee_id !== req.user.employee_id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const reports = await db
      .prepare(
        `SELECT r.id, r.title, r.expense_type, r.status, r.created_at,
                COALESCE((SELECT SUM(amount) FROM expense_items WHERE report_id = r.id), 0) AS total_expenses
         FROM expense_reports r WHERE r.cash_advance_id = ? ORDER BY r.created_at DESC`
      )
      .all(req.params.id);
    res.json({ ...withBalance(row), reports });
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
    amount: b.amount === "" || b.amount == null ? NaN : Number(b.amount),
    date_released: text(b.date_released),
    purpose: text(b.purpose),
    cost_center: text(b.cost_center),
    notes: text(b.notes),
  };
}

// Anyone can ask for an advance; nobody grants their own. An employee's
// request is always for themselves — letting them name a recipient would be a
// way to route company cash to someone else without a decision.
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const v = readBody(req.body);
    if (!isHr(req)) v.employee_id = req.user.employee_id;
    if (!v.employee_id) return res.status(400).json({ error: "Choose who the advance is for" });
    if (!Number.isFinite(v.amount) || v.amount <= 0) return res.status(400).json({ error: "Amount must be more than zero" });
    if (!v.date_released || !/^\d{4}-\d{2}-\d{2}$/.test(v.date_released)) {
      return res.status(400).json({ error: "Release date must be YYYY-MM-DD" });
    }
    const employee = await db.prepare("SELECT id FROM employees WHERE id = ?").get(v.employee_id);
    if (!employee) return res.status(400).json({ error: "That employee does not exist" });

    // HR raising one is the handover actually happening, so it is open from
    // the start. An employee's goes to pending and waits for a decision.
    const status = isHr(req) ? "open" : "pending";
    const reference = await nextReference(v.date_released);
    const info = await db
      .prepare(
        `INSERT INTO cash_advances (reference, employee_id, amount, date_released, purpose, cost_center, notes, created_by, status,
                                    decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reference, v.employee_id, money(v.amount), v.date_released, v.purpose, v.cost_center, v.notes,
        req.user.employee_id || null, status,
        status === "open" ? req.user.employee_id || null : null,
        status === "open" ? nowStamp() : null
      );

    await logRequestEvent(req, status === "open" ? "release_cash_advance" : "request_cash_advance", {
      entityType: "cash_advance",
      entityId: info.lastInsertRowid,
      details: { reference, employee_id: v.employee_id, amount: money(v.amount), status },
    });
    res.status(201).json(withBalance(await db.prepare(`${SELECT} WHERE a.id = ?`).get(info.lastInsertRowid)));
  })
);

// Approve or refuse a request. Approving is the release: the money exists from
// this moment, so the decision and the release are one act rather than two
// steps somebody can forget the second half of.
router.put(
  "/:id/decision",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { decision, decision_note } = req.body || {};
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }
    const existing = await db.prepare("SELECT * FROM cash_advances WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Cash advance not found" });
    if (existing.status !== "pending") {
      return res.status(400).json({ error: `That request is already ${existing.status}` });
    }
    // Nobody decides on their own request, however senior. The whole point of
    // routing it is that a second person looks at it.
    if (existing.employee_id && existing.employee_id === req.user.employee_id) {
      return res.status(403).json({ error: "You cannot decide on your own cash advance request" });
    }

    await db
      .prepare(
        `UPDATE cash_advances SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`
      )
      .run(
        decision === "approved" ? "open" : "rejected",
        req.user.employee_id || null,
        nowStamp(),
        (decision_note || "").trim() || null,
        req.params.id
      );

    await logRequestEvent(req, "decide_cash_advance", {
      entityType: "cash_advance",
      entityId: Number(req.params.id),
      details: { reference: existing.reference, decision, amount: existing.amount },
    });
    res.json(withBalance(await db.prepare(`${SELECT} WHERE a.id = ?`).get(req.params.id)));
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare(`${SELECT} WHERE a.id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Cash advance not found" });
    const current = withBalance(existing);
    const b = req.body || {};

    const amount = b.amount === undefined ? current.amount : Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Amount must be more than zero" });

    const returned = b.returned_amount === undefined ? current.returned_amount : Number(b.returned_amount);
    if (!Number.isFinite(returned) || returned < 0) return res.status(400).json({ error: "Returned cash cannot be negative" });
    // Handing back more than was released is a data-entry slip, not a refund.
    if (money(returned) > money(amount)) {
      return res.status(400).json({ error: `Cannot return more than the ${money(amount)} released` });
    }
    // Returning cash that has already been spent would drive the balance
    // negative and read as a reimbursement the company does not owe.
    if (money(returned + current.liquidated) > money(amount)) {
      const spare = money(amount - current.liquidated);
      return res.status(400).json({
        error: `Only ${spare} is unspent on this advance, so that is the most that can be returned`,
      });
    }

    const status = b.status === undefined ? current.status : b.status;
    if (!["open", "settled", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "status must be open, settled or cancelled" });
    }
    if (status === "cancelled" && current.report_count > 0) {
      return res.status(400).json({ error: "Reports have already drawn on this advance, so it cannot be cancelled" });
    }

    const text = (v, fallback) => (v === undefined ? fallback : (String(v).trim() || null));
    await db
      .prepare(
        `UPDATE cash_advances SET amount = ?, returned_amount = ?, status = ?, purpose = ?, cost_center = ?,
                notes = ?, date_released = ?
         WHERE id = ?`
      )
      .run(
        money(amount),
        money(returned),
        status,
        text(b.purpose, current.purpose),
        text(b.cost_center, current.cost_center),
        text(b.notes, current.notes),
        b.date_released === undefined ? current.date_released : b.date_released,
        req.params.id
      );

    await logRequestEvent(req, "update_cash_advance", {
      entityType: "cash_advance",
      entityId: Number(req.params.id),
      details: {
        reference: current.reference,
        amount: money(amount),
        returned_amount: money(returned),
        previous_returned: current.returned_amount,
        status,
      },
    });
    res.json(withBalance(await db.prepare(`${SELECT} WHERE a.id = ?`).get(req.params.id)));
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const row = await db.prepare(`${SELECT} WHERE a.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "Cash advance not found" });
    // Deleting would orphan the liquidation: the reports would survive with no
    // advance to have drawn on. Cancelling an unused one is the way out.
    if (row.report_count > 0) {
      return res.status(400).json({
        error: `${row.report_count} report${row.report_count === 1 ? " has" : "s have"} drawn on this advance — delete or unlink those first`,
      });
    }
    await db.prepare("DELETE FROM cash_advances WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_cash_advance", {
      entityType: "cash_advance",
      entityId: Number(req.params.id),
      details: { reference: row.reference, amount: row.amount, employee_id: row.employee_id },
    });
    res.status(204).end();
  })
);

module.exports = router;
