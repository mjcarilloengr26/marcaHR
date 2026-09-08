const db = require("../db");
const { COUNTED_SQL } = require("./expenseScope");

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What a project cost, what it billed, and how far through its plan it is.
//
// Lives in a service rather than in the route because three screens read the
// same figures — the Projects list, the Gantt header and the Snapshot band —
// and a second copy of these joins is exactly how the counted-status filter
// drifted between the dashboard and the cash-advance balance before
// expenseScope was written. There is one copy from the start this time.
//
// Every rule here is borrowed rather than invented, so a project's numbers add
// up to the company's:
//   - expense spend uses expenseScope's counted statuses, so a draft receipt
//     does not eat a project's margin before anyone has claimed it;
//   - procurement uses the same `NOT IN ('cancelled','draft')` filter the
//     Business Review's procurement figure uses;
//   - invoiced excludes drafts, which is the rule the unsent-invoice figure on
//     the Snapshot already depends on.

const SPEND_SQL = `
  SELECT r.project_id, COALESCE(SUM(i.amount), 0) AS spent, COUNT(DISTINCT r.id)::int AS reports
  FROM expense_reports r
  JOIN expense_items i ON i.report_id = r.id
  WHERE r.project_id IS NOT NULL AND r.status IN ${COUNTED_SQL}
  GROUP BY r.project_id`;

const PROCUREMENT_SQL = `
  SELECT project_id, COALESCE(SUM(amount), 0) AS spent, COUNT(*)::int AS purchase_orders
  FROM purchase_orders
  WHERE project_id IS NOT NULL AND status NOT IN ('cancelled', 'draft')
  GROUP BY project_id`;

const BILLING_SQL = `
  SELECT project_id,
         COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('draft', 'cancelled')), 0) AS invoiced,
         COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS collected,
         COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_invoices
  FROM invoices
  WHERE project_id IS NOT NULL
  GROUP BY project_id`;

const ORDERS_SQL = `
  SELECT project_id,
         COUNT(*)::int AS orders,
         COALESCE(SUM(amount) FILTER (WHERE status <> 'cancelled'), 0) AS ordered
  FROM orders
  WHERE project_id IS NOT NULL
  GROUP BY project_id`;

const DELIVERY_SQL = `
  SELECT project_id,
         COUNT(*)::int AS work_orders,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS work_orders_done
  FROM work_orders
  WHERE project_id IS NOT NULL
  GROUP BY project_id`;

// Progress is weighted by how long each task runs, not by how many there are:
// a two-day sign-off and a six-week installation are not half the project each.
//
// Only leaf tasks count. A phase row exists to group its children, so counting
// both would weigh the same work twice — once in the phase and once in every
// task inside it.
const TASK_SQL = `
  SELECT t.project_id,
         COUNT(*)::int AS tasks,
         COUNT(*) FILTER (WHERE t.percent_complete >= 100)::int AS tasks_done,
         COUNT(*) FILTER (WHERE t.percent_complete < 100 AND t.end_date < ?)::int AS tasks_overdue,
         COALESCE(SUM(t.end_date::date - t.start_date::date + 1), 0) AS weight,
         COALESCE(SUM((t.end_date::date - t.start_date::date + 1) * t.percent_complete), 0) AS weighted,
         MIN(t.start_date) AS first_start,
         MAX(t.end_date) AS last_end
  FROM project_tasks t
  WHERE NOT EXISTS (SELECT 1 FROM project_tasks c WHERE c.parent_id = t.id)
  GROUP BY t.project_id`;

const PROJECT_SQL = `
  SELECT p.*,
         (o.first_name || ' ' || o.last_name) AS owner_name,
         c.name AS cost_center_name
  FROM projects p
  LEFT JOIN employees o ON o.id = p.owner_id
  LEFT JOIN cost_centers c ON c.id = p.cost_center_id
  ORDER BY
    CASE p.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'on_hold' THEN 2
                  WHEN 'completed' THEN 3 ELSE 4 END,
    COALESCE(p.start_date, p.created_at)`;

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// How a project is doing against its own dates, which is a different question
// from how it is doing against its budget — a job can be perfectly on schedule
// and still be losing money, and saying so in one word would hide one of them.
//
// "Behind" is deliberately a gap between two percentages rather than a missed
// date: waiting for the target date to pass before admitting a project is in
// trouble reports the problem on the day it is too late to act on it.
const BEHIND_BY_POINTS = 15;

function schedule(project, progressPercent, today) {
  if (project.status === "cancelled") return { key: "cancelled", label: "Cancelled", tone: "muted" };
  if (project.status === "completed") return { key: "done", label: "Completed", tone: "good" };
  if (project.status === "on_hold") return { key: "on_hold", label: "On hold", tone: "warn" };
  if (!project.start_date || !project.target_end_date) {
    return { key: "undated", label: "No dates set", tone: "muted" };
  }
  if (project.target_end_date < today) {
    return { key: "overdue", label: `${dayDiff(today, project.target_end_date)} days past target`, tone: "bad" };
  }
  if (project.start_date > today) return { key: "not_started", label: "Not started", tone: "muted" };

  const span = dayDiff(project.target_end_date, project.start_date) + 1;
  const elapsed = Math.min(100, Math.round(((dayDiff(today, project.start_date) + 1) / span) * 100));
  // Nothing planned yet means nothing to measure against. Reporting 0% progress
  // for a project whose schedule has simply not been entered would paint an
  // untouched plan as a failing one.
  if (progressPercent === null) return { key: "unplanned", label: "No tasks scheduled", tone: "muted" };
  if (elapsed - progressPercent > BEHIND_BY_POINTS) {
    return { key: "behind", label: `${elapsed - progressPercent} points behind plan`, tone: "warn", elapsed };
  }
  return { key: "on_track", label: "On track", tone: "good", elapsed };
}

async function withRollup(today = new Date().toISOString().slice(0, 10)) {
  const [projects, spend, procurement, billing, delivery, tasks, orders] = await Promise.all([
    db.prepare(PROJECT_SQL).all(),
    db.prepare(SPEND_SQL).all(),
    db.prepare(PROCUREMENT_SQL).all(),
    db.prepare(BILLING_SQL).all(),
    db.prepare(DELIVERY_SQL).all(),
    db.prepare(TASK_SQL).all(today),
    db.prepare(ORDERS_SQL).all(),
  ]);

  const byId = (rows) => new Map(rows.map((r) => [r.project_id, r]));
  const spendBy = byId(spend);
  const procBy = byId(procurement);
  const billBy = byId(billing);
  const delivBy = byId(delivery);
  const taskBy = byId(tasks);
  const orderBy = byId(orders);

  return projects.map((p) => {
    const e = spendBy.get(p.id);
    const po = procBy.get(p.id);
    const b = billBy.get(p.id);
    const d = delivBy.get(p.id);
    const t = taskBy.get(p.id);
    const ord = orderBy.get(p.id);

    const expenseSpend = money(e ? e.spent : 0);
    const procurementSpend = money(po ? po.spent : 0);
    const spent = money(expenseSpend + procurementSpend);
    const contract = money(p.contract_value);
    const invoiced = money(b ? b.invoiced : 0);
    const collected = money(b ? b.collected : 0);

    const weight = t ? Number(t.weight) : 0;
    const progressPercent = weight > 0 ? Math.round(Number(t.weighted) / weight) : null;
    const sched = schedule(p, progressPercent, today);

    return {
      ...p,
      contract_value: contract,
      spend: { expenses: expenseSpend, procurement: procurementSpend, total: spent },
      reports: e ? e.reports : 0,
      purchaseOrders: po ? po.purchase_orders : 0,
      billing: {
        invoiced,
        collected,
        uninvoiced: money(contract - invoiced),
        draftInvoices: b ? b.draft_invoices : 0,
      },
      delivery: { workOrders: d ? d.work_orders : 0, completed: d ? d.work_orders_done : 0 },
      // What has actually been ordered against the job, next to what the
      // contract says it is worth. The two are allowed to differ — a signed
      // contract is not always the sum of the order records, and a project in
      // planning has a value before it has a single order — but a difference
      // nobody can see is one that quietly makes the margin wrong, so the
      // register shows it rather than reconciling it silently.
      orders: {
        count: ord ? ord.orders : 0,
        value: money(ord ? ord.ordered : 0),
        differsFromContract: Boolean(ord && Math.abs(money(ord.ordered) - contract) >= 0.01),
      },
      margin: money(contract - spent),
      // Null rather than 0 when nothing was sold: a project with no contract
      // value has an unknown margin, not a break-even one, and 0% reads as the
      // second thing.
      marginPercent: contract > 0 ? Math.round(((contract - spent) / contract) * 1000) / 10 : null,
      overSpend: contract > 0 && spent > contract,
      spentPercent: contract > 0 ? Math.round((spent / contract) * 1000) / 10 : null,
      tasks: {
        total: t ? t.tasks : 0,
        done: t ? t.tasks_done : 0,
        overdue: t ? t.tasks_overdue : 0,
        firstStart: t ? t.first_start : null,
        lastEnd: t ? t.last_end : null,
      },
      progressPercent,
      schedule: sched,
      // The plan running past the date the project was promised for. Worth its
      // own flag: the schedule above reads "on track" right up until the last
      // task slips, and this catches the case where the plan itself already
      // does not fit.
      planOverrunsTarget: Boolean(t && p.target_end_date && t.last_end > p.target_end_date),
    };
  });
}

// The Snapshot's one-line version: enough for a wall panel to say whether the
// project book is healthy, without listing every job on it.
async function projectRollup(today = new Date().toISOString().slice(0, 10)) {
  const rows = await withRollup(today);
  const live = rows.filter((p) => p.status === "active" || p.status === "planned" || p.status === "on_hold");
  const atRisk = live.filter((p) => p.schedule.key === "overdue" || p.schedule.key === "behind" || p.overSpend);

  return {
    total: rows.length,
    active: rows.filter((p) => p.status === "active").length,
    completed: rows.filter((p) => p.status === "completed").length,
    contractValue: money(live.reduce((n, p) => n + p.contract_value, 0)),
    spent: money(live.reduce((n, p) => n + p.spend.total, 0)),
    invoiced: money(live.reduce((n, p) => n + p.billing.invoiced, 0)),
    margin: money(live.reduce((n, p) => n + p.margin, 0)),
    atRisk: atRisk.length,
    onTrack: live.filter((p) => p.schedule.key === "on_track").length,
    // Whichever live project is furthest along, for the wins strip.
    mostAdvanced: live
      .filter((p) => p.progressPercent !== null)
      .sort((a, b) => b.progressPercent - a.progressPercent)[0] || null,
  };
}

module.exports = { withRollup, projectRollup, schedule, money };
