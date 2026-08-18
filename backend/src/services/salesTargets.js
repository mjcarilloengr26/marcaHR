const db = require("../db");
const { appTimezone } = require("./timezone");

// Sales targets: a revenue goal per employee for a monthly, quarterly, or yearly
// period, tracked against actual achieved (won deal value + non-cancelled order
// amount) within that date range — dated by expected_close_date for deals and
// order_date for orders, since neither table tracks a separate "actually closed
// on" timestamp. period_index is the month (1-12) for monthly, quarter (1-4) for
// quarterly, or unused (0) for yearly.
//
// Orders auto-created from a won deal (orders.deal_id set — the only place that
// happens is autoCreateOrderForWonDeal in deals.routes.js) carry the same amount
// as the deal that spawned them, so they're excluded from the order sum below —
// otherwise a won opportunity's value would be counted twice (once as the deal,
// once as its auto-created order).
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

// Shared by the /sales/targets route and the sales/finance Excel export, so both
// surfaces stay in agreement on what "actual" and "leads" mean for a period.
async function getSalesTargetsReport({ period_type, period_year, period_index }) {
  const { start, end } = periodDateRange(period_type, period_year, period_index);

  // Include anyone who already owns a deal/order or has a target for this period (as
  // before), plus every active employee in the Sales department — so a newly hired
  // sales rep shows up (ready to get a target set) even before they own anything yet.
  const employeeIds = (
    await db
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
  ).map((r) => r.id);

  const wonByOwner = (
    await db
      .prepare(
        `SELECT owner_id, COALESCE(SUM(value), 0) AS v FROM deals
       WHERE stage = 'won' AND owner_id IS NOT NULL AND expected_close_date BETWEEN ? AND ?
       GROUP BY owner_id`
      )
      .all(start, end)
  ).reduce((acc, r) => ({ ...acc, [r.owner_id]: r.v }), {});

  const orderByOwner = (
    await db
      .prepare(
        `SELECT owner_id, COALESCE(SUM(amount), 0) AS v FROM orders
       WHERE status != 'cancelled' AND owner_id IS NOT NULL AND deal_id IS NULL AND order_date BETWEEN ? AND ?
       GROUP BY owner_id`
      )
      .all(start, end)
  ).reduce((acc, r) => ({ ...acc, [r.owner_id]: r.v }), {});

  const targets = (
    await db.prepare("SELECT * FROM sales_targets WHERE period_type = ? AND period_year = ? AND period_index = ?").all(
      period_type,
      period_year,
      period_index
    )
  ).reduce((acc, r) => ({ ...acc, [r.employee_id]: r }), {});

  // Lead summary per rep — every opportunity they own, any stage, bucketed by
  // when it was created (not period-scoped like actual_amount, since "how
  // many leads is this rep carrying" isn't a per-period achievement metric).
  // created_at is stored as UTC; bucketing uses the Manila wall-clock date so
  // it agrees with everywhere else in the app that's anchored to GMT+8.
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: await appTimezone(),
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
  const ownerDeals = await db.prepare("SELECT owner_id, value, created_at FROM deals WHERE owner_id IS NOT NULL").all();
  for (const d of ownerDeals) {
    const manilaYM = new Intl.DateTimeFormat("en-CA", { timeZone: await appTimezone(), year: "numeric", month: "2-digit" })
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

  const rows = [];
  for (const id of employeeIds) {
    const employee = await db.prepare("SELECT first_name, last_name FROM employees WHERE id = ?").get(id);
    const actual = (wonByOwner[id] || 0) + (orderByOwner[id] || 0);
    const target = targets[id]?.target_amount || 0;
    const leadSummary = leadSummaryByOwner[id] || {
      monthly: emptyBucket(),
      quarterly: emptyBucket(),
      annually: emptyBucket(),
      total: emptyBucket(),
    };
    rows.push({
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
    });
  }

  rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  return rows;
}

module.exports = { getSalesTargetsReport, periodDateRange, parsePeriod };
