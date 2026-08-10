const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getSalesTargetsReport, parsePeriod } = require("../services/salesTargets");
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
    const dealCounts = (await db.prepare("SELECT stage, COUNT(*) AS c FROM deals GROUP BY stage").all()).reduce(
      (acc, row) => ({ ...acc, [row.stage]: row.c }),
      {}
    );

    const dealStageLabels = {
      lead: "Lead",
      qualified: "Qualified",
      proposal: "Proposal",
      negotiation: "Negotiation",
      won: "Won",
    };
    const dealFunnel = buildFunnel(dealCounts, DEAL_STAGES, dealStageLabels, "lost", "Lost");

    const orderCounts = (await db.prepare("SELECT status, COUNT(*) AS c FROM orders GROUP BY status").all()).reduce(
      (acc, row) => ({ ...acc, [row.status]: row.c }),
      {}
    );
    const orderStatusLabels = { placed: "Placed", processing: "Processing", shipped: "Shipped", delivered: "Delivered" };
    const orderFunnel = buildFunnel(orderCounts, ORDER_STATUSES, orderStatusLabels, "cancelled", "Cancelled");

    const pipelineValue = (
      await db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage NOT IN ('won', 'lost')").get()
    ).v;
    const wonValue = (await db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'won'").get()).v;
    const openDeals = (await db.prepare("SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won', 'lost')").get()).c;

    const ordersRevenue = (await db.prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled'").get())
      .v;
    const ordersThisMonth = (
      await db
        .prepare(
          "SELECT COUNT(*) AS c FROM orders WHERE to_char(order_date::date, 'YYYY-MM') = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')"
        )
        .get()
    ).c;

    // Order backlog: value still owed to customers — placed/processing/shipped
    // but not yet delivered (and not cancelled, since that's a dead order, not
    // outstanding work).
    const orderBacklog = await db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS v FROM orders WHERE status NOT IN ('delivered', 'cancelled')")
      .get();

    // Year-to-date order revenue, this year vs the same Jan-1-through-today
    // window last year — an apples-to-apples YoY comparison, not full-year
    // totals (which would unfairly compare a partial year to a complete one).
    // Anchored to Manila "today" like the rest of the app's date logic.
    const todayManila = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    const [todayYear, todayMonth, todayDay] = todayManila.split("-");
    const lastYear = String(Number(todayYear) - 1);
    const ytdRevenue = async (year, end) =>
      (
        await db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled' AND order_date BETWEEN ? AND ?")
          .get(`${year}-01-01`, end)
      ).v;
    const ordersRevenueYtdThisYear = await ytdRevenue(todayYear, todayManila);
    const ordersRevenueYtdLastYear = await ytdRevenue(lastYear, `${lastYear}-${todayMonth}-${todayDay}`);

    res.json({
      dealFunnel,
      orderFunnel,
      kpis: {
        pipelineValue,
        wonValue,
        openDeals,
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
    const todayManila = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
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
