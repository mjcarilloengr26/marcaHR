const db = require("../db");

// Statements the app raises by itself. Every one of them produces a DRAFT and
// nothing more: it never approves, never prices anything it cannot justify,
// and never emails a customer. The whole point is that the paperwork stops
// being forgotten, not that billing stops being a decision.
//
// Each trigger is written to be safe to run twice. Deliveries get re-saved,
// tasks get re-opened and re-completed, and a scheduler can fire late — none
// of which should bill a customer a second time.

const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A statement number that will not collide with the one before it. The suffix
// counts what already exists against the same stem rather than guessing.
async function uniqueNumber(stem) {
  const base = String(stem).trim();
  const existing = await db
    .prepare("SELECT COUNT(*) AS c FROM invoices WHERE invoice_number = ? OR invoice_number LIKE ?")
    .get(base, `${base}-%`);
  return existing.c === 0 ? base : `${base}-${existing.c + 1}`;
}

// The unbilled remainder of an order. Cancelled statements do not count
// against it — they were withdrawn, not billed.
async function remainingOnOrder(orderId) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;
  const billed = (
    await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM invoices WHERE order_id = ? AND status <> 'cancelled'")
      .get(orderId)
  ).v;
  return { order, remaining: money(Math.max(Number(order.amount) - Number(billed), 0)) };
}

async function customerIdFor(name, explicitId) {
  if (explicitId) return explicitId;
  if (!name) return null;
  const row = await db.prepare("SELECT id FROM customers WHERE lower(btrim(name)) = lower(btrim(?))").get(name);
  return row ? row.id : null;
}

// One way in, so every automatic statement is shaped the same and carries the
// same evidence of where it came from.
async function createDraft({ number, customerName, customerId, amount, orderId, projectId, source, sourceRef, notes, lines }) {
  const invoiceNumber = await uniqueNumber(number);
  const info = await db
    .prepare(
      `INSERT INTO invoices (invoice_number, order_id, customer_name, customer_id, amount, status, currency,
                             issue_date, project_id, notes, auto_source, auto_source_ref)
       VALUES (?, ?, ?, ?, ?, 'draft', 'PHP', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), ?, ?, ?, ?)`
    )
    .run(
      invoiceNumber,
      orderId || null,
      customerName,
      customerId || null,
      money(amount),
      projectId || null,
      notes || null,
      source,
      sourceRef || null
    );

  const invoiceId = info.lastInsertRowid;

  if (Array.isArray(lines) && lines.length) {
    for (const [i, l] of lines.entries()) {
      await db
        .prepare(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, amount, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(invoiceId, l.description, money(l.quantity), l.unit || null, money(l.unit_price), money(l.amount), i);
    }
    const total = money(lines.reduce((n, l) => n + Number(l.amount), 0));
    await db.prepare("UPDATE invoices SET amount = ? WHERE id = ?").run(total, invoiceId);
  }

  return { id: invoiceId, invoice_number: invoiceNumber };
}

// ---------------------------------------------------------------------------
// 1. An order is marked delivered.
// ---------------------------------------------------------------------------
async function onOrderDelivered(orderId) {
  const info = await remainingOnOrder(orderId);
  if (!info) return null;
  const { order, remaining } = info;

  // Fully billed already — a partial statement was raised earlier, or this is
  // the second time the order has been saved as delivered.
  if (remaining <= 0) return null;

  return createDraft({
    number: `INV-${order.order_number}`,
    customerName: order.customer_name,
    customerId: await customerIdFor(order.customer_name, order.customer_id),
    amount: remaining,
    orderId: order.id,
    projectId: order.project_id,
    source: "order delivered",
    sourceRef: order.order_number,
    notes: order.notes || null,
  });
}

// ---------------------------------------------------------------------------
// 2. A work order is completed.
// ---------------------------------------------------------------------------
async function onWorkOrderCompleted(workOrderId) {
  const wo = await db.prepare("SELECT * FROM work_orders WHERE id = ?").get(workOrderId);
  if (!wo) return null;

  // Already billed through its order — a work order under an order is part of
  // that order's value, not a charge of its own.
  if (wo.order_id) {
    const info = await remainingOnOrder(wo.order_id);
    if (!info || info.remaining <= 0) return null;
  }

  const already = await db
    .prepare("SELECT id FROM invoices WHERE auto_source = 'work order completed' AND auto_source_ref = ?")
    .get(wo.work_order_number);
  if (already) return null;

  const info = wo.order_id ? await remainingOnOrder(wo.order_id) : null;

  // A standalone work order carries no price — the table has no amount. Rather
  // than invent one, the draft is raised at zero with the job described on it,
  // so it appears in the review queue for somebody to price. A job that is
  // never billed because nobody wrote it down is the worse failure.
  return createDraft({
    number: `INV-${wo.work_order_number}`,
    customerName: wo.customer_name,
    customerId: await customerIdFor(wo.customer_name, wo.customer_id),
    amount: info ? info.remaining : 0,
    orderId: wo.order_id || null,
    projectId: wo.project_id || null,
    source: "work order completed",
    sourceRef: wo.work_order_number,
    notes: [wo.title, wo.description].filter(Boolean).join(" — ") || null,
    lines: info
      ? null
      : [{ description: wo.title || wo.work_order_number, quantity: 1, unit: "lot", unit_price: 0, amount: 0 }],
  });
}

// ---------------------------------------------------------------------------
// 3. A billable project task is completed.
// ---------------------------------------------------------------------------
async function onProjectMilestoneComplete(taskId) {
  const task = await db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(taskId);
  if (!task) return null;

  // Not a milestone, or already billed. billed_invoice_id is what stops a task
  // being re-opened and re-completed into a second statement.
  if (task.billable_amount === null || Number(task.billable_amount) <= 0) return null;
  if (task.billed_invoice_id) return null;

  const project = await db.prepare("SELECT * FROM projects WHERE id = ?").get(task.project_id);
  if (!project) return null;

  const draft = await createDraft({
    number: `INV-${project.code}-M${task.id}`,
    customerName: project.client_name || project.name,
    customerId: await customerIdFor(project.client_name, project.customer_id),
    amount: task.billable_amount,
    projectId: project.id,
    source: "project milestone",
    sourceRef: `${project.code} · ${task.name}`,
    notes: `Milestone: ${task.name}`,
    lines: [
      {
        description: `${task.name} (milestone)`,
        quantity: 1,
        unit: "lot",
        unit_price: task.billable_amount,
        amount: task.billable_amount,
      },
    ],
  });

  await db.prepare("UPDATE project_tasks SET billed_invoice_id = ? WHERE id = ?").run(draft.id, task.id);
  return draft;
}

// ---------------------------------------------------------------------------
// 4. A recurring schedule falls due.
// ---------------------------------------------------------------------------
function advance(dateStr, cadence) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const add = { weekly: 7, fortnightly: 14 }[cadence];
  if (add) {
    d.setUTCDate(d.getUTCDate() + add);
  } else if (cadence === "monthly") {
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else if (cadence === "quarterly") {
    d.setUTCMonth(d.getUTCMonth() + 3);
  } else {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  }
  return d.toISOString().slice(0, 10);
}

async function runSchedule(schedule) {
  const customer = await db.prepare("SELECT * FROM customers WHERE id = ?").get(schedule.customer_id);
  if (!customer) return null;

  // The lines carry forward from the statement this schedule last produced, so
  // an adjustment made at review repeats too. That cuts both ways: a one-off
  // charge added last period will come round again, which is why the draft
  // says on its face where its lines came from.
  const sourceId = schedule.last_invoice_id || schedule.source_invoice_id;
  const lines = sourceId
    ? await db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id").all(sourceId)
    : [];
  const source = sourceId ? await db.prepare("SELECT invoice_number, amount FROM invoices WHERE id = ?").get(sourceId) : null;

  const draft = await createDraft({
    number: `INV-${customer.name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 10).toUpperCase()}-${schedule.next_run_date}`,
    customerName: customer.name,
    customerId: customer.id,
    amount: lines.length ? 0 : Number(source?.amount || 0),
    projectId: schedule.project_id,
    source: "recurring schedule",
    sourceRef: schedule.description,
    notes: source
      ? `${schedule.description}. Lines copied from ${source.invoice_number} — check nothing one-off has carried over.`
      : schedule.description,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unit_price,
      amount: l.amount,
    })),
  });

  const next = advance(schedule.next_run_date, schedule.cadence);
  const finished = schedule.end_date && next > schedule.end_date;

  await db
    .prepare(
      `UPDATE billing_schedules SET next_run_date = ?, last_run_at = ?, last_invoice_id = ?, active = ? WHERE id = ?`
    )
    .run(next, nowStamp(), draft.id, finished ? false : schedule.active, schedule.id);

  return draft;
}

// Everything due, caught up one period at a time. A schedule that has not run
// for three months produces three statements rather than one, because three
// months of a retainer is three months of money.
async function runDueSchedules({ asOf } = {}) {
  const cutoff = asOf || today();
  const raised = [];

  for (let guard = 0; guard < 200; guard++) {
    const due = await db
      .prepare("SELECT * FROM billing_schedules WHERE active = true AND next_run_date <= ? ORDER BY next_run_date LIMIT 1")
      .get(cutoff);
    if (!due) break;
    if (due.end_date && due.next_run_date > due.end_date) {
      await db.prepare("UPDATE billing_schedules SET active = false WHERE id = ?").run(due.id);
      continue;
    }
    const draft = await runSchedule(due);
    if (draft) raised.push({ schedule_id: due.id, ...draft });
  }

  return raised;
}

// Never let a billing trigger take down the thing that fired it. Saving an
// order as delivered must succeed whether or not a statement could be raised.
function safely(fn, label) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[billing] ${label} failed:`, err.message);
      return null;
    }
  };
}

// Checked every fifteen minutes rather than once a day: an hourly tick finds
// its moment again after a restart, where a 24-hour timer set at boot drifts
// to whatever time the instance happened to wake up. runDueSchedules is
// idempotent by date, so a tick that finds nothing due costs one query.
function scheduleRecurringBilling() {
  if (process.env.RECURRING_BILLING_ENABLED === "false") {
    console.log("Recurring billing disabled (RECURRING_BILLING_ENABLED=false)");
    return;
  }
  const CHECK_EVERY_MS = 15 * 60 * 1000;
  console.log("Recurring billing armed — due schedules raise draft statements");
  const tick = () =>
    runDueSchedules()
      .then((raised) => {
        if (raised.length) {
          console.log(`Recurring billing raised ${raised.length} draft statement(s): ${raised.map((r) => r.invoice_number).join(", ")}`);
        }
      })
      .catch((err) => console.error("Recurring billing failed:", err.message));
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = {
  scheduleRecurringBilling,
  onOrderDelivered: safely(onOrderDelivered, "order delivered"),
  onWorkOrderCompleted: safely(onWorkOrderCompleted, "work order completed"),
  onProjectMilestoneComplete: safely(onProjectMilestoneComplete, "project milestone"),
  runDueSchedules,
  runSchedule,
  advance,
};
