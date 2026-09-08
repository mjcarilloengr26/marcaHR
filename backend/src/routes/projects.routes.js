const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { withRollup, money } = require("../services/projectRollup");
const { appTimezone } = require("../services/timezone");

const router = express.Router();

const STATUSES = ["planned", "active", "on_hold", "completed", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Anchored to the configured timezone like the rest of the app's date logic —
// a project is late relative to the office's calendar, not the server's.
const today = async () => new Date().toLocaleDateString("en-CA", { timeZone: await appTimezone() });

const text = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

// What is left of a project once the commercial figures are taken out: the
// schedule, which is the only part of it the Gantt actually draws.
//
// The rollup is one shared service, so the alternative would be a second,
// nearly identical query for people who may not see money — and two queries
// that are meant to agree are exactly how figures drift apart.
function stripMoney(p) {
  const { contract_value, spend, margin, marginPercent, spentPercent, overSpend, billing, ...rest } = p;
  return rest;
}

// Returned rather than thrown: the global error handler flattens everything to
// a 500, so a bad date would report itself as a server fault.
function validate(body, { partial = false, existing = {} } = {}) {
  const pick = (key) => (body[key] === undefined ? existing[key] : body[key]);

  const code = text(pick("code"));
  const name = text(pick("name"));
  if (!partial || body.code !== undefined) {
    if (!code) return { error: "Give the project a code — it is how spend is filed against it" };
  }
  if (!partial || body.name !== undefined) {
    if (!name) return { error: "Give the project a name" };
  }

  const status = text(pick("status")) || "planned";
  if (!STATUSES.includes(status)) return { error: `status must be one of ${STATUSES.join(", ")}` };

  const start = text(pick("start_date"));
  const target = text(pick("target_end_date"));
  const actual = text(pick("actual_end_date"));
  for (const [label, value] of [["Start date", start], ["Target end date", target], ["Actual end date", actual]]) {
    if (value && !DATE.test(value)) return { error: `${label} must be a date` };
  }
  // A target before the start is not a tight schedule, it is a typo — and it
  // would make every percentage derived from the span negative.
  if (start && target && target < start) return { error: "The target end date cannot come before the start date" };
  if (start && actual && actual < start) return { error: "The actual end date cannot come before the start date" };

  const contractRaw = pick("contract_value");
  const contract = contractRaw === undefined || contractRaw === null || contractRaw === "" ? 0 : Number(contractRaw);
  if (!Number.isFinite(contract) || contract < 0) return { error: "Contract value cannot be negative" };

  return {
    code,
    name,
    status,
    client_name: text(pick("client_name")),
    description: text(pick("description")),
    start_date: start,
    target_end_date: target,
    actual_end_date: actual,
    contract_value: money(contract),
    owner_id: pick("owner_id") || null,
    cost_center_id: pick("cost_center_id") || null,
    notes: text(pick("notes")),
  };
}

async function codeClash(code, exceptId = null) {
  const sql = exceptId
    ? "SELECT code FROM projects WHERE LOWER(TRIM(code)) = LOWER(TRIM(?)) AND id <> ?"
    : "SELECT code FROM projects WHERE LOWER(TRIM(code)) = LOWER(TRIM(?))";
  return exceptId ? db.prepare(sql).get(code, exceptId) : db.prepare(sql).get(code);
}

router.get(
  "/",
  requireAuth,
  // The register is a money screen — contract value, spend and margin — so it
  // is held to the same rule as Cost Centers rather than being readable by
  // anyone with a login.
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const rows = await withRollup(await today());
    res.json({
      projects: rows,
      totals: {
        contractValue: money(rows.reduce((n, p) => n + p.contract_value, 0)),
        spent: money(rows.reduce((n, p) => n + p.spend.total, 0)),
        invoiced: money(rows.reduce((n, p) => n + p.billing.invoiced, 0)),
        margin: money(rows.reduce((n, p) => n + p.margin, 0)),
      },
    });
  })
);

// Just enough to fill the project dropdown on an expense report, a purchase
// order, an invoice or a work order. Finished and cancelled projects are left
// out: new spend should never be filed against a job that is closed, and a
// closed project in the list is the easiest way for that to happen by accident.
router.get(
  "/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await db
        .prepare(
          `SELECT id, code, name, status FROM projects
           WHERE status IN ('planned', 'active', 'on_hold') ORDER BY code`
        )
        .all()
    );
  })
);

// Everything the chart draws, in one request. The Gantt needs the projects and
// all of their tasks at once — fetching tasks per project would fire one
// request per bar row and make the timeline assemble itself in front of the
// reader.
router.get(
  "/gantt",
  requireAuth,
  asyncHandler(async (req, res) => {
    const day = await today();
    // The chart is not a money screen, and the people who keep it current are
    // the ones the work is assigned to — so they can read it. What they must
    // not read is the contract value and margin riding along on the same
    // rollup, so those are dropped rather than the whole page being closed off.
    const all = await withRollup(day);
    const projects = ["admin", "hr"].includes(req.user.role) ? all : all.map(stripMoney);
    const tasks = await db
      .prepare(
        `SELECT t.*, (e.first_name || ' ' || e.last_name) AS assignee_name
         FROM project_tasks t
         LEFT JOIN employees e ON e.id = t.assignee_id
         ORDER BY t.project_id, t.position, t.start_date, t.id`
      )
      .all();
    res.json({ today: day, projects, tasks });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const rows = await withRollup(await today());
    const project = rows.find((p) => p.id === Number(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const tasks = await db
      .prepare(
        `SELECT t.*, (e.first_name || ' ' || e.last_name) AS assignee_name
         FROM project_tasks t
         LEFT JOIN employees e ON e.id = t.assignee_id
         WHERE t.project_id = ? ORDER BY t.position, t.start_date, t.id`
      )
      .all(req.params.id);
    res.json({ ...project, taskList: tasks });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const clash = await codeClash(v.code);
    if (clash) return res.status(409).json({ error: `Project code "${clash.code}" is already in use` });

    const info = await db
      .prepare(
        `INSERT INTO projects (code, name, client_name, description, status, start_date, target_end_date,
                               actual_end_date, contract_value, owner_id, cost_center_id, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        v.code, v.name, v.client_name, v.description, v.status, v.start_date, v.target_end_date,
        v.actual_end_date, v.contract_value, v.owner_id, v.cost_center_id, v.notes,
        req.user.employee_id || null
      );

    await logRequestEvent(req, "create_project", {
      entityType: "project",
      entityId: info.lastInsertRowid,
      details: { code: v.code, name: v.name, contract_value: v.contract_value },
    });
    res.status(201).json(await db.prepare("SELECT * FROM projects WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Project not found" });

    const v = validate(req.body || {}, { partial: true, existing });
    if (v.error) return res.status(400).json({ error: v.error });

    const clash = await codeClash(v.code, req.params.id);
    if (clash) return res.status(409).json({ error: `Project code "${clash.code}" is already in use` });

    // Closing a project without saying when it closed leaves the schedule
    // reading "12 days past target" forever, so the date is filled in from
    // today rather than left to be remembered.
    const actualEnd =
      v.status === "completed" && !v.actual_end_date ? await today() : v.actual_end_date;

    await db
      .prepare(
        `UPDATE projects SET code = ?, name = ?, client_name = ?, description = ?, status = ?, start_date = ?,
         target_end_date = ?, actual_end_date = ?, contract_value = ?, owner_id = ?, cost_center_id = ?, notes = ?
         WHERE id = ?`
      )
      .run(
        v.code, v.name, v.client_name, v.description, v.status, v.start_date, v.target_end_date,
        actualEnd, v.contract_value, v.owner_id, v.cost_center_id, v.notes, req.params.id
      );

    await logRequestEvent(req, "update_project", {
      entityType: "project",
      entityId: Number(req.params.id),
      details: { code: v.code, from: existing.status, to: v.status },
    });
    res.json(await db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id));
  })
);

// Deleting a project would not orphan the records booked to it — the foreign
// keys are ON DELETE SET NULL — it would quietly detach that spend from the
// only thing measuring it, which is worse because nothing would look broken.
// So a project with anything filed against it is cancelled, not deleted.
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Project not found" });

    const used = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*)::int FROM expense_reports WHERE project_id = ?) AS reports,
           (SELECT COUNT(*)::int FROM purchase_orders WHERE project_id = ?) AS purchase_orders,
           (SELECT COUNT(*)::int FROM invoices WHERE project_id = ?) AS invoices,
           (SELECT COUNT(*)::int FROM work_orders WHERE project_id = ?) AS work_orders,
           (SELECT COUNT(*)::int FROM orders WHERE project_id = ?) AS orders`
      )
      .get(req.params.id, req.params.id, req.params.id, req.params.id, req.params.id);

    const attached = Object.entries(used).filter(([, n]) => n > 0);
    if (attached.length > 0) {
      const what = attached.map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ");
      return res.status(400).json({
        error: `${what} booked to "${existing.code}" — set it to cancelled instead of deleting, so its figures keep reporting`,
      });
    }

    await db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_project", {
      entityType: "project",
      entityId: Number(req.params.id),
      details: { code: existing.code, name: existing.name },
    });
    res.status(204).end();
  })
);

/* ---------------------------------------------------------------- tasks --- */

function validateTask(body, existing = {}) {
  const pick = (key) => (body[key] === undefined ? existing[key] : body[key]);

  const name = text(pick("name"));
  if (!name) return { error: "Give the task a name" };

  const milestone = Boolean(pick("is_milestone"));
  const start = text(pick("start_date"));
  if (!start || !DATE.test(start)) return { error: "A task needs a start date" };
  // A milestone is a single date, so it has no end of its own to get wrong.
  const end = milestone ? start : text(pick("end_date"));
  if (!end || !DATE.test(end)) return { error: "A task needs an end date" };
  if (end < start) return { error: "The task cannot end before it starts" };

  const pct = pick("percent_complete");
  const percent = pct === undefined || pct === null || pct === "" ? 0 : Math.round(Number(pct));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { error: "Progress must be between 0 and 100" };
  }

  return {
    name,
    start_date: start,
    end_date: end,
    percent_complete: percent,
    assignee_id: pick("assignee_id") || null,
    parent_id: pick("parent_id") || null,
    is_milestone: milestone,
    position: Number(pick("position")) || 0,
    notes: text(pick("notes")),
  };
}

router.post(
  "/:id/tasks",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const project = await db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const v = validateTask(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // A phase from another project would draw one project's bar inside
    // another's row, which the chart has no way to represent.
    if (v.parent_id) {
      const parent = await db
        .prepare("SELECT id FROM project_tasks WHERE id = ? AND project_id = ?")
        .get(v.parent_id, req.params.id);
      if (!parent) return res.status(400).json({ error: "That phase is not part of this project" });
    }

    const next = await db
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM project_tasks WHERE project_id = ?")
      .get(req.params.id);

    const info = await db
      .prepare(
        `INSERT INTO project_tasks (project_id, parent_id, name, start_date, end_date, percent_complete,
                                    assignee_id, is_milestone, position, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.params.id, v.parent_id, v.name, v.start_date, v.end_date, v.percent_complete,
        v.assignee_id, v.is_milestone, v.position || next.n, v.notes
      );

    res.status(201).json(await db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.put(
  "/:id/tasks/:taskId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await db
      .prepare("SELECT * FROM project_tasks WHERE id = ? AND project_id = ?")
      .get(req.params.taskId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Task not found" });

    // Anyone assigned the work can move its progress — a plan nobody but an
    // administrator may update is a plan that goes stale, which is the single
    // most common way a Gantt starts lying. Everything else stays with the
    // people who own the schedule.
    const isHr = ["admin", "hr"].includes(req.user.role);
    const isAssignee = req.user.employee_id && req.user.employee_id === existing.assignee_id;
    if (!isHr && !isAssignee) return res.status(403).json({ error: "Insufficient permissions" });
    if (!isHr && Object.keys(req.body || {}).some((k) => k !== "percent_complete")) {
      return res.status(403).json({ error: "Only admin/HR can change the schedule — you can update progress" });
    }

    const v = validateTask(req.body || {}, existing);
    if (v.error) return res.status(400).json({ error: v.error });

    if (v.parent_id && Number(v.parent_id) === Number(req.params.taskId)) {
      return res.status(400).json({ error: "A phase cannot contain itself" });
    }

    await db
      .prepare(
        `UPDATE project_tasks SET parent_id = ?, name = ?, start_date = ?, end_date = ?, percent_complete = ?,
         assignee_id = ?, is_milestone = ?, position = ?, notes = ? WHERE id = ?`
      )
      .run(
        v.parent_id, v.name, v.start_date, v.end_date, v.percent_complete,
        v.assignee_id, v.is_milestone, v.position, v.notes, req.params.taskId
      );

    res.json(await db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(req.params.taskId));
  })
);

router.delete(
  "/:id/tasks/:taskId",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db
      .prepare("SELECT * FROM project_tasks WHERE id = ? AND project_id = ?")
      .get(req.params.taskId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Task not found" });
    await db.prepare("DELETE FROM project_tasks WHERE id = ?").run(req.params.taskId);
    res.status(204).end();
  })
);

module.exports = router;
