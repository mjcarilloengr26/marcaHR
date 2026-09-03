const db = require("../db");
const { getProfitLoss } = require("./profitLoss");
const { staleDealDays } = require("./dealAging");

// The review keeps its own period maths rather than widening the shared helper
// that four other surfaces depend on — a sales target has no use for these.
const PERIOD_TYPES = ["monthly", "quarterly", "yearly"];

function reviewPeriod(type, year, index) {
  if (type === "yearly") {
    return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year), months: [1, 12] };
  }
  const startMonth = type === "quarterly" ? (index - 1) * 3 + 1 : index;
  const endMonth = type === "quarterly" ? startMonth + 2 : startMonth;
  const lastDay = new Date(year, endMonth, 0).getDate();
  const MONTHS = ["", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return {
    start: `${year}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    label: type === "quarterly" ? `Q${index} ${year}` : `${MONTHS[index]} ${year}`,
    months: [startMonth, endMonth],
  };
}

// The period immediately before this one, of the same length — what "up 12%"
// is measured against.
function previousPeriod(type, year, index) {
  if (type === "yearly") return { year: year - 1, index: 0 };
  if (type === "quarterly") return index > 1 ? { year, index: index - 1 } : { year: year - 1, index: 4 };
  return index > 1 ? { year, index: index - 1 } : { year: year - 1, index: 12 };
}

const num = (v) => Number(v || 0);

// Every figure for one date range. Called twice — once for the period under
// review and once for the one before it — so movement is measured rather than
// asserted.
async function metricsFor({ start, end, year, months }) {
  const [startMonth, endMonth] = months;

  const [
    opportunities, pipeline, orders, invoices, purchases, expenses,
    payrollRow, leave, attendance, assets, workOrders, pnl,
  ] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*)::int AS created,
              COUNT(*) FILTER (WHERE stage = 'won')::int AS won,
              COUNT(*) FILTER (WHERE stage = 'lost')::int AS lost,
              COALESCE(SUM(value) FILTER (WHERE stage = 'won'), 0) AS won_value,
              COALESCE(SUM(value), 0) AS created_value
       FROM deals WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`
    ).get(start, end),

    // Pipeline is a position, not a flow — it is whatever is open right now,
    // so it carries no comparison against the previous period.
    db.prepare(
      `SELECT COUNT(*)::int AS open_count, COALESCE(SUM(value), 0) AS open_value
       FROM deals WHERE stage NOT IN ('won', 'lost')`
    ).get(),

    db.prepare(
      `SELECT COUNT(*)::int AS placed, COALESCE(SUM(amount), 0) AS value,
              COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered
       FROM orders WHERE status <> 'cancelled' AND order_date BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(*)::int AS issued, COALESCE(SUM(amount), 0) AS issued_value,
              COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_value,
              COALESCE(SUM(amount) FILTER (WHERE status IN ('sent', 'overdue')), 0) AS outstanding_value,
              COUNT(*) FILTER (WHERE status = 'overdue')::int AS overdue_count
       FROM invoices WHERE status <> 'cancelled' AND issue_date BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(*)::int AS raised, COALESCE(SUM(amount), 0) AS value,
              COUNT(*) FILTER (WHERE status = 'received')::int AS received,
              COALESCE(SUM(amount) FILTER (WHERE work_order_id IS NULL), 0) AS unlinked_value
       FROM purchase_orders WHERE status NOT IN ('cancelled', 'draft') AND order_date BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(DISTINCT r.id)::int AS reports,
              COALESCE(SUM(r.cash_advance_amount), 0) AS advances,
              COALESCE((SELECT SUM(ei.amount) FROM expense_items ei
                        JOIN expense_reports er ON er.id = ei.report_id
                        WHERE ei.expense_date BETWEEN ? AND ?), 0) AS spent
       FROM expense_reports r WHERE substr(r.created_at, 1, 10) BETWEEN ? AND ?`
    ).get(start, end, start, end),

    db.prepare(
      `SELECT COALESCE(SUM(net_pay), 0) AS net_pay, COUNT(DISTINCT employee_id)::int AS people
       FROM payroll_records
       WHERE status IN ('finalized', 'paid') AND period_year = ? AND period_month BETWEEN ? AND ?`
    ).get(year, startMonth, endMonth),

    db.prepare(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0) AS approved_days
       FROM leave_requests WHERE start_date BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(*)::int AS records,
              COUNT(*) FILTER (WHERE status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE status = 'late')::int AS late,
              COUNT(*) FILTER (WHERE status = 'absent')::int AS absent
       FROM attendance WHERE date BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(*)::int AS issued, COALESCE(SUM(market_value), 0) AS issued_value
       FROM employee_assets WHERE date_issued BETWEEN ? AND ?`
    ).get(start, end),

    db.prepare(
      `SELECT COUNT(*)::int AS opened,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM work_orders WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`
    ).get(start, end),

    getProfitLoss({ start, end, periodYear: year, startMonth, endMonth }),
  ]);

  const winRate =
    opportunities.won + opportunities.lost > 0
      ? (opportunities.won / (opportunities.won + opportunities.lost)) * 100
      : null;

  const collectionRate =
    num(invoices.issued_value) > 0 ? (num(invoices.paid_value) / num(invoices.issued_value)) * 100 : null;

  const liquidationRate =
    num(expenses.advances) > 0 ? (num(expenses.spent) / num(expenses.advances)) * 100 : null;

  return {
    sales: {
      opportunitiesCreated: opportunities.created,
      createdValue: num(opportunities.created_value),
      won: opportunities.won,
      wonValue: num(opportunities.won_value),
      lost: opportunities.lost,
      winRatePercent: winRate,
      openPipelineCount: pipeline.open_count,
      openPipelineValue: num(pipeline.open_value),
    },
    revenue: {
      ordersPlaced: orders.placed,
      ordersValue: num(orders.value),
      ordersDelivered: orders.delivered,
      invoicesIssued: invoices.issued,
      invoicedValue: num(invoices.issued_value),
      collectedValue: num(invoices.paid_value),
      outstandingValue: num(invoices.outstanding_value),
      overdueInvoices: invoices.overdue_count,
      collectionRatePercent: collectionRate,
    },
    profitAndLoss: pnl,
    procurement: {
      purchaseOrdersRaised: purchases.raised,
      purchaseValue: num(purchases.value),
      received: purchases.received,
      spendNotLinkedToAJob: num(purchases.unlinked_value),
    },
    expenses: {
      reportsRaised: expenses.reports,
      cashAdvanced: num(expenses.advances),
      spent: num(expenses.spent),
      liquidationRatePercent: liquidationRate,
    },
    payroll: { netPay: num(payrollRow.net_pay), peoplePaid: payrollRow.people },
    workforce: {
      leaveRequests: leave.requests,
      leaveDaysApproved: num(leave.approved_days),
      attendanceRecords: attendance.records,
      present: attendance.present,
      late: attendance.late,
      absent: attendance.absent,
    },
    assets: { issued: assets.issued, issuedValue: num(assets.issued_value) },
    delivery: { workOrdersOpened: workOrders.opened, workOrdersCompleted: workOrders.completed },
  };
}

// Figures that describe the whole business as it stands today, independent of
// which period is being reviewed.
async function standingPosition() {
  const threshold = await staleDealDays();
  const [stale, inventory, assetsOut, requests, headcount, receivables] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(value), 0) AS value
       FROM deals
       WHERE stage NOT IN ('won', 'lost')
         AND (CURRENT_DATE - substr(COALESCE(stage_changed_at, created_at), 1, 10)::date) >= ?`
    ).get(threshold),
    db.prepare(
      `SELECT COUNT(*)::int AS items,
              COALESCE(SUM(quantity_on_hand * unit_cost), 0) AS stock_value,
              COUNT(*) FILTER (WHERE reorder_level > 0 AND quantity_on_hand <= reorder_level)::int AS at_reorder
       FROM inventory_items`
    ).get(),
    db.prepare(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(market_value), 0) AS value
       FROM employee_assets WHERE status = 'active'`
    ).get(),
    db.prepare("SELECT COUNT(*)::int AS pending FROM asset_requests WHERE status = 'pending'").get(),
    db.prepare("SELECT COUNT(*)::int AS active FROM employees WHERE status = 'active'").get(),
    db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS outstanding,
              COALESCE(SUM(amount) FILTER (WHERE status = 'overdue'), 0) AS overdue
       FROM invoices WHERE status IN ('sent', 'overdue')`
    ).get(),
  ]);

  return {
    staleThresholdDays: threshold,
    stalledOpportunities: { count: stale.count, value: num(stale.value) },
    inventory: { items: inventory.items, stockValue: num(inventory.stock_value), atReorderLevel: inventory.at_reorder },
    assetsStillIssued: { count: assetsOut.count, value: num(assetsOut.value) },
    pendingAssetRequests: requests.pending,
    activeHeadcount: headcount.active,
    receivables: { outstanding: num(receivables.outstanding), overdue: num(receivables.overdue) },
  };
}

// Assembles the whole fact sheet. This is what the narrative layer reads — it
// never sees a raw row, so it can only interpret figures the app already
// stands behind.
async function buildFactSheet({ periodType, year, index }) {
  if (!PERIOD_TYPES.includes(periodType)) {
    throw new Error(`period_type must be one of ${PERIOD_TYPES.join(", ")}`);
  }
  const current = reviewPeriod(periodType, year, index);
  const prevRef = previousPeriod(periodType, year, index);
  const previous = reviewPeriod(periodType, prevRef.year, prevRef.index);

  const [now, before, standing] = await Promise.all([
    metricsFor({ start: current.start, end: current.end, year, months: current.months }),
    metricsFor({ start: previous.start, end: previous.end, year: prevRef.year, months: previous.months }),
    standingPosition(),
  ]);

  return {
    period: { type: periodType, year, index, label: current.label, start: current.start, end: current.end },
    comparedWith: { label: previous.label, start: previous.start, end: previous.end },
    current: now,
    previous: before,
    standing,
    // Stated plainly so the narrative layer can say "too little happened to
    // draw a conclusion" instead of inventing a trend from three events.
    dataVolume: {
      eventsThisPeriod:
        now.sales.opportunitiesCreated + now.revenue.ordersPlaced + now.revenue.invoicesIssued +
        now.procurement.purchaseOrdersRaised + now.expenses.reportsRaised + now.delivery.workOrdersOpened,
      eventsPreviousPeriod:
        before.sales.opportunitiesCreated + before.revenue.ordersPlaced + before.revenue.invoicesIssued +
        before.procurement.purchaseOrdersRaised + before.expenses.reportsRaised + before.delivery.workOrdersOpened,
    },
  };
}

module.exports = { buildFactSheet, reviewPeriod, previousPeriod, PERIOD_TYPES };
