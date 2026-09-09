const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { runSchedule, runDueSchedules, advance } = require("../services/billingTriggers");

const router = express.Router();

const CADENCES = ["weekly", "fortnightly", "monthly", "quarterly", "yearly"];

const SELECT_BASE = `
  SELECT s.*, c.name AS customer_name, c.email AS customer_email,
    p.code AS project_code,
    src.invoice_number AS source_invoice_number,
    last.invoice_number AS last_invoice_number
  FROM billing_schedules s
  JOIN customers c ON c.id = s.customer_id
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN invoices src ON src.id = s.source_invoice_id
  LEFT JOIN invoices last ON last.id = s.last_invoice_id
`;

router.get(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    res.json(await db.prepare(`${SELECT_BASE} ORDER BY s.active DESC, s.next_run_date`).all());
  })
);

// A schedule is created from a statement already raised by hand: "bill this
// again, every month". That is how people describe it, and it means the first
// run knows what to charge without anyone re-entering the lines.
router.post(
  "/from-invoice/:invoiceId",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: "Statement not found" });
    if (!invoice.customer_id) {
      return res.status(400).json({
        error: "This statement is not linked to a customer record, so there is nobody to bill repeatedly.",
      });
    }

    const cadence = String(req.body?.cadence || "monthly");
    if (!CADENCES.includes(cadence)) {
      return res.status(400).json({ error: `Cadence must be one of ${CADENCES.join(", ")}` });
    }

    const description = String(req.body?.description || "").trim() || `Recurring billing — ${invoice.invoice_number}`;
    const endDate = String(req.body?.end_date || "").trim() || null;

    // Defaults to one period after the statement it copies, so setting up a
    // schedule never immediately re-bills what was just sent.
    const nextRun =
      String(req.body?.next_run_date || "").trim() ||
      advance(invoice.issue_date || new Date().toISOString().slice(0, 10), cadence);

    if (endDate && endDate < nextRun) {
      return res.status(400).json({ error: "The end date is before the first run." });
    }

    const info = await db
      .prepare(
        `INSERT INTO billing_schedules (customer_id, project_id, description, source_invoice_id, cadence,
                                        next_run_date, end_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        invoice.customer_id,
        invoice.project_id || null,
        description,
        invoice.id,
        cadence,
        nextRun,
        endDate,
        req.user.employee_id || null
      );

    await logRequestEvent(req, "create_billing_schedule", {
      entityType: "billing_schedule",
      entityId: info.lastInsertRowid,
      details: { from_invoice: invoice.invoice_number, cadence, next_run_date: nextRun },
    });

    res.status(201).json(await db.prepare(`${SELECT_BASE} WHERE s.id = ?`).get(info.lastInsertRowid));
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM billing_schedules WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    const cadence = req.body?.cadence ?? existing.cadence;
    if (!CADENCES.includes(cadence)) {
      return res.status(400).json({ error: `Cadence must be one of ${CADENCES.join(", ")}` });
    }

    const nextRun = String(req.body?.next_run_date ?? existing.next_run_date).trim();
    const endDate = req.body?.end_date !== undefined ? String(req.body.end_date).trim() || null : existing.end_date;
    if (endDate && endDate < nextRun) {
      return res.status(400).json({ error: "The end date is before the next run." });
    }

    await db
      .prepare(
        `UPDATE billing_schedules SET description = ?, cadence = ?, next_run_date = ?, end_date = ?, active = ?
         WHERE id = ?`
      )
      .run(
        String(req.body?.description ?? existing.description).trim() || existing.description,
        cadence,
        nextRun,
        endDate,
        req.body?.active !== undefined ? !!req.body.active : existing.active,
        req.params.id
      );

    res.json(await db.prepare(`${SELECT_BASE} WHERE s.id = ?`).get(req.params.id));
  })
);

// Raise this period's statement now rather than waiting for the overnight run
// — for a schedule set up mid-period, or to check what it would produce.
router.post(
  "/:id/run-now",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const schedule = await db.prepare("SELECT * FROM billing_schedules WHERE id = ?").get(req.params.id);
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });
    if (!schedule.active) return res.status(400).json({ error: "This schedule is switched off." });

    const draft = await runSchedule(schedule);
    if (!draft) return res.status(400).json({ error: "Nothing could be raised for this schedule." });

    await logRequestEvent(req, "run_billing_schedule", {
      entityType: "billing_schedule",
      entityId: schedule.id,
      details: { invoice_number: draft.invoice_number, manual: true },
    });

    res.status(201).json(draft);
  })
);

// Catch up everything due. The overnight job calls the same function; this is
// here so it can be run by hand after downtime without waiting a day.
router.post(
  "/run-due",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const raised = await runDueSchedules();
    await logRequestEvent(req, "run_due_billing_schedules", {
      entityType: "billing_schedule",
      details: { raised: raised.length },
    });
    res.json({ raised });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM billing_schedules WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Schedule not found" });
    // Deleted outright rather than retired: a schedule holds no history of its
    // own — the statements it raised are the record, and they are untouched.
    await db.prepare("DELETE FROM billing_schedules WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  })
);

module.exports = router;
