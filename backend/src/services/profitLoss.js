const db = require("./../db");

// Extracted from the Sales Dashboard's /profit-loss route so the business
// review can quote the same figures. Two implementations of the same P&L would
// eventually disagree, and a review that contradicts the dashboard it sits next
// to is worse than no review.
async function getProfitLoss({ start, end, periodYear, startMonth, endMonth }) {
  const [ordersRevenueRow, procurementRow, payrollRow, operatingExpensesRow] = await Promise.all([
    db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM orders WHERE status != 'cancelled' AND order_date BETWEEN ? AND ?")
      .get(start, end),
    db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS v FROM purchase_orders WHERE status NOT IN ('cancelled', 'draft') AND order_date BETWEEN ? AND ?"
      )
      .get(start, end),
    db
      .prepare(
        "SELECT COALESCE(SUM(net_pay), 0) AS v FROM payroll_records WHERE status IN ('finalized', 'paid') AND period_year = ? AND period_month BETWEEN ? AND ?"
      )
      .get(periodYear, startMonth, endMonth),
    db
      .prepare(
        `SELECT COALESCE(SUM(ei.amount), 0) AS v FROM expense_items ei
         JOIN expense_reports er ON er.id = ei.report_id
         WHERE er.status IN ('approved', 'reimbursed') AND ei.expense_date BETWEEN ? AND ?`
      )
      .get(start, end),
  ]);

  const ordersRevenue = Number(ordersRevenueRow.v);
  const procurement = Number(procurementRow.v);
  const payroll = Number(payrollRow.v);
  const operatingExpenses = Number(operatingExpensesRow.v);

  const totalRevenue = ordersRevenue;
  const totalCosts = procurement + payroll + operatingExpenses;
  const netProfit = totalRevenue - totalCosts;
  const profitMarginPercent = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : null;

  return {
    revenue: { ordersRevenue },
    costs: { procurement, payroll, operatingExpenses },
    totals: { totalRevenue, totalCosts, netProfit, profitMarginPercent },
  };
}

module.exports = { getProfitLoss };
