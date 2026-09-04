const db = require("../db");
const { appTimezone } = require("./timezone");

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Monthly order revenue for a year and the one before it. Extracted from
// sales.routes so the Snapshot draws its trend from the same query as the
// dashboard chart rather than a second one that could answer differently.
async function getRevenueTrend() {
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

  const [thisYearRevenue, lastYearRevenue] = await Promise.all([
    revenueByMonth(thisYear),
    revenueByMonth(lastYear),
  ]);

  const months = MONTH_NAMES.slice(1).map((label, i) => ({
    month: i + 1,
    label,
    thisYear: thisYearRevenue[i],
    lastYear: lastYearRevenue[i],
  }));

  return { thisYear, lastYear, months };
}

module.exports = { getRevenueTrend, MONTH_NAMES };
