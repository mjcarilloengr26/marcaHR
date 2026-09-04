const express = require("express");
const { COUNTED_SQL } = require("../services/expenseScope");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { appTimezone } = require("../services/timezone");
const { getSalesTargetsReport, parsePeriod, periodDateRange } = require("../services/salesTargets");
const { getProfitLoss } = require("../services/profitLoss");
const { logRequestEvent } = require("../services/auditLog");

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

router.get(
  "/stats",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    // Every query below is independent, so they're issued together instead of
    // awaited one at a time — against a hosted database the sequential version
    // cost the sum of ~10 round-trips rather than roughly one.
    const todayManila = new Date().toLocaleDateString("en-CA", { timeZone: await appTimezone() });
    const [todayYear, todayMonth, todayDay] = todayManila.split("-");
    const lastYear = String(Number(todayYear) - 1);

    const [
      dealCountRows,
      orderCountRows,
      pipelineValueRow,
      wonValueRow,
      openDealsRow,
      ordersRevenueRow,
      ordersThisMonthRow,
      orderBacklog,
      ytdThisYearRow,
      ytdLastYearRow,
    ] = await Promise.all([
      db.prepare("SELECT stage, COUNT(*) AS c FROM deals GROUP BY stage").all(),
      db.prepare("SELECT status, COUNT(*) AS c FROM orders GROUP BY status").all(),
      db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage NOT IN ('won', 'lost')").get(),
      db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'won'").get(),
      db.prepare("SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won', 'lost')").get(),
      db.prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled'").get(),
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM orders WHERE to_char(order_date::date, 'YYYY-MM') = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')"
        )
        .get(),
      db
        .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS v FROM orders WHERE status NOT IN ('delivered', 'cancelled')")
        .get(),
      db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled' AND order_date BETWEEN ? AND ?")
        .get(`${todayYear}-01-01`, todayManila),
      db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled' AND order_date BETWEEN ? AND ?")
        .get(`${lastYear}-01-01`, `${lastYear}-${todayMonth}-${todayDay}`),
    ]);

    const dealCounts = dealCountRows.reduce((acc, row) => ({ ...acc, [row.stage]: row.c }), {});

    const dealStageLabels = {
      lead: "Lead",
      qualified: "Qualified",
      proposal: "Proposal",
      negotiation: "Negotiation",
      won: "Won",
    };
    const dealFunnel = buildFunnel(dealCounts, DEAL_STAGES, dealStageLabels, "lost", "Lost");

    const orderCounts = orderCountRows.reduce((acc, row) => ({ ...acc, [row.status]: row.c }), {});
    const orderStatusLabels = { placed: "Placed", processing: "Processing", shipped: "Shipped", delivered: "Delivered" };
    const orderFunnel = buildFunnel(orderCounts, ORDER_STATUSES, orderStatusLabels, "cancelled", "Cancelled");

    const pipelineValue = pipelineValueRow.v;
    const wonValue = wonValueRow.v;
    const openDeals = openDealsRow.c;

    // Win rate: won opportunities as a share of every opportunity that's actually
    // been decided (won + lost) — open/in-progress deals are excluded since they
    // haven't been won OR lost yet and would just water down the rate.
    const wonDeals = dealCounts.won || 0;
    const lostDeals = dealCounts.lost || 0;
    const closedDeals = wonDeals + lostDeals;
    const winRate = closedDeals > 0 ? (wonDeals / closedDeals) * 100 : null;

    const ordersRevenue = ordersRevenueRow.v;
    const ordersThisMonth = ordersThisMonthRow.c;

    // Order backlog (orderBacklog above): value still owed to customers —
    // placed/processing/shipped but not yet delivered (and not cancelled,
    // since that's a dead order, not outstanding work).
    //
    // Year-to-date order revenue, this year vs the same Jan-1-through-today
    // window last year — an apples-to-apples YoY comparison, not full-year
    // totals (which would unfairly compare a partial year to a complete one).
    // Anchored to Manila "today" like the rest of the app's date logic.
    const ordersRevenueYtdThisYear = ytdThisYearRow.v;
    const ordersRevenueYtdLastYear = ytdLastYearRow.v;

    res.json({
      dealFunnel,
      orderFunnel,
      kpis: {
        pipelineValue,
        wonValue,
        openDeals,
        wonDeals,
        lostDeals,
        winRate,
        ordersRevenue,
        ordersThisMonth,
        orderBacklogValue: orderBacklog.v,
        orderBacklogCount: orderBacklog.c,
        ordersRevenueYtdThisYear,
        ordersRevenueYtdLastYear,
        ytdAsOf: todayManila,
      },
    });
  })
);

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

router.get(
  "/revenue-trend",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    // Anchored to Manila "today" like the rest of the app's date logic, so the
    // "this year" label always matches what the user's clock in the header shows.
    const todayManila = new Date().toLocaleDateString("en-CA", { timeZone: await appTimezone() });
    const thisYear = Number(todayManila.split("-")[0]);
    const lastYear = thisYear - 1;

    const revenueByMonth = async (year) => {
      const rows = await db
        .prepare(
          `SELECT EXTRACT(MONTH FROM order_date::date)::int AS month, COALESCE(SUM(amount), 0) AS revenue
           FROM orders
           WHERE status != 'cancelled' AND order_date >= ? AND order_date <= ?
           GROUP BY month`
        )
        .all(`${year}-01-01`, `${year}-12-31`);
      const byMonth = rows.reduce((acc, r) => ({ ...acc, [r.month]: Number(r.revenue) }), {});
      return Array.from({ length: 12 }, (_, i) => byMonth[i + 1] || 0);
    };

    const [thisYearRevenue, lastYearRevenue] = await Promise.all([revenueByMonth(thisYear), revenueByMonth(lastYear)]);

    const months = MONTH_NAMES.slice(1).map((label, i) => ({
      month: i + 1,
      label,
      thisYear: thisYearRevenue[i],
      lastYear: lastYearRevenue[i],
    }));

    res.json({ thisYear, lastYear, months });
  })
);

router.get(
  "/targets",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const rows = await getSalesTargetsReport({ period_type, period_year, period_index });
    res.json(rows);
  })
);

function periodLabel(periodType, year, index) {
  if (periodType === "yearly") return `${year}`;
  if (periodType === "quarterly") return `Q${index} ${year}`;
  return `${MONTH_NAMES[index]} ${year}`;
}

// Profit & Loss for a period: revenue (non-cancelled order amount, the same
// figure already shown as "Orders revenue" elsewhere on this dashboard) minus
// three cost lines drawn from the other modules this app already tracks —
// procurement (purchase orders), labor (payroll), and operating expenses
// (approved/reimbursed liquidation reports). Each cost line only counts
// "committed" transactions (excluding draft/cancelled/rejected), mirroring how
// the rest of the app already treats draft records as not-yet-real.
router.get(
  "/profit-loss",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);
    const startMonth = Number(start.split("-")[1]);
    const endMonth = Number(end.split("-")[1]);

    const pnl = await getProfitLoss({
      start,
      end,
      periodYear: period_year,
      startMonth,
      endMonth,
    });

    res.json({
      period: { type: period_type, year: period_year, index: period_index, label: periodLabel(period_type, period_year, period_index) },
      ...pnl,
    });
  })
);

async function fetchExpenseRows(start, end) {
  return db
    .prepare(
      `SELECT er.expense_type, er.title, er.cash_advance_amount,
              COALESCE((SELECT SUM(amount) FROM expense_items WHERE report_id = er.id), 0) AS total_expenses
       FROM expense_reports er
       -- A rejected report is spend the company refused. Counting it inflates
       -- every figure on this card and reports money that was never accepted.
       WHERE er.created_at::date BETWEEN ? AND ? AND er.status IN ${COUNTED_SQL}`
    )
    .all(start, end);
}

// Line items, not report totals. The report's title says what an advance was
// *for*; the item's category says what the money actually bought, and the two
// are routinely different — a report titled "Allowance" holds meals,
// transport and laundry. Grouping only by title made Meals read PHP 220 when
// PHP 18,976 had been spent on it across 67 items, and hid Transport
// entirely because no report happened to be titled that.
async function fetchExpenseItemRows(start, end) {
  return db
    .prepare(
      `SELECT i.category, i.amount, r.expense_type
       FROM expense_items i
       JOIN expense_reports r ON r.id = i.report_id
       WHERE r.created_at::date BETWEEN ? AND ? AND r.status IN ${COUNTED_SQL}`
    )
    .all(start, end);
}

// Category is free text with suggestions, so it drifts: "sop" and "SOP" are
// one category typed twice and must not become two slices. Grouped on a
// case-folded key, and the label shown is the spelling used most often.
//
// Both periods are resolved together on purpose — deciding the display
// spelling per period could label the same category "sop" one year and "SOP"
// the next, which would split it across the year-on-year bars.
function groupExpenseItemsByCategory(currentRows, previousRows) {
  const spellings = new Map(); // folded key -> Map(label -> times seen)
  const noteSpelling = (rows) => {
    for (const r of rows) {
      const label = String(r.category || "").trim() || "Uncategorised";
      const key = label.toLowerCase();
      const seen = spellings.get(key) || new Map();
      seen.set(label, (seen.get(label) || 0) + 1);
      spellings.set(key, seen);
    }
  };
  noteSpelling(currentRows);
  noteSpelling(previousRows);

  const display = new Map();
  for (const [key, seen] of spellings) {
    display.set(
      key,
      [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    );
  }

  const total = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const key = (String(r.category || "").trim() || "Uncategorised").toLowerCase();
      const label = display.get(key);
      out.set(label, (out.get(label) || 0) + (Number(r.amount) || 0));
    }
    return out;
  };

  return { current: total(currentRows), previous: total(previousRows) };
}

function groupExpenseRows(rows) {
  const byType = new Map();
  const byTitle = new Map();
  for (const r of rows) {
    const type = r.expense_type || "Unspecified";
    byType.set(type, (byType.get(type) || 0) + r.total_expenses);
    const title = r.title || "Unspecified";
    byTitle.set(title, (byTitle.get(title) || 0) + r.total_expenses);
  }
  return { byType, byTitle };
}

// Merges this period's and the same period last year's breakdown maps into one
// array keyed by label, so the dashboard can chart both years' bars side by
// side per category — including categories that only appear in one of the
// two years (e.g. a brand-new expense type this year shows a 0 previous bar
// rather than being silently dropped).
function mergeByLabel(current, previous) {
  const labels = new Set([...current.keys(), ...previous.keys()]);
  return Array.from(labels)
    .map((label) => ({ label, current: current.get(label) || 0, previous: previous.get(label) || 0 }))
    .sort((a, b) => b.current + b.previous - (a.current + a.previous));
}

// Expenses Report for a period: cash advances vs. actual spend drawn from the
// liquidation/expense reports module, broken down by Expenses Type (Operating
// vs Project) and by Title/Purpose — each paired against the same period one
// year earlier for a YoY comparison. Filtered on the report's created_at like
// the Reports page's expenses-export, not on individual item dates, since
// Expenses Type and Cash Advance are report-level attributes.
router.get(
  "/expenses-report",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);
    const { start: prevStart, end: prevEnd } = periodDateRange(period_type, period_year - 1, period_index);

    const [rows, prevRows, itemRows, prevItemRows] = await Promise.all([
      fetchExpenseRows(start, end),
      fetchExpenseRows(prevStart, prevEnd),
      // Same date window as the report-level rows, so the three breakdowns
      // reconcile to the same total rather than quietly disagreeing.
      fetchExpenseItemRows(start, end),
      fetchExpenseItemRows(prevStart, prevEnd),
    ]);

    const totalCashAdvance = rows.reduce((sum, r) => sum + r.cash_advance_amount, 0);
    const totalExpenses = rows.reduce((sum, r) => sum + r.total_expenses, 0);
    const balance = totalCashAdvance - totalExpenses;
    const liquidationRatePercent = totalCashAdvance > 0 ? (totalExpenses / totalCashAdvance) * 100 : null;

    const grouped = groupExpenseRows(rows);
    const prevGrouped = groupExpenseRows(prevRows);
    const byCategory = groupExpenseItemsByCategory(itemRows, prevItemRows);

    // The same two breakdowns again, but split by expense type. Reading "meals
    // under Project Expenses" off the combined charts was impossible: the two
    // types were added together, so a category could not be attributed to
    // either. Types come from the reports actually present rather than a fixed
    // list, so an unexpected one still appears instead of vanishing.
    const typesPresent = [...new Set([...rows, ...prevRows].map((r) => r.expense_type || "Unspecified"))].sort();
    const ofType = (list, type) => list.filter((r) => (r.expense_type || "Unspecified") === type);
    const breakdownsByType = typesPresent.map((type) => {
      const cur = ofType(rows, type);
      const prev = ofType(prevRows, type);
      const curItems = ofType(itemRows, type);
      const prevItems = ofType(prevItemRows, type);
      const cats = groupExpenseItemsByCategory(curItems, prevItems);
      return {
        type,
        total: cur.reduce((n, r) => n + r.total_expenses, 0),
        previousTotal: prev.reduce((n, r) => n + r.total_expenses, 0),
        byTitle: mergeByLabel(groupExpenseRows(cur).byTitle, groupExpenseRows(prev).byTitle),
        byCategory: mergeByLabel(cats.current, cats.previous),
      };
    });

    res.json({
      period: { type: period_type, year: period_year, index: period_index, label: periodLabel(period_type, period_year, period_index) },
      previousPeriod: { type: period_type, year: period_year - 1, index: period_index, label: periodLabel(period_type, period_year - 1, period_index) },
      totals: { totalCashAdvance, totalExpenses, balance, liquidationRatePercent },
      byType: mergeByLabel(grouped.byType, prevGrouped.byType),
      byTitle: mergeByLabel(grouped.byTitle, prevGrouped.byTitle),
      byCategory: mergeByLabel(byCategory.current, byCategory.previous),
      breakdownsByType,
    });
  })
);

router.post(
  "/targets",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { employee_id, period_type, period_year, period_index, target_amount } = req.body || {};
    if (!employee_id || !period_type || !period_year || target_amount === undefined) {
      return res.status(400).json({ error: "employee_id, period_type, period_year and target_amount are required" });
    }
    if (!["monthly", "quarterly", "yearly"].includes(period_type)) {
      return res.status(400).json({ error: "period_type must be monthly, quarterly or yearly" });
    }
    const index = period_type === "yearly" ? 0 : Number(period_index) || 0;
    await db
      .prepare(
        `INSERT INTO sales_targets (employee_id, period_type, period_year, period_index, target_amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, period_type, period_year, period_index) DO UPDATE SET target_amount = excluded.target_amount`
      )
      .run(employee_id, period_type, period_year, index, Number(target_amount) || 0);
    await logRequestEvent(req, "update_sales_target", {
      entityType: "sales_target",
      entityId: Number(employee_id),
      details: { period_type, period_year, period_index: index, target_amount: Number(target_amount) || 0 },
    });
    res
      .status(201)
      .json(
        await db
          .prepare("SELECT * FROM sales_targets WHERE employee_id = ? AND period_type = ? AND period_year = ? AND period_index = ?")
          .get(employee_id, period_type, period_year, index)
      );
  })
);

router.delete(
  "/targets/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM sales_targets WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
