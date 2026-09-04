const express = require("express");
const db = require("../db");
const { withSpend, money } = require("../services/costCenterSpend");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const thisYear = () => new Date().getFullYear();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year) || thisYear();
    const { rows, unassigned } = await withSpend(year);
    res.json({
      year,
      centers: rows,
      unassigned,
      totals: {
        budget: money(rows.reduce((n, r) => n + r.budget, 0)),
        spent: money(rows.reduce((n, r) => n + r.spent, 0) + unassigned.reduce((n, u) => n + u.spent, 0)),
      },
    });
  })
);

// Just the names, for the dropdowns on the expense and advance forms.
router.get(
  "/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db.prepare("SELECT id, name, code FROM cost_centers WHERE active ORDER BY name").all();
    res.json(rows);
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Give the cost center a name" });

    const clash = await db
      .prepare("SELECT name FROM cost_centers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))")
      .get(name);
    if (clash) return res.status(409).json({ error: `"${clash.name}" already exists` });

    const info = await db
      .prepare("INSERT INTO cost_centers (name, code, notes) VALUES (?, ?, ?)")
      .run(name, String(req.body?.code || "").trim() || null, String(req.body?.notes || "").trim() || null);

    await logRequestEvent(req, "create_cost_center", {
      entityType: "cost_center",
      entityId: info.lastInsertRowid,
      details: { name },
    });
    res.status(201).json(await db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Cost center not found" });

    const name = req.body?.name === undefined ? existing.name : String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Give the cost center a name" });
    const clash = await db
      .prepare("SELECT id, name FROM cost_centers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id <> ?")
      .get(name, req.params.id);
    if (clash) return res.status(409).json({ error: `"${clash.name}" already exists` });

    await db
      .prepare("UPDATE cost_centers SET name = ?, code = ?, notes = ?, active = ? WHERE id = ?")
      .run(
        name,
        req.body?.code === undefined ? existing.code : String(req.body.code).trim() || null,
        req.body?.notes === undefined ? existing.notes : String(req.body.notes).trim() || null,
        req.body?.active === undefined ? existing.active : Boolean(req.body.active),
        req.params.id
      );

    await logRequestEvent(req, "update_cost_center", {
      entityType: "cost_center",
      entityId: Number(req.params.id),
      // A rename is worth recording in full: spend is matched by name, so
      // renaming one detaches every report still carrying the old spelling.
      details: { from: existing.name, to: name, active: req.body?.active },
    });
    res.json(await db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(req.params.id));
  })
);

// The yearly allocation. Upserted per year so setting next year's figure does
// not disturb this year's, which is what the overspend is measured against.
router.put(
  "/:id/budget",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const center = await db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(req.params.id);
    if (!center) return res.status(404).json({ error: "Cost center not found" });

    const year = Number(req.body?.year) || thisYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: "Year must be a whole year between 2000 and 2100" });
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "Allocation cannot be negative" });
    }

    await db
      .prepare(
        `INSERT INTO cost_center_budgets (cost_center_id, year, amount, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cost_center_id, year) DO UPDATE SET amount = excluded.amount,
           updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
           updated_by = excluded.updated_by`
      )
      .run(center.id, year, money(amount), req.user.id);

    await logRequestEvent(req, "set_cost_center_budget", {
      entityType: "cost_center",
      entityId: center.id,
      details: { name: center.name, year, amount: money(amount) },
    });

    const { rows } = await withSpend(year);
    res.json(rows.find((r) => r.id === center.id));
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const center = await db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(req.params.id);
    if (!center) return res.status(404).json({ error: "Cost center not found" });

    // Reports carry the name as text, so deleting the row would not orphan
    // anything — it would quietly detach that spend from its budget instead,
    // which is worse because nothing would look broken.
    const used = await db
      .prepare(
        "SELECT COUNT(*)::int AS n FROM expense_reports WHERE LOWER(TRIM(cost_center)) = LOWER(TRIM(?))"
      )
      .get(center.name);
    if (used.n > 0) {
      return res.status(400).json({
        error: `${used.n} report${used.n === 1 ? " is" : "s are"} booked to "${center.name}" — retire it instead of deleting, so its spend keeps reporting`,
      });
    }

    await db.prepare("DELETE FROM cost_centers WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_cost_center", {
      entityType: "cost_center",
      entityId: Number(req.params.id),
      details: { name: center.name },
    });
    res.status(204).end();
  })
);

module.exports = router;
