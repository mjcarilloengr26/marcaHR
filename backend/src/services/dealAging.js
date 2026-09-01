const db = require("../db");

const OPEN_STAGES = ["lead", "qualified", "proposal", "negotiation"];

// Aging is computed on read rather than stored, so it is never a day stale and
// there is no nightly job keeping a counter honest.
//
// Three different numbers, because they answer three different questions:
//   age_days       — how long since the opportunity was opened at all
//   days_in_stage  — how long it has sat where it is now (the stale signal)
//   days_past_close — how far past its own expected close date it has drifted
const AGING_COLUMNS = `
  (CURRENT_DATE - substr(d.created_at, 1, 10)::date) AS age_days,
  (CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date) AS days_in_stage,
  CASE WHEN d.expected_close_date IS NULL OR d.expected_close_date = '' THEN NULL
       ELSE (CURRENT_DATE - d.expected_close_date::date) END AS days_past_close`;

async function staleDealDays() {
  const row = await db.prepare("SELECT stale_deal_days FROM app_settings WHERE id = 1").get();
  const n = Number(row && row.stale_deal_days);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// Open opportunities that have not moved for longer than the threshold, or
// have run past their own expected close date. Both count as stale: one is
// "nobody has touched this", the other is "the date we promised has gone".
async function staleDeals(thresholdDays) {
  const limit = thresholdDays ?? (await staleDealDays());
  const rows = await db
    .prepare(
      `SELECT d.id, d.title, d.customer_name, d.value, d.stage, d.expected_close_date, d.competitor,
              d.owner_id, (e.first_name || ' ' || e.last_name) AS owner_name, e.email AS owner_email,
              ${AGING_COLUMNS}
       FROM deals d LEFT JOIN employees e ON e.id = d.owner_id
       WHERE d.stage = ANY(?)
         AND ((CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date) >= ?
              OR (d.expected_close_date IS NOT NULL AND d.expected_close_date <> ''
                  AND d.expected_close_date::date < CURRENT_DATE))
       ORDER BY days_in_stage DESC, d.value DESC`
    )
    .all(OPEN_STAGES, limit);
  return { thresholdDays: limit, deals: rows };
}

// Headline figures for the Sales Dashboard tile.
async function agingSummary(thresholdDays) {
  const limit = thresholdDays ?? (await staleDealDays());
  const totals = await db
    .prepare(
      `SELECT COUNT(*)::int AS open_count,
              COALESCE(ROUND(SUM(d.value)::numeric, 2), 0) AS open_value,
              COUNT(*) FILTER (
                WHERE (CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date) >= ?
              )::int AS stalled_count,
              COALESCE(ROUND(SUM(d.value) FILTER (
                WHERE (CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date) >= ?
              )::numeric, 2), 0) AS stalled_value,
              COUNT(*) FILTER (
                WHERE d.expected_close_date IS NOT NULL AND d.expected_close_date <> ''
                  AND d.expected_close_date::date < CURRENT_DATE
              )::int AS overdue_count,
              COALESCE(ROUND(SUM(d.value) FILTER (
                WHERE d.expected_close_date IS NOT NULL AND d.expected_close_date <> ''
                  AND d.expected_close_date::date < CURRENT_DATE
              )::numeric, 2), 0) AS overdue_value,
              COUNT(*) FILTER (WHERE d.expected_close_date IS NULL OR d.expected_close_date = '')::int AS no_close_date,
              COALESCE(ROUND(AVG(
                CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date
              )::numeric, 1), 0) AS avg_days_in_stage
       FROM deals d WHERE d.stage = ANY(?)`
    )
    .get(limit, limit, OPEN_STAGES);

  // Where the pipeline is actually clogged, so a review can start with the
  // worst stage rather than the longest list.
  const byStage = await db
    .prepare(
      `SELECT d.stage,
              COUNT(*)::int AS count,
              COALESCE(ROUND(SUM(d.value)::numeric, 2), 0) AS value,
              COALESCE(MAX(CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date), 0) AS oldest_days,
              COALESCE(ROUND(AVG(
                CURRENT_DATE - substr(COALESCE(d.stage_changed_at, d.created_at), 1, 10)::date
              )::numeric, 1), 0) AS avg_days
       FROM deals d WHERE d.stage = ANY(?)
       GROUP BY d.stage`
    )
    .all(OPEN_STAGES);

  const stageOrder = { lead: 0, qualified: 1, proposal: 2, negotiation: 3 };
  byStage.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage]);

  const { deals } = await staleDeals(limit);
  return {
    thresholdDays: limit,
    totals: {
      openCount: totals.open_count,
      openValue: Number(totals.open_value),
      stalledCount: totals.stalled_count,
      stalledValue: Number(totals.stalled_value),
      overdueCount: totals.overdue_count,
      overdueValue: Number(totals.overdue_value),
      noCloseDate: totals.no_close_date,
      avgDaysInStage: Number(totals.avg_days_in_stage),
    },
    byStage: byStage.map((s) => ({
      stage: s.stage,
      count: s.count,
      value: Number(s.value),
      oldestDays: Number(s.oldest_days),
      avgDays: Number(s.avg_days),
    })),
    // Capped: the tile is a prompt to act, not a second Opportunities page.
    worst: deals.slice(0, 10),
    staleCount: deals.length,
  };
}

module.exports = { AGING_COLUMNS, OPEN_STAGES, staleDealDays, staleDeals, agingSummary };
