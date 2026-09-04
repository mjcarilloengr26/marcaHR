const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { buildFactSheet, FACT_PERIOD_TYPES } = require("../services/businessReview");
const { getRevenueTrend } = require("../services/revenueTrend");
const { spendRollup } = require("../services/costCenterSpend");
const { appTimezone } = require("../services/timezone");

const router = express.Router();

// The Snapshot is the one-page read of the business: the handful of figures a
// review actually turns on, the period-on-period move in each, and a short list
// of things that need a decision.
//
// It deliberately reuses buildFactSheet rather than running its own queries.
// That service already backs the monthly Business Review email, so the page and
// the email can never quote different numbers for the same month — which is the
// failure that makes a summary page worse than no summary page at all.

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Returns { error } rather than throwing: the app's global handler turns every
// thrown error into a flat 500, so a bad query string would report itself as a
// server fault instead of a bad request.
function parse(query = {}, today) {
  // Year to date by default. A wall panel is read in passing, and how the year
  // is going is the question a glance can answer — a single month is noise at
  // that distance.
  const periodType = String(query.period_type || "ytd");
  if (!FACT_PERIOD_TYPES.includes(periodType)) {
    return { error: `period_type must be one of ${FACT_PERIOD_TYPES.join(", ")}` };
  }
  const [y, m] = today.split("-").map(Number);
  const year = Number(query.year) || y;
  const defaultIndex = periodType === "monthly" ? m : periodType === "quarterly" ? Math.floor((m - 1) / 3) + 1 : 1;
  const index = Number(query.index) || defaultIndex;
  return { periodType, year, index };
}

// A move is only worth showing when there is something to move from. Going from
// nothing to something is not "+100%", it is new — saying so is more honest than
// a percentage that implies a rate.
function delta(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (b === 0) return { from: b, to: a, absolute: round(a), percent: null, direction: a > 0 ? "new" : "flat" };
  const pct = ((a - b) / Math.abs(b)) * 100;
  return {
    from: b,
    to: a,
    absolute: round(a - b),
    percent: Math.round(pct * 10) / 10,
    direction: a > b ? "up" : a < b ? "down" : "flat",
  };
}

// Whether "up" is good depends on the measure: revenue rising is good, cost
// rising is not. The page must not paint a cost increase green, so each headline
// carries its own polarity rather than the component guessing from the sign.
function headlines(cur, prev) {
  return [
    {
      key: "revenue",
      label: "Revenue",
      hint: "Orders placed, excluding cancelled",
      value: round(cur.profitAndLoss.totals.totalRevenue),
      format: "money",
      goodWhen: "up",
      delta: delta(cur.profitAndLoss.totals.totalRevenue, prev.profitAndLoss.totals.totalRevenue),
    },
    {
      key: "netProfit",
      label: "Net profit",
      hint: `Margin ${cur.profitAndLoss.totals.profitMarginPercent == null ? "—" : `${Math.round(cur.profitAndLoss.totals.profitMarginPercent * 10) / 10}%`}`,
      value: round(cur.profitAndLoss.totals.netProfit),
      format: "money",
      goodWhen: "up",
      delta: delta(cur.profitAndLoss.totals.netProfit, prev.profitAndLoss.totals.netProfit),
    },
    {
      key: "costs",
      label: "Total cost",
      hint: "Procurement, payroll and expenses",
      value: round(cur.profitAndLoss.totals.totalCosts),
      format: "money",
      goodWhen: "down",
      delta: delta(cur.profitAndLoss.totals.totalCosts, prev.profitAndLoss.totals.totalCosts),
    },
    {
      key: "collected",
      label: "Cash collected",
      hint: `${cur.revenue.invoicesIssued} invoice${cur.revenue.invoicesIssued === 1 ? "" : "s"} issued`,
      value: round(cur.revenue.collectedValue),
      format: "money",
      goodWhen: "up",
      delta: delta(cur.revenue.collectedValue, prev.revenue.collectedValue),
    },
    {
      key: "won",
      label: "Won",
      hint: `${cur.sales.won} won / ${cur.sales.lost} lost`,
      value: round(cur.sales.wonValue),
      format: "money",
      goodWhen: "up",
      delta: delta(cur.sales.wonValue, prev.sales.wonValue),
    },
    {
      key: "pipeline",
      label: "Open pipeline",
      hint: `${cur.sales.openPipelineCount} open opportunit${cur.sales.openPipelineCount === 1 ? "y" : "ies"}`,
      value: round(cur.sales.openPipelineValue),
      format: "money",
      goodWhen: "up",
      // Pipeline is a position, not a flow: it is whatever is open right now, so
      // there is no previous-period figure to move against.
      delta: null,
    },
  ];
}

// What is going well, for the bottom of the wall panel. This is a screen the
// whole office walks past, so it carries the wins rather than a list of
// failures — the problems still get raised, but in the Business Review that
// goes to the people who can act on them, not on a television.
//
// Every line is guarded by the condition that makes it true. Nothing here is
// padded: if there is no good news, the strip says so plainly rather than
// dressing up a flat number as an achievement.
const MONTH_LABELS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function highlights({ cur, prev, standing, costCenters, trend, comparedLabel }) {
  const out = [];
  const add = (title, detail, amounts = []) => out.push({ title, detail, amounts });

  const rev = delta(cur.profitAndLoss.totals.totalRevenue, prev.profitAndLoss.totals.totalRevenue);
  if (rev.direction === "up") {
    add("Revenue growing", `Up ${rev.percent}% on ${comparedLabel}, a gain of {0}.`, [rev.absolute]);
  } else if (cur.profitAndLoss.totals.totalRevenue > 0 && rev.direction === "new") {
    add("Revenue booked", `{0} of order revenue, with nothing in ${comparedLabel} to compare against.`, [
      round(cur.profitAndLoss.totals.totalRevenue),
    ]);
  }

  const best = trend.months.reduce((a, m) => (m.thisYear > (a ? a.thisYear : 0) ? m : a), null);
  if (best && best.thisYear > 0) {
    add("Best month so far", `${MONTH_LABELS[best.month]} brought in {0}.`, [round(best.thisYear)]);
  }

  const decided = cur.sales.won + cur.sales.lost;
  if (cur.sales.won > 0) {
    add(
      "Opportunities won",
      decided > 0
        ? `${cur.sales.won} of ${decided} closed, worth {0}.`
        : `${cur.sales.won} won, worth {0}.`,
      [round(cur.sales.wonValue)]
    );
  }

  const margin = cur.profitAndLoss.totals.profitMarginPercent;
  if (cur.profitAndLoss.totals.netProfit > 0 && margin !== null) {
    add("Profitable", `{0} net, a ${Math.round(margin * 10) / 10}% margin.`, [
      round(cur.profitAndLoss.totals.netProfit),
    ]);
  }

  if (cur.revenue.collectedValue > 0) {
    add("Cash collected", `{0} received from customers.`, [round(cur.revenue.collectedValue)]);
  }

  if (standing.stalledOpportunities.count === 0 && cur.sales.openPipelineValue > 0) {
    add(
      "Pipeline moving",
      `{0} open across ${cur.sales.openPipelineCount} opportunit${cur.sales.openPipelineCount === 1 ? "y" : "ies"}, none gone quiet.`,
      [round(cur.sales.openPipelineValue)]
    );
  }

  if (costCenters.budget > 0 && costCenters.overBudget === 0) {
    add(
      "Spending within plan",
      `All ${costCenters.centers} cost centers are inside their ${costCenters.year} allocation.`
    );
  }

  if (cur.delivery.workOrdersCompleted > 0) {
    add(
      "Work delivered",
      `${cur.delivery.workOrdersCompleted} of ${cur.delivery.workOrdersOpened} work orders completed.`
    );
  }

  // Five is what fits across a landscape panel and still reads from a distance.
  return out.slice(0, 5);
}

router.get(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    // Anchored to Manila "today" like the rest of the app's date logic, so the
    // year-to-date cut-off matches the clock in the header rather than the
    // server's own timezone.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: await appTimezone() });

    const parsed = parse(req.query, today);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { periodType, year, index } = parsed;

    const [factSheet, trend, costCenters] = await Promise.all([
      buildFactSheet({ periodType, year, index, asOf: today }),
      getRevenueTrend(),
      spendRollup(year),
    ]);

    const cur = factSheet.current;
    const prev = factSheet.previous;

    res.json({
      period: factSheet.period,
      comparedWith: factSheet.comparedWith,
      headlines: headlines(cur, prev),
      // Where the money came from and where it went, as one balanced pair the
      // page can draw side by side.
      moneyIn: {
        invoiced: round(cur.revenue.invoicedValue),
        collected: round(cur.revenue.collectedValue),
        // Outstanding is a standing position — everything unpaid right now, not
        // just this period's share. Quoting the period's own figure would show
        // zero owed in any month nothing happened to be invoiced.
        outstanding: round(factSheet.standing.receivables.outstanding),
        overdue: round(factSheet.standing.receivables.overdue),
        collectionRatePercent:
          cur.revenue.collectionRatePercent === null ? null : Math.round(cur.revenue.collectionRatePercent * 10) / 10,
        overdueInvoices: cur.revenue.overdueInvoices,
        unsent: {
          count: factSheet.standing.unsentInvoices.count,
          value: round(factSheet.standing.unsentInvoices.value),
        },
      },
      moneyOut: {
        procurement: round(cur.profitAndLoss.costs.procurement),
        payroll: round(cur.profitAndLoss.costs.payroll),
        operatingExpenses: round(cur.profitAndLoss.costs.operatingExpenses),
        total: round(cur.profitAndLoss.totals.totalCosts),
      },
      costCenters,
      trend,
      highlights: highlights({
        cur,
        prev,
        standing: factSheet.standing,
        costCenters,
        trend,
        comparedLabel: factSheet.comparedWith.label,
      }),
      generatedAt: new Date().toISOString(),
    });
  })
);

module.exports = router;
