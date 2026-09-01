const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { AGING_COLUMNS, agingSummary, staleDeals } = require("../services/dealAging");

const router = express.Router();

// When an opportunity is won, it should flow into fulfillment without manual
// re-entry: auto-create a linked order (idempotent — a deal can only ever have
// one auto-created order, enforced by orders.deal_id being UNIQUE).
async function autoCreateOrderForWonDeal(deal) {
  const alreadyLinked = await db.prepare("SELECT id FROM orders WHERE deal_id = ?").get(deal.id);
  if (alreadyLinked) return null;
  const info = await db
    .prepare(
      `INSERT INTO orders (order_number, customer_name, amount, status, owner_id, deal_id, order_date, notes)
       VALUES (?, ?, ?, 'placed', ?, ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), ?)`
    )
    .run(
      `ORD-OPP-${deal.id}`,
      deal.customer_name,
      deal.value,
      deal.owner_id,
      deal.id,
      `Auto-created from won opportunity "${deal.title}"`
    );
  return await db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
}

// Sales Opportunities are HR/admin territory by default, but a sales rep needs
// to work their own pipeline too — gated on the employee actually being in
// Sales (by department or job title), not just any employee, and scoped to
// opportunities they own once in.
async function isSalesEmployee(req) {
  if (["admin", "hr"].includes(req.user.role)) return true;
  if (!req.user.employee_id) return false;
  const emp = await db
    .prepare(
      `SELECT e.position, d.name AS department_name FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
    )
    .get(req.user.employee_id);
  if (!emp) return false;
  const dept = (emp.department_name || "").toLowerCase();
  const pos = (emp.position || "").toLowerCase();
  return dept.includes("sales") || pos.includes("sales");
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const isHr = ["admin", "hr"].includes(req.user.role);
    const isSales = await isSalesEmployee(req);
    if (!isHr && !isSales) return res.status(403).json({ error: "Insufficient permissions" });

    const { stage, owner_id } = req.query;
    let sql = `SELECT d.*, (e.first_name || ' ' || e.last_name) AS owner_name, o.order_number AS linked_order_number,
             ${AGING_COLUMNS}
             FROM deals d LEFT JOIN employees e ON e.id = d.owner_id LEFT JOIN orders o ON o.deal_id = d.id WHERE 1=1`;
    const params = [];

    if (isHr) {
      if (owner_id) {
        sql += " AND d.owner_id = ?";
        params.push(owner_id);
      }
    } else {
      // Sales reps only ever see opportunities they own, regardless of any
      // owner_id filter they might pass.
      sql += " AND d.owner_id = ?";
      params.push(req.user.employee_id);
    }

    if (stage) {
      sql += " AND d.stage = ?";
      params.push(stage);
    }
    sql += " ORDER BY d.created_at DESC";
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const isHr = ["admin", "hr"].includes(req.user.role);
    const isSales = await isSalesEmployee(req);
    if (!isHr && !isSales) return res.status(403).json({ error: "Insufficient permissions" });

    const { title, customer_name, value, stage, expected_close_date, notes, competitor } = req.body || {};
    if (!title || !customer_name) return res.status(400).json({ error: "title and customer_name are required" });
    // A sales rep can only ever create opportunities under their own name —
    // owner_id from the request body is only honored for HR/admin.
    const owner_id = isHr ? req.body?.owner_id || null : req.user.employee_id;

    const info = await db
      .prepare(
        `INSERT INTO deals (title, customer_name, value, stage, owner_id, expected_close_date, notes, competitor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, customer_name, value || 0, stage || "lead", owner_id, expected_close_date || null, notes || null, competitor?.trim() || null);

    const created = await db.prepare("SELECT * FROM deals WHERE id = ?").get(info.lastInsertRowid);
    // An opportunity can be entered as already-won (e.g. logging a deal closed
    // outside the system) — the win-to-order automation must cover this path too,
    // not just the stage-transition-via-edit path, or "created as won" silently
    // skips fulfillment and the dashboards look stale/inconsistent.
    const autoCreatedOrder = created.stage === "won" ? await autoCreateOrderForWonDeal(created) : null;

    res.status(201).json({ ...created, autoCreatedOrder });
  })
);

router.put(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isHr) {
      const isSales = await isSalesEmployee(req);
      if (!isSales || existing.owner_id !== req.user.employee_id) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
    }

    const { title, customer_name, value, stage, expected_close_date, notes, competitor } = req.body || {};
    if (stage && !["lead", "qualified", "proposal", "negotiation", "won", "lost"].includes(stage)) {
      return res.status(400).json({ error: "Invalid stage" });
    }
    // Only HR/admin can reassign ownership — a sales rep editing their own
    // opportunity can't hand it to someone else via this endpoint.
    const owner_id = isHr && req.body?.owner_id !== undefined ? req.body.owner_id || null : existing.owner_id;

    // Only a stage move restarts the days-in-stage clock. Correcting a typo in
    // the title must not make a three-week-old proposal look fresh.
    const nextStage = stage || existing.stage;
    const stageMoved = nextStage !== existing.stage;

    await db
      .prepare(
        `UPDATE deals SET title = ?, customer_name = ?, value = ?, stage = ?, owner_id = ?, expected_close_date = ?, notes = ?, competitor = ?,
            stage_changed_at = CASE WHEN ? THEN to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') ELSE stage_changed_at END
     WHERE id = ?`
      )
      .run(
        title ?? existing.title,
        customer_name ?? existing.customer_name,
        value !== undefined ? value : existing.value,
        stage || existing.stage,
        owner_id,
        expected_close_date !== undefined ? expected_close_date : existing.expected_close_date,
        notes !== undefined ? notes : existing.notes,
        competitor !== undefined ? competitor?.trim() || null : existing.competitor,
        stageMoved,
        req.params.id
      );

    const updated = await db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
    let autoCreatedOrder = null;
    if (updated.stage === "won" && existing.stage !== "won") {
      autoCreatedOrder = await autoCreateOrderForWonDeal(updated);
    }

    if (updated.stage !== existing.stage) {
      await logRequestEvent(req, "deal_stage_change", {
        entityType: "deal",
        entityId: updated.id,
        details: { title: updated.title, from: existing.stage, to: updated.stage },
      });
    }

    res.json({ ...updated, autoCreatedOrder });
  })
);

router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isHr) {
      const isSales = await isSalesEmployee(req);
      if (!isSales || existing.owner_id !== req.user.employee_id) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
    }

    await db.prepare("DELETE FROM deals WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

// Pipeline aging for the Sales Dashboard. Read-only and HR/admin-or-sales, the
// same audience that can already see the pipeline itself.
router.get(
  "/aging/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isHr && !(await isSalesEmployee(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const override = req.query.threshold_days ? Number(req.query.threshold_days) : null;
    const threshold = Number.isFinite(override) && override > 0 ? override : null;
    res.json(await agingSummary(threshold));
  })
);

router.get(
  "/aging/stale",
  requireAuth,
  asyncHandler(async (req, res) => {
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isHr && !(await isSalesEmployee(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    res.json(await staleDeals());
  })
);

// The staleness threshold lives here rather than with currency and language:
// it is a sales-cycle judgement, and the app-settings GET is unauthenticated
// for the sign-in screen, which is no place for pipeline configuration.
router.put(
  "/aging/settings",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const days = Number(req.body?.stale_deal_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: "stale_deal_days must be a whole number between 1 and 365" });
    }
    await db.prepare("UPDATE app_settings SET stale_deal_days = ? WHERE id = 1").run(days);
    res.json(await agingSummary(days));
  })
);

module.exports = router;
