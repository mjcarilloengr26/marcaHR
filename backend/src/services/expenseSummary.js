const db = require("../db");
const { COUNTED_SQL } = require("../services/expenseScope");
const { appTimezone } = require("./timezone");

// Expense summary per employee — every liquidated/claimed expense item,
// bucketed by its expense_date: current month, current quarter, current
// year, and all-time total (monthly ⊆ quarterly ⊆ annually ⊆ total by
// construction), same pattern as the Sales Lead Summary. expense_date is
// already a plain calendar date (no time component), so no timezone shift
// is needed here unlike created_at-based timestamps elsewhere.
//
// Shared by the Overview dashboard stats and the sales/finance Excel export.
async function getExpenseSummary() {
  const nowParts = new Intl.DateTimeFormat("en-CA", { timeZone: await appTimezone(), year: "numeric", month: "2-digit" })
    .format(new Date())
    .split("-")
    .map(Number);
  const [currentYear, currentMonth] = nowParts;
  const currentQuarter = Math.floor((currentMonth - 1) / 3) + 1;

  const emptyBucket = () => ({ count: 0, value: 0 });
  const expenseSummaryByEmployee = {};
  const expenseItemRows = await db
    .prepare(
      // Rejected reports are excluded here as everywhere else: refused spend
      // is not somebody's expense figure.
      `SELECT r.employee_id, i.amount, i.expense_date FROM expense_items i
       JOIN expense_reports r ON r.id = i.report_id
       WHERE r.status IN ${COUNTED_SQL}`
    )
    .all();
  for (const it of expenseItemRows) {
    const [y, m] = it.expense_date.split("-").map(Number);
    const q = Math.floor((m - 1) / 3) + 1;
    if (!expenseSummaryByEmployee[it.employee_id]) {
      expenseSummaryByEmployee[it.employee_id] = {
        monthly: emptyBucket(),
        quarterly: emptyBucket(),
        annually: emptyBucket(),
        total: emptyBucket(),
      };
    }
    const s = expenseSummaryByEmployee[it.employee_id];
    s.total.count += 1;
    s.total.value += it.amount;
    if (y === currentYear) {
      s.annually.count += 1;
      s.annually.value += it.amount;
      if (q === currentQuarter) {
        s.quarterly.count += 1;
        s.quarterly.value += it.amount;
        if (m === currentMonth) {
          s.monthly.count += 1;
          s.monthly.value += it.amount;
        }
      }
    }
  }
  // One query for every name rather than one per employee inside the loop —
  // that N+1 was costing a full database round-trip per employee, which
  // dominated the Overview dashboard's load time.
  const ids = Object.keys(expenseSummaryByEmployee);
  const nameById = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT id, first_name, last_name FROM employees WHERE id IN (${placeholders})`)
      .all(...ids);
    for (const r of rows) nameById.set(String(r.id), `${r.first_name} ${r.last_name}`);
  }

  const expenseSummary = [];
  for (const id of ids) {
    const employeeName = nameById.get(String(id)) || "Unknown";
    const s = expenseSummaryByEmployee[id];
    expenseSummary.push({
      employee_id: Number(id),
      employee_name: employeeName,
      monthly_count: s.monthly.count,
      monthly_total: s.monthly.value,
      quarterly_count: s.quarterly.count,
      quarterly_total: s.quarterly.value,
      annual_count: s.annually.count,
      annual_total: s.annually.value,
      total_count: s.total.count,
      total_total: s.total.value,
    });
  }
  expenseSummary.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  return expenseSummary;
}

module.exports = { getExpenseSummary };
