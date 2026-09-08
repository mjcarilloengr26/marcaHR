const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { withRollup, money } = require("../services/projectRollup");
const { appTimezone } = require("../services/timezone");
const { wouldCycle, reschedule, conflicts, conflictsFrom, allDependencies } = require("../services/taskSchedule");
const { currentCalendar, LABELS } = require("../services/workingWeek");

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
  const { contract_value, spend, margin, marginPercent, spentPercent, overSpend, billing, orders, ...rest } = p;
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
    // Everything this page needs, asked for at once.
    //
    // It used to be six awaits in a row, and against a database a network hop
    // away each one costs a full round trip whether or not it depends on the
    // last. Only the rollup genuinely needs the date first, so the rest go
    // together.
    const day = await today();
    const [all, tasks, dependencies, cal] = await Promise.all([
      // The chart is not a money screen, and the people who keep it current
      // are the ones the work is assigned to — so they can read it. What they
      // must not read is the contract value and margin riding along on the
      // same rollup, so those are dropped below rather than the whole page
      // being closed off.
      withRollup(day),
      db
        .prepare(
          `SELECT t.*, (e.first_name || ' ' || e.last_name) AS assignee_name
           FROM project_tasks t
           LEFT JOIN employees e ON e.id = t.assignee_id
           ORDER BY t.project_id, t.position, t.start_date, t.id`
        )
        .all(),
      allDependencies(),
      currentCalendar(),
    ]);
    const projects = ["admin", "hr"].includes(req.user.role) ? all : all.map(stripMoney);

    // Worked out from the tasks and links already in hand. Calling conflicts()
    // per project re-read both tables once per project — two more queries per
    // row on a page that had just fetched all of it.
    const clashes = conflictsFrom(tasks, dependencies, cal);
    res.json({
      today: day,
      projects,
      tasks: withDuration(tasks, cal),
      dependencies,
      conflicts: clashes,
      // The chart shades the days nobody works; the dialog labels its duration
      // field with which week it is counting.
      workingWeek: { value: cal.week, label: LABELS[cal.week], days: [...cal.days] },
    });
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
    const cal = await currentCalendar();
    res.json({
      ...project,
      taskList: withDuration(tasks, cal),
      workingWeek: { value: cal.week, label: LABELS[cal.week], days: [...cal.days] },
      dependencies: (await allDependencies()).filter((d) => tasks.some((t) => t.id === d.task_id)),
      conflicts: await conflicts(project.id),
    });
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

    // Created from an order: the sale it came from is attached to the project
    // in the same breath. Prefilling the name, client and value from an order
    // and then not linking it would leave a project quoting a contract figure
    // taken from an order that is not on its books — the value would be there
    // but nothing billed against it would ever find its way home.
    const fromOrderId = req.body?.from_order_id ? Number(req.body.from_order_id) : null;
    let order = null;
    if (fromOrderId) {
      order = await db.prepare("SELECT id, order_number, project_id, status FROM orders WHERE id = ?").get(fromOrderId);
      if (!order) return res.status(400).json({ error: "That order does not exist" });
      if (order.project_id) {
        return res.status(409).json({ error: `${order.order_number} is already booked to another project` });
      }
      if (order.status === "cancelled") {
        return res.status(400).json({ error: `${order.order_number} is cancelled — it cannot start a project` });
      }
    }

    // One transaction: a project created with its order left unattached is the
    // half-state this whole path exists to avoid, and it would be invisible —
    // the project would look complete and simply never collect its billing.
    let projectId;
    await db.transaction(async () => {
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
      projectId = info.lastInsertRowid;

      if (order) {
        await db.prepare("UPDATE orders SET project_id = ? WHERE id = ?").run(projectId, order.id);
      }
    })();

    await logRequestEvent(req, "create_project", {
      entityType: "project",
      entityId: projectId,
      details: { code: v.code, name: v.name, contract_value: v.contract_value, fromOrder: order?.order_number || null },
    });
    res.status(201).json({
      ...(await db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId)),
      linkedOrder: order ? order.order_number : null,
    });
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

// `cal` is the working-week calendar. Duration is accepted as an alternative
// to the end date and resolved here rather than on the client: the client
// would need its own copy of the working-day arithmetic to do it, and two
// implementations of the same rule is how they drift.
function validateTask(body, existing = {}, cal) {
  const pick = (key) => (body[key] === undefined ? existing[key] : body[key]);

  const name = text(pick("name"));
  if (!name) return { error: "Give the task a name" };

  const milestone = Boolean(pick("is_milestone"));
  const rawStart = text(pick("start_date"));
  if (!rawStart || !DATE.test(rawStart)) return { error: "A task needs a start date" };

  // A start on a day nobody works gets moved to the next working day rather
  // than refused. Refusing is irritating and allowing it silently breaks the
  // duration it is measured with — the save notice says it happened.
  const start = cal.nextWorkingDay(rawStart);
  const snapped = start !== rawStart;

  // Duration wins when it is the thing that was sent, because it is the more
  // specific statement: "this takes ten days" survives the start moving, an
  // end date does not.
  const rawDuration = body.duration_days;
  const hasDuration = rawDuration !== undefined && rawDuration !== null && rawDuration !== "";
  let end;
  if (milestone) {
    // A milestone is a single date, so it has no end of its own to get wrong.
    end = start;
  } else if (hasDuration) {
    const days = Math.round(Number(rawDuration));
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return { error: "Duration must be between 1 and 3650 working days" };
    }
    end = cal.endAfterWorkingDays(start, days);
  } else {
    end = text(pick("end_date"));
  }
  if (!end || !DATE.test(end)) return { error: "A task needs an end date, or a duration in days" };
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
    snappedFrom: snapped ? rawStart : null,
  };
}

// Durations are derived and handed back with every task, so nothing on the
// client has to reimplement the working-day count to display one.
function withDuration(tasks, cal) {
  return tasks.map((t) => ({
    ...t,
    duration_days: t.is_milestone ? 1 : cal.workingDaysBetween(t.start_date, t.end_date),
  }));
}

// Accepts either bare ids or {id, lag_days} objects, so the simple case stays
// simple. Omitting the field entirely leaves existing links alone; sending an
// empty array clears them — the same distinction the rest of the app draws
// between "not mentioned" and "deliberately blank".
function parsePredecessors(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return { error: "Predecessors must be a list" };
  const out = [];
  for (const entry of raw) {
    const id = Number(typeof entry === "object" && entry !== null ? entry.id ?? entry.depends_on_id : entry);
    if (!Number.isInteger(id) || id <= 0) return { error: "Each predecessor must be a task id" };
    const lag = Number(typeof entry === "object" && entry !== null ? entry.lag_days ?? entry.lag ?? 0 : 0);
    if (!Number.isFinite(lag) || lag < 0 || lag > 3650) return { error: "Lag must be between 0 and 3650 days" };
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, lag: Math.round(lag) });
  }
  return out;
}

// Writes the link set for one task, refusing anything that would make the plan
// impossible to compute: a task waiting on itself, on a task in another
// project, or on a chain that leads back to it.
async function applyPredecessors(taskId, projectId, list) {
  const inProject = await db.prepare("SELECT id FROM project_tasks WHERE project_id = ?").all(projectId);
  const ids = new Set(inProject.map((t) => t.id));

  for (const p of list) {
    if (p.id === Number(taskId)) return { error: "A task cannot wait on itself" };
    if (!ids.has(p.id)) return { error: "A task can only wait on another task in the same project" };
  }

  // Checked against the links as they will be, not as they are — adding two at
  // once can close a loop that neither would close on its own.
  const existing = await db
    .prepare(
      `SELECT d.* FROM project_task_dependencies d
       JOIN project_tasks t ON t.id = d.task_id
       WHERE t.project_id = ? AND d.task_id <> ?`
    )
    .all(projectId, taskId);

  const proposed = [...existing];
  for (const p of list) {
    if (wouldCycle(proposed, taskId, p.id)) {
      const name = (await db.prepare("SELECT name FROM project_tasks WHERE id = ?").get(p.id))?.name || `task ${p.id}`;
      return { error: `Waiting on "${name}" would make a loop — it already waits on this task, directly or through others` };
    }
    proposed.push({ task_id: Number(taskId), depends_on_id: p.id, lag_days: p.lag });
  }

  await db.prepare("DELETE FROM project_task_dependencies WHERE task_id = ?").run(taskId);
  for (const p of list) {
    await db
      .prepare("INSERT INTO project_task_dependencies (task_id, depends_on_id, lag_days) VALUES (?, ?, ?)")
      .run(taskId, p.id, p.lag);
  }
  return {};
}

router.post(
  "/:id/tasks",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const project = await db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const cal = await currentCalendar();
    const v = validateTask(req.body || {}, {}, cal);
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

    const preds = parsePredecessors(req.body?.predecessors);
    if (preds && preds.error) return res.status(400).json({ error: preds.error });

    let taskId;
    let linkError = null;
    let shifted = { moved: [] };
    // One transaction: a task stored without the links it was created with, or
    // with links but none of the dates they imply, is a plan that says
    // something nobody asked for.
    await db.transaction(async () => {
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
      taskId = info.lastInsertRowid;

      if (preds && preds.length > 0) {
        const applied = await applyPredecessors(taskId, Number(req.params.id), preds);
        if (applied.error) {
          linkError = applied.error;
          throw new Error("rollback");
        }
      }
      // Not pinned. A task created with predecessors should land where they
      // allow rather than where the date box happened to be sitting, which is
      // what every other planning tool does and what people expect.
      shifted = await reschedule(Number(req.params.id));
    })().catch((err) => {
      if (!linkError) throw err;
    });

    if (linkError) return res.status(400).json({ error: linkError });

    const created = await db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(taskId);
    res.status(201).json({
      ...withDuration([created], cal)[0],
      moved: shifted.moved,
      snappedFrom: v.snappedFrom,
    });
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

    const preds = parsePredecessors(req.body?.predecessors);
    if (preds && preds.error) return res.status(400).json({ error: preds.error });

    const cal = await currentCalendar();
    const v = validateTask(req.body || {}, existing, cal);
    if (v.error) return res.status(400).json({ error: v.error });

    if (v.parent_id && Number(v.parent_id) === Number(req.params.taskId)) {
      return res.status(400).json({ error: "A phase cannot contain itself" });
    }

    let linkError = null;
    let shifted = { moved: [] };
    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE project_tasks SET parent_id = ?, name = ?, start_date = ?, end_date = ?, percent_complete = ?,
           assignee_id = ?, is_milestone = ?, position = ?, notes = ? WHERE id = ?`
        )
        .run(
          v.parent_id, v.name, v.start_date, v.end_date, v.percent_complete,
          v.assignee_id, v.is_milestone, v.position, v.notes, req.params.taskId
        );

      if (preds) {
        const applied = await applyPredecessors(Number(req.params.taskId), Number(req.params.id), preds);
        if (applied.error) {
          linkError = applied.error;
          throw new Error("rollback");
        }
      }
      // Pinned only when this request actually moved the dates. Typing a date
      // and having it snap back reads as a failed save, so a hand-set date is
      // kept and the contradiction reported as a conflict instead.
      //
      // Pinning on every edit was wrong: changing a task's predecessors is an
      // edit too, and pinning there meant the one task the new link was
      // supposed to move was the one task excluded from moving.
      const datesTouched =
        (req.body?.start_date !== undefined && req.body.start_date !== existing.start_date) ||
        (req.body?.end_date !== undefined && req.body.end_date !== existing.end_date);
      shifted = await reschedule(Number(req.params.id), {
        pinnedId: datesTouched ? Number(req.params.taskId) : null,
      });
    })().catch((err) => {
      if (!linkError) throw err;
    });

    if (linkError) return res.status(400).json({ error: linkError });

    const updated = await db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(req.params.taskId);
    res.json({
      ...withDuration([updated], cal)[0],
      moved: shifted.moved,
      snappedFrom: v.snappedFrom,
      conflicts: await conflicts(Number(req.params.id)),
    });
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
    await reschedule(Number(req.params.id));
    res.status(204).end();
  })
);

module.exports = router;
