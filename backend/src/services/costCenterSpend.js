const { COUNTED_SQL } = require("./expenseScope");
const db = require("../db");

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Spend is matched to a cost centre by folded name, not by a foreign key.
// expense_reports.cost_center has always been text and still holds whatever
// was typed before the list existed; matching on the name means those older
// reports keep counting instead of falling out of every total the moment a
// managed list appeared.
//
// Only counted statuses (see expenseScope): a refused claim is not spend, and
// a draft is somebody part-way through typing — neither should eat a budget.
const SPEND_SQL = `
  SELECT LOWER(TRIM(r.cost_center)) AS key,
         COALESCE(SUM(i.amount), 0) AS spent,
         COUNT(DISTINCT r.id)::int AS reports
  FROM expense_reports r
  JOIN expense_items i ON i.report_id = r.id
  WHERE r.status IN ${COUNTED_SQL}
    AND COALESCE(TRIM(r.cost_center), '') <> ''
    AND substr(r.created_at, 1, 4) = ?
  GROUP BY 1`;

// Lives in a service rather than in costcenters.routes.js because the Snapshot
// page rolls the same figures up into a single "N over allocation" line. Two
// copies of this join is exactly how the counted-status filter drifted before
// expenseScope was written, so there is one copy from the start this time.
async function withSpend(year) {
  const [centers, budgets, spend] = await Promise.all([
    db.prepare("SELECT * FROM cost_centers ORDER BY name").all(),
    db.prepare("SELECT cost_center_id, amount FROM cost_center_budgets WHERE year = ?").all(year),
    db.prepare(SPEND_SQL).all(String(year)),
  ]);

  const budgetById = new Map(budgets.map((b) => [b.cost_center_id, Number(b.amount)]));
  const spendByKey = new Map(spend.map((s) => [s.key, s]));

  const rows = centers.map((c) => {
    const hit = spendByKey.get(String(c.name).trim().toLowerCase());
    const spent = money(hit ? hit.spent : 0);
    const budget = money(budgetById.get(c.id) || 0);
    return {
      ...c,
      year,
      budget,
      spent,
      reports: hit ? hit.reports : 0,
      remaining: money(budget - spent),
      // Null rather than 0 when nothing is allocated: "0% used" reads as
      // healthy, and an unbudgeted cost centre is not healthy, it is unknown.
      usedPercent: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null,
      overBudget: budget > 0 && spent > budget,
    };
  });

  // Spend booked against a name nobody has put on the list — an older report,
  // or a rename. Surfaced rather than silently dropped, because it is real
  // money that no budget is watching.
  const known = new Set(centers.map((c) => String(c.name).trim().toLowerCase()));
  const unassigned = spend
    .filter((s) => !known.has(s.key))
    .map((s) => ({ name: s.key, spent: money(s.spent), reports: s.reports }));

  return { rows, unassigned };
}

// The one-line version the Snapshot needs: how much is allocated, how much has
// gone, and how many cost centres are in trouble or unwatched.
async function spendRollup(year) {
  const { rows, unassigned } = await withSpend(year);
  return {
    year,
    centers: rows.length,
    budget: money(rows.reduce((n, r) => n + r.budget, 0)),
    spent: money(rows.reduce((n, r) => n + r.spent, 0) + unassigned.reduce((n, u) => n + u.spent, 0)),
    overBudget: rows.filter((r) => r.overBudget).length,
    // Allocated nothing at all: their spend is real but nothing is measuring it.
    unbudgeted: rows.filter((r) => r.budget === 0).length,
    unmatched: {
      names: unassigned.length,
      spent: money(unassigned.reduce((n, u) => n + u.spent, 0)),
    },
  };
}

module.exports = { withSpend, spendRollup, money };
