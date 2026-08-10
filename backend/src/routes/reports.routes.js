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
