const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getSalesTargetsReport, parsePeriod } = require("../services/salesTargets");
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

module.exports = router;
