const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won"];
const ORDER_STATUSES = ["placed", "processing", "shipped", "delivered"];

// Builds cumulative funnel counts from a flat {status: count} map: each stage counts
// records currently at that stage or further along (current-stage snapshot, not
// history — the honest reading of data that only stores a record's current stage).
// The terminal outcome (lost/cancelled) is excluded from the pipeline bars entirely
// and reported separately, since it's a branch-off rather than a pipeline stage.
function buildFunnel(counts, order, labels, terminalKey, terminalLabel) {
  const stages = order.map((key, i) => ({
    key,
    label: labels[key],
    count: order.slice(i).reduce((sum, k) => sum + (counts[k] || 0), 0),
  }));
  return { stages, [terminalKey]: counts[terminalKey] || 0, terminalLabel };
}

router.get("/stats", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const dealCounts = db
    .prepare("SELECT stage, COUNT(*) AS c FROM deals GROUP BY stage")
    .all()
    .reduce((acc, row) => ({ ...acc, [row.stage]: row.c }), {});

  const dealStageLabels = {
    lead: "Lead",
    qualified: "Qualified",
    proposal: "Proposal",
    negotiation: "Negotiation",
    won: "Won",
  };
  const dealFunnel = buildFunnel(dealCounts, DEAL_STAGES, dealStageLabels, "lost", "Lost");

  const orderCounts = db
    .prepare("SELECT status, COUNT(*) AS c FROM orders GROUP BY status")
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.c }), {});
  const orderStatusLabels = { placed: "Placed", processing: "Processing", shipped: "Shipped", delivered: "Delivered" };
  const orderFunnel = buildFunnel(orderCounts, ORDER_STATUSES, orderStatusLabels, "cancelled", "Cancelled");

  const pipelineValue = db
    .prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage NOT IN ('won', 'lost')")
    .get().v;
  const wonValue = db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'won'").get().v;
  const openDeals = db.prepare("SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won', 'lost')").get().c;

  const ordersRevenue = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled'")
    .get().v;
  const ordersThisMonth = db
    .prepare("SELECT COUNT(*) AS c FROM orders WHERE strftime('%Y-%m', order_date) = strftime('%Y-%m', 'now')")
    .get().c;

  res.json({
    dealFunnel,
    orderFunnel,
    kpis: { pipelineValue, wonValue, openDeals, ordersRevenue, ordersThisMonth },
  });
});

// Sales targets: a revenue goal per employee for a monthly, quarterly, or yearly
// period, tracked against actual achieved (won deal value + non-cancelled order
// amount) within that date range — dated by expected_close_date for deals and
// order_date for orders, since neither table tracks a separate "actually closed
// on" timestamp. period_index is the month (1-12) for monthly, quarter (1-4) for
// quarterly, or unused (0) for yearly.
function periodDateRange(periodType, year, index) {
  if (periodType === "yearly") {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const startMonth = periodType === "quarterly" ? (index - 1) * 3 + 1 : index;
  const endMonth = periodType === "quarterly" ? startMonth + 2 : startMonth;
  const lastDay = new Date(year, endMonth, 0).getDate();
  return {
    start: `${year}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

function parsePeriod(query) {
  const period_type = ["monthly", "quarterly", "yearly"].includes(query.period_type) ? query.period_type : "monthly";
  const period_year = Number(query.year) || new Date().getFullYear();
  let period_index = Number(query.index);
  if (!Number.isFinite(period_index)) {
    if (period_type === "monthly") period_index = new Date().getMonth() + 1;
    else if (period_type === "quarterly") period_index = Math.floor(new Date().getMonth() / 3) + 1;
    else period_index = 0;
  }
  return { period_type, period_year, period_index };
}

router.get("/targets", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { period_type, period_year, period_index } = parsePeriod(req.query);
  const { start, end } = periodDateRange(period_type, period_year, period_index);

  // Include anyone who already owns a deal/order or has a target for this period (as
  // before), plus every active employee in the Sales department — so a newly hired
  // sales rep shows up (ready to get a target set) even before they own anything yet.
  const employeeIds = db
    .prepare(
      `SELECT DISTINCT owner_id AS id FROM deals WHERE owner_id IS NOT NULL
       UNION SELECT DISTINCT owner_id AS id FROM orders WHERE owner_id IS NOT NULL
       UNION SELECT employee_id AS id FROM sales_targets
         WHERE period_type = ? AND period_year = ? AND period_index = ?
       UNION SELECT e.id AS id FROM employees e
         JOIN departments d ON d.id = e.department_id
         WHERE LOWER(d.name) = 'sales' AND e.status = 'active'`
    )
    .all(period_type, period_year, period_index)
    .map((r) => r.id);

  const wonByOwner = db
    .prepare(
      `SELECT owner_id, COALESCE(SUM(value), 0) AS v FROM deals
       WHERE stage = 'won' AND owner_id IS NOT NULL AND expected_close_date BETWEEN ? AND ?
       GROUP BY owner_id`
    )
    .all(start, end)
    .reduce((acc, r) => ({ ...acc, [r.owner_id]: r.v }), {});

  const orderByOwner = db
    .prepare(
      `SELECT owner_id, COALESCE(SUM(amount), 0) AS v FROM orders
       WHERE status != 'cancelled' AND owner_id IS NOT NULL AND order_date BETWEEN ? AND ?
       GROUP BY owner_id`
    )
    .all(start, end)
    .reduce((acc, r) => ({ ...acc, [r.owner_id]: r.v }), {});

  const targets = db
    .prepare("SELECT * FROM sales_targets WHERE period_type = ? AND period_year = ? AND period_index = ?")
    .all(period_type, period_year, period_index)
    .reduce((acc, r) => ({ ...acc, [r.employee_id]: r }), {});

  // Lead summary per rep — every opportunity they own, any stage, bucketed by
  // when it was created (not period-scoped like actual_amount, since "how
  // many leads is this rep carrying" isn't a per-period achievement metric).
  // created_at is stored as UTC; bucketing uses the Manila wall-clock date so
  // it agrees with everywhere else in the app that's anchored to GMT+8.
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .split("-")
    .map(Number);
  const [currentYear, currentMonth] = nowParts;
  const currentQuarter = Math.floor((currentMonth - 1) / 3) + 1;

  const emptyBucket = () => ({ count: 0, value: 0 });
  const leadSummaryByOwner = {};
  for (const d of db.prepare("SELECT owner_id, value, created_at FROM deals WHERE owner_id IS NOT NULL").all()) {
    const manilaYM = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" })
      .format(new Date(`${d.created_at.replace(" ", "T")}Z`))
      .split("-")
      .map(Number);
    const [y, m] = manilaYM;
    const q = Math.floor((m - 1) / 3) + 1;

    if (!leadSummaryByOwner[d.owner_id]) {
      leadSummaryByOwner[d.owner_id] = {
        monthly: emptyBucket(),
        quarterly: emptyBucket(),
        annually: emptyBucket(),
        total: emptyBucket(),
      };
    }
    const s = leadSummaryByOwner[d.owner_id];
    s.total.count += 1;
    s.total.value += d.value;
    if (y === currentYear) {
      s.annually.count += 1;
      s.annually.value += d.value;
      if (q === currentQuarter) {
        s.quarterly.count += 1;
        s.quarterly.value += d.value;
        if (m === currentMonth) {
          s.monthly.count += 1;
          s.monthly.value += d.value;
        }
      }
    }
  }

  const rows = employeeIds.map((id) => {
    const employee = db.prepare("SELECT first_name, last_name FROM employees WHERE id = ?").get(id);
    const actual = (wonByOwner[id] || 0) + (orderByOwner[id] || 0);
    const target = targets[id]?.target_amount || 0;
    const leadSummary = leadSummaryByOwner[id] || {
      monthly: emptyBucket(),
      quarterly: emptyBucket(),
      annually: emptyBucket(),
      total: emptyBucket(),
    };
    return {
      employee_id: id,
      employee_name: employee ? `${employee.first_name} ${employee.last_name}` : "Unknown",
      target_id: targets[id]?.id || null,
      target_amount: target,
      actual_amount: actual,
      percent: target > 0 ? Math.round((actual / target) * 100) : null,
      monthly_leads: leadSummary.monthly.count,
      monthly_lead_value: leadSummary.monthly.value,
      quarterly_leads: leadSummary.quarterly.count,
      quarterly_lead_value: leadSummary.quarterly.value,
      annual_leads: leadSummary.annually.count,
      annual_lead_value: leadSummary.annually.value,
      total_leads: leadSummary.total.count,
      total_lead_value: leadSummary.total.value,
    };
  });

  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  res.json(rows);
});

router.post("/targets", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { employee_id, period_type, period_year, period_index, target_amount } = req.body || {};
  if (!employee_id || !period_type || !period_year || target_amount === undefined) {
    return res.status(400).json({ error: "employee_id, period_type, period_year and target_amount are required" });
  }
  if (!["monthly", "quarterly", "yearly"].includes(period_type)) {
    return res.status(400).json({ error: "period_type must be monthly, quarterly or yearly" });
  }
  const index = period_type === "yearly" ? 0 : Number(period_index) || 0;
  db.prepare(
    `INSERT INTO sales_targets (employee_id, period_type, period_year, period_index, target_amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, period_type, period_year, period_index) DO UPDATE SET target_amount = excluded.target_amount`
  ).run(employee_id, period_type, period_year, index, Number(target_amount) || 0);
  res.status(201).json(
    db
      .prepare("SELECT * FROM sales_targets WHERE employee_id = ? AND period_type = ? AND period_year = ? AND period_index = ?")
      .get(employee_id, period_type, period_year, index)
  );
});

router.delete("/targets/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  db.prepare("DELETE FROM sales_targets WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
