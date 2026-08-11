const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getSalesTargetsReport, parsePeriod, periodDateRange } = require("../services/salesTargets");
const { getExpenseSummary } = require("../services/expenseSummary");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function periodLabel(periodType, year, index) {
  if (periodType === "yearly") return `${year}`;
  if (periodType === "quarterly") return `Q${index} ${year}`;
  return `${MONTH_NAMES[index]} ${year}`;
}

// Excel export is Finance/Admin territory — gated on the employee actually being
// in Finance (by department or job title), not just any employee, mirroring the
// isSalesEmployee pattern in deals.routes.js. HR is deliberately excluded here
// unless they're also in Finance, since this report's audience is admin + finance.
async function isFinanceOrAdmin(req) {
  if (req.user.role === "admin") return true;
  if (!req.user.employee_id) return false;
  const emp = await db
    .prepare(
      `SELECT e.position, d.name AS department_name FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
    )
    .get(req.user.employee_id);
  if (!emp) return false;
  const dept = (emp.department_name || "").toLowerCase();
  const pos = (emp.position || "").toLowerCase();
  return dept.includes("finance") || pos.includes("finance");
}

// Payroll export has a broader audience than the sales/finance one — HR runs
// payroll day to day, so unlike isFinanceOrAdmin above, HR gets blanket access
// here alongside admin, not just employees who happen to be in Finance.
async function isAdminHrOrFinance(req) {
  if (["admin", "hr"].includes(req.user.role)) return true;
  return isFinanceOrAdmin(req);
}

router.get(
  "/payroll-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isAdminHrOrFinance(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const period_month = Number(req.query.period_month) || new Date().getMonth() + 1;
    const period_year = Number(req.query.period_year) || new Date().getFullYear();
    const period_half = req.query.period_half !== undefined ? Number(req.query.period_half) : undefined;

    let sql = `SELECT p.*, (e.first_name || ' ' || e.last_name) AS employee_name, e.position, d.name AS department_name
               FROM payroll_records p
               JOIN employees e ON e.id = p.employee_id
               LEFT JOIN departments d ON d.id = e.department_id
               WHERE p.period_month = ? AND p.period_year = ?`;
    const params = [period_month, period_year];
    if (period_half !== undefined) {
      sql += " AND p.period_half = ?";
      params.push(period_half);
    }
    sql += " ORDER BY e.last_name, e.first_name, p.period_half";
    const rows = await db.prepare(sql).all(...params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "MARCA GROUP";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Payroll");
    sheet.columns = [
      { header: "Employee", key: "employee_name", width: 24 },
      { header: "Position", key: "position", width: 20 },
      { header: "Department", key: "department_name", width: 18 },
      { header: "Period", key: "period_label", width: 18 },
      { header: "Base Pay", key: "base_salary", width: 14 },
      { header: "Bonuses", key: "bonuses", width: 12 },
      { header: "Overtime Pay", key: "overtime_pay", width: 14 },
      { header: "Deductions", key: "deductions", width: 12 },
      { header: "Net Pay", key: "net_pay", width: 14 },
      { header: "Status", key: "status", width: 12 },
    ];
    sheet.addRows(
      rows.map((r) => ({
        ...r,
        period_label: `${MONTH_NAMES[r.period_month]} ${r.period_year}${r.period_half === 1 ? " (1st half)" : r.period_half === 2 ? " (2nd half)" : ""}`,
      }))
    );
    sheet.getRow(1).font = { bold: true };

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "payroll", period_month, period_year, period_half },
    });

    const filename = `marca-group-payroll-report-${period_year}-${period_month}${period_half ? `-half${period_half}` : ""}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

router.get(
  "/sales-finance-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isFinanceOrAdmin(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const salesRows = await getSalesTargetsReport({ period_type, period_year, period_index });
    const orders = await db
      .prepare(
        `SELECT o.order_number, o.customer_name, o.amount, o.status, o.order_date,
                (e.first_name || ' ' || e.last_name) AS owner_name, d.title AS deal_title
         FROM orders o LEFT JOIN employees e ON e.id = o.owner_id LEFT JOIN deals d ON d.id = o.deal_id
         ORDER BY o.created_at DESC`
      )
      .all();
    const opportunities = await db
      .prepare(
        `SELECT d.title, d.customer_name, d.value, d.stage, d.expected_close_date,
                (e.first_name || ' ' || e.last_name) AS owner_name, o.order_number AS linked_order_number
         FROM deals d LEFT JOIN employees e ON e.id = d.owner_id LEFT JOIN orders o ON o.deal_id = d.id
         ORDER BY e.last_name, e.first_name, d.created_at DESC`
      )
      .all();
    const expenseSummary = await getExpenseSummary();
    const period = periodLabel(period_type, period_year, period_index);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "MARCA GROUP";
    workbook.created = new Date();

    const addSheet = (name, columns, rows) => {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = columns;
      sheet.addRows(rows);
      sheet.getRow(1).font = { bold: true };
    };

    addSheet(
      "Sales Lead Summary",
      [
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Monthly Leads", key: "monthly_leads", width: 14 },
        { header: "Monthly Value", key: "monthly_lead_value", width: 16 },
        { header: "Quarterly Leads", key: "quarterly_leads", width: 15 },
        { header: "Quarterly Value", key: "quarterly_lead_value", width: 16 },
        { header: "Annual Leads", key: "annual_leads", width: 13 },
        { header: "Annual Value", key: "annual_lead_value", width: 15 },
        { header: "Total Leads", key: "total_leads", width: 12 },
        { header: "Total Value", key: "total_lead_value", width: 14 },
      ],
      salesRows
    );

    addSheet(
      "Sales Targets",
      [
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Period", key: "period", width: 14 },
        { header: "Target Amount", key: "target_amount", width: 16 },
        { header: "Actual Amount", key: "actual_amount", width: 16 },
        { header: "Percent", key: "percent", width: 10 },
      ],
      salesRows.map((r) => ({ ...r, period }))
    );

    addSheet(
      "Orders",
      [
        { header: "Order #", key: "order_number", width: 14 },
        { header: "Customer", key: "customer_name", width: 22 },
        { header: "Amount", key: "amount", width: 14 },
        { header: "Owner", key: "owner_name", width: 20 },
        { header: "From Opportunity", key: "deal_title", width: 26 },
        { header: "Order Date", key: "order_date", width: 14 },
        { header: "Status", key: "status", width: 12 },
      ],
      orders
    );

    addSheet(
      "Sales Opportunities",
      [
        { header: "Owner", key: "owner_name", width: 24 },
        { header: "Title", key: "title", width: 26 },
        { header: "Customer", key: "customer_name", width: 22 },
        { header: "Value", key: "value", width: 14 },
        { header: "Expected Close", key: "expected_close_date", width: 16 },
        { header: "Order #", key: "linked_order_number", width: 14 },
        { header: "Stage", key: "stage", width: 14 },
      ],
      opportunities.map((r) => ({ ...r, owner_name: r.owner_name || "Unassigned" }))
    );

    addSheet(
      "Expense Summary",
      [
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Monthly Count", key: "monthly_count", width: 14 },
        { header: "Monthly Total", key: "monthly_total", width: 14 },
        { header: "Quarterly Count", key: "quarterly_count", width: 15 },
        { header: "Quarterly Total", key: "quarterly_total", width: 15 },
        { header: "Annual Count", key: "annual_count", width: 13 },
        { header: "Annual Total", key: "annual_total", width: 13 },
        { header: "Total Count", key: "total_count", width: 12 },
        { header: "Total Total", key: "total_total", width: 12 },
      ],
      expenseSummary
    );

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "sales-finance", period_type, period_year, period_index },
    });

    const filename = `marca-group-sales-finance-report-${period_year}-${period_type}-${period_index}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

// Purchase Orders export lives on the same Finance/Admin audience as the sales/
// finance report it sits next to on the Reports page — procurement spend is
// financial data, not day-to-day HR territory, so this deliberately doesn't
// widen to isAdminHrOrFinance the way the payroll export does.
router.get(
  "/purchase-orders-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isFinanceOrAdmin(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);

    const rows = await db
      .prepare(
        `SELECT po.po_number, po.vendor_name, po.description, po.amount, po.status,
                po.order_date, po.expected_delivery_date, po.received_date,
                (e.first_name || ' ' || e.last_name) AS requested_by_name
         FROM purchase_orders po LEFT JOIN employees e ON e.id = po.requested_by
         WHERE po.order_date BETWEEN ? AND ?
         ORDER BY po.order_date DESC`
      )
      .all(start, end);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "MARCA GROUP";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Purchase Orders");
    sheet.columns = [
      { header: "PO #", key: "po_number", width: 14 },
      { header: "Vendor", key: "vendor_name", width: 22 },
      { header: "Description", key: "description", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Requested By", key: "requested_by_name", width: 20 },
      { header: "Order Date", key: "order_date", width: 14 },
      { header: "Expected Delivery", key: "expected_delivery_date", width: 16 },
      { header: "Received Date", key: "received_date", width: 14 },
    ];
    sheet.addRows(rows.map((r) => ({ ...r, requested_by_name: r.requested_by_name || "—" })));
    sheet.getRow(1).font = { bold: true };

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "purchase-orders", period_type, period_year, period_index },
    });

    const filename = `marca-group-purchase-orders-report-${period_year}-${period_type}-${period_index}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

// Expense reports are HR/day-to-day territory (employees submit them, HR
// approves them) rather than pure finance data, so this uses the broader
// isAdminHrOrFinance gate like the payroll export, not the finance-only one
// purchase orders/sales-finance use.
router.get(
  "/expenses-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isAdminHrOrFinance(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);

    const rows = await db
      .prepare(
        `SELECT er.title, er.expense_type, er.cost_center, er.cash_advance_amount, er.status,
                er.created_at, er.submitted_at,
                (e.first_name || ' ' || e.last_name) AS employee_name,
                COALESCE((SELECT SUM(ei.amount) FROM expense_items ei WHERE ei.report_id = er.id), 0) AS total_expenses
         FROM expense_reports er
         JOIN employees e ON e.id = er.employee_id
         WHERE er.created_at::date BETWEEN ? AND ?
         ORDER BY er.created_at DESC`
      )
      .all(start, end);

    const withBalance = rows.map((r) => ({
      ...r,
      expense_type: r.expense_type || "Unspecified",
      balance: Number((r.cash_advance_amount - r.total_expenses).toFixed(2)),
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "MARCA GROUP";
    workbook.created = new Date();

    const addSheet = (name, columns, sheetRows) => {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = columns;
      sheet.addRows(sheetRows);
      sheet.getRow(1).font = { bold: true };
      return sheet;
    };

    addSheet(
      "Detail",
      [
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Title / Purpose", key: "title", width: 20 },
        { header: "Expenses Type", key: "expense_type", width: 18 },
        { header: "Cost Center", key: "cost_center", width: 18 },
        { header: "Cash Advance", key: "cash_advance_amount", width: 14 },
        { header: "Total Expenses", key: "total_expenses", width: 15 },
        { header: "Balance", key: "balance", width: 14 },
        { header: "Status", key: "status", width: 12 },
        { header: "Created", key: "created_at", width: 18 },
      ],
      withBalance.map((r) => ({ ...r, cost_center: r.cost_center || "—" }))
    );

    // Two independent breakdowns of the same rows, one per "type" grouping the
    // Reports page dropdowns support: the broad Operating/Project classification,
    // and the specific per-title purpose (Fuel, Parking, Meals, ...).
    const sumBy = (keyFn) => {
      const totals = new Map();
      for (const r of withBalance) {
        const key = keyFn(r);
        totals.set(key, (totals.get(key) || 0) + r.total_expenses);
      }
      return Array.from(totals.entries()).map(([label, total]) => ({ label, total }));
    };

    addSheet(
      "By Expenses Type",
      [
        { header: "Expenses Type", key: "label", width: 20 },
        { header: "Total Expenses", key: "total", width: 16 },
      ],
      sumBy((r) => r.expense_type)
    );

    addSheet(
      "By Title-Purpose",
      [
        { header: "Title / Purpose", key: "label", width: 20 },
        { header: "Total Expenses", key: "total", width: 16 },
      ],
      sumBy((r) => r.title)
    );

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "expenses", period_type, period_year, period_index },
    });

    const filename = `marca-group-expense-report-${period_year}-${period_type}-${period_index}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
