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

module.exports = router;
