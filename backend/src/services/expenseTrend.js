const db = require("../db");
const { COUNTED_SQL } = require("./expenseScope");
const { appTimezone } = require("./timezone");

// Expense spend by category over time, for the Overview dashboard's trend
// chart: the last 12 months, 8 quarters or 5 years, ending with the one we are
// in now.
//
// Same scope as every other expense figure (COUNTED_SQL: submitted, approved,
// reimbursed) and bucketed by expense_date, so a month here adds up to the
// same thing as the Expense Summary's "Monthly" column beside it.
//
// The chart can only tell seven categories apart by colour, so the biggest
// seven get a series each and the rest are folded into one. "Biggest" is
// measured over all time, not over the window being looked at: that way a
// category keeps the same colour when the filter moves from months to years,
// instead of being repainted because its rank changed.

const PERIODS = {
  month: { count: 12 },
  quarter: { count: 8 },
  year: { count: 5 },
};
const MAX_SERIES = 7;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// A bucket is a year plus an index within it: a month 1-12, a quarter 1-4, or
// 1 for a whole year. Stepping back one bucket rolls over into the year before.
function stepBack(period, year, index) {
  const perYear = period === "month" ? 12 : period === "quarter" ? 4 : 1;
  return index > 1 ? [year, index - 1] : [year - 1, perYear];
}

function describe(period, year, index) {
  if (period === "month") {
    return { key: `${year}-${pad(index)}`, label: `${MONTHS[index - 1]} ${year}`, short: MONTHS[index - 1], start: `${year}-${pad(index)}-01` };
  }
  if (period === "quarter") {
    return { key: `${year}-Q${index}`, label: `Q${index} ${year}`, short: `Q${index}`, start: `${year}-${pad((index - 1) * 3 + 1)}-01` };
  }
  return { key: String(year), label: String(year), short: String(year), start: `${year}-01-01` };
}

function bucketKeyOf(period, expenseDate) {
  const [y, m] = String(expenseDate).split("-").map(Number);
  if (period === "month") return `${y}-${pad(m)}`;
  if (period === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return String(y);
}

// The first day after the current bucket: the window's exclusive upper bound,
// so an expense dated in the future does not land in a bucket it is not in.
function endAfter(period, year, index) {
  if (period === "month") return index === 12 ? `${year + 1}-01-01` : `${year}-${pad(index + 1)}-01`;
  if (period === "quarter") return index === 4 ? `${year + 1}-01-01` : `${year}-${pad(index * 3 + 1)}-01`;
  return `${year + 1}-01-01`;
}

async function getExpenseTrend(periodParam) {
  const period = PERIODS[periodParam] ? periodParam : "month";
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: await appTimezone(), year: "numeric", month: "2-digit" })
    .format(new Date())
    .split("-")
    .map(Number);
  const currentIndex = period === "month" ? month : period === "quarter" ? Math.floor((month - 1) / 3) + 1 : 1;

  const buckets = [];
  let [y, i] = [year, currentIndex];
  for (let n = 0; n < PERIODS[period].count; n++) {
    buckets.unshift(describe(period, y, i));
    [y, i] = stepBack(period, y, i);
  }
  // Only the last bucket can still be filling up. Comparing it with a finished
  // one would make every category look like it is shrinking, so it is flagged
  // and the growth figures are taken from the last two complete buckets.
  buckets.forEach((b, n) => (b.complete = n < buckets.length - 1));

  const from = buckets[0].start;
  const to = endAfter(period, year, currentIndex);

  // Categories are compared without case or surrounding spaces, so "Fuel" and
  // "fuel " are one line; the name shown is whichever spelling is used most.
  const categorySql = "COALESCE(NULLIF(btrim(i.category), ''), 'Uncategorised')";
  const [windowRows, allTimeRows] = await Promise.all([
    db
      .prepare(
        `SELECT lower(${categorySql}) AS cat_key, i.expense_date, SUM(i.amount) AS amount
         FROM expense_items i JOIN expense_reports r ON r.id = i.report_id
         WHERE r.status IN ${COUNTED_SQL} AND i.expense_date >= ? AND i.expense_date < ?
         GROUP BY 1, 2`
      )
      .all(from, to),
    db
      .prepare(
        `SELECT lower(${categorySql}) AS cat_key,
                mode() WITHIN GROUP (ORDER BY ${categorySql}) AS name,
                SUM(i.amount) AS amount
         FROM expense_items i JOIN expense_reports r ON r.id = i.report_id
         WHERE r.status IN ${COUNTED_SQL}
         GROUP BY 1`
      )
      .all(),
  ]);

  // Uncategorised is an absence rather than a category, so it never takes one
  // of the seven colours; it goes with the folded rest.
  const ranked = allTimeRows
    .filter((r) => r.cat_key !== "uncategorised")
    .sort((a, b) => Number(b.amount) - Number(a.amount) || a.name.localeCompare(b.name));
  const named = ranked.slice(0, MAX_SERIES);
  const slotOf = new Map(named.map((r, n) => [r.cat_key, n]));
  const nameOf = new Map(allTimeRows.map((r) => [r.cat_key, r.name]));

  const indexOf = new Map(buckets.map((b, n) => [b.key, n]));
  const series = named.map((r, n) => ({ key: r.cat_key, name: r.name, slot: n + 1, values: buckets.map(() => 0) }));
  const rest = { key: "__rest", name: "All other categories", slot: null, values: buckets.map(() => 0), members: [] };
  const restMembers = new Set();

  for (const row of windowRows) {
    const b = indexOf.get(bucketKeyOf(period, row.expense_date));
    if (b === undefined) continue;
    const amount = Number(row.amount) || 0;
    const slot = slotOf.get(row.cat_key);
    if (slot !== undefined) series[slot].values[b] += amount;
    else {
      rest.values[b] += amount;
      if (amount) restMembers.add(nameOf.get(row.cat_key) || row.cat_key);
    }
  }
  rest.members = [...restMembers].sort((a, b) => a.localeCompare(b));

  const round = (v) => Math.round(v * 100) / 100;
  const all = [...series, ...(rest.values.some((v) => v) ? [rest] : [])].map((s) => {
    const values = s.values.map(round);
    return { ...s, values, total: round(values.reduce((a, v) => a + v, 0)) };
  });

  // Leading periods from before anything was recorded are dropped, so a
  // portal that started filing expenses in May does not open on seven empty
  // months. Three are always kept: the period in progress and the two complete
  // ones the growth comparison reads.
  const totals = buckets.map((_, b) => round(all.reduce((a, s) => a + s.values[b], 0)));
  let first = totals.findIndex((t) => t !== 0);
  if (first < 0) first = buckets.length;
  first = Math.min(first, buckets.length - 3);
  const cut = (arr) => arr.slice(first);

  return {
    period,
    buckets: cut(buckets).map(({ start, ...b }) => b),
    series: all.map((s) => ({ ...s, values: cut(s.values) })),
    totals: cut(totals),
  };
}

module.exports = { getExpenseTrend, PERIODS };
