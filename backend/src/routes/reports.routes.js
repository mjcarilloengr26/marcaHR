const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getSalesTargetsReport, parsePeriod, periodDateRange } = require("../services/salesTargets");
const { getExpenseSummary } = require("../services/expenseSummary");
const { companyName } = require("../services/branding");
const { AGING_COLUMNS, staleDealDays } = require("../services/dealAging");
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
    workbook.creator = await companyName();
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
    const staleAfter = await staleDealDays();
    const opportunities = await db
      .prepare(
        `SELECT d.title, d.customer_name, d.value, d.stage, d.expected_close_date, d.competitor,
                substr(d.created_at, 1, 10) AS opened_on,
                (e.first_name || ' ' || e.last_name) AS owner_name, o.order_number AS linked_order_number,
                ${AGING_COLUMNS}
         FROM deals d LEFT JOIN employees e ON e.id = d.owner_id LEFT JOIN orders o ON o.deal_id = d.id
         ORDER BY e.last_name, e.first_name, d.created_at DESC`
      )
      .all();
    const expenseSummary = await getExpenseSummary();
    const period = periodLabel(period_type, period_year, period_index);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = await companyName();
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
        { header: "Competitor", key: "competitor", width: 18 },
        { header: "Value", key: "value", width: 14 },
        { header: "Opened", key: "opened_on", width: 12 },
        { header: "Age (days)", key: "age_days", width: 11 },
        { header: "Days In Stage", key: "days_in_stage", width: 13 },
        { header: "Expected Close", key: "expected_close_date", width: 16 },
        { header: "Days Past Close", key: "days_past_close", width: 15 },
        { header: "Ageing Flag", key: "aging_flag", width: 16 },
        { header: "Order #", key: "linked_order_number", width: 14 },
        { header: "Stage", key: "stage", width: 14 },
      ],
      opportunities.map((r) => {
        const open = !["won", "lost"].includes(r.stage);
        // Spelled out rather than left as a number, so the spreadsheet can be
        // filtered on the flag without anyone rebuilding the rule in Excel.
        const flags = [];
        if (open && r.days_in_stage >= staleAfter) flags.push(`STALLED ${staleAfter}d+`);
        if (open && r.days_past_close !== null && r.days_past_close > 0) flags.push("PAST CLOSE");
        if (open && (r.expected_close_date === null || r.expected_close_date === "")) flags.push("NO CLOSE DATE");
        return {
          ...r,
          owner_name: r.owner_name || "Unassigned",
          competitor: r.competitor || "—",
          expected_close_date: r.expected_close_date || "—",
          days_past_close: r.days_past_close === null ? "—" : r.days_past_close,
          aging_flag: flags.length ? flags.join(" + ") : open ? "OK" : "—",
        };
      })
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
                po.approved_at,
                (e.first_name || ' ' || e.last_name) AS requested_by_name,
                (a.first_name || ' ' || a.last_name) AS approved_by_name,
                w.work_order_number, w.title AS work_order_title, w.customer_name AS work_order_customer
         FROM purchase_orders po
         LEFT JOIN employees e ON e.id = po.requested_by
         LEFT JOIN employees a ON a.id = po.approved_by
         LEFT JOIN work_orders w ON w.id = po.work_order_id
         WHERE po.order_date BETWEEN ? AND ?
         ORDER BY po.order_date DESC`
      )
      .all(start, end);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = await companyName();
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Purchase Orders");
    sheet.columns = [
      { header: "PO #", key: "po_number", width: 14 },
      { header: "Vendor", key: "vendor_name", width: 22 },
      { header: "Description", key: "description", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Work Order", key: "work_order_number", width: 16 },
      { header: "Work Order Title", key: "work_order_title", width: 30 },
      { header: "Job Customer", key: "work_order_customer", width: 24 },
      { header: "Status", key: "status", width: 12 },
      { header: "Raised By", key: "requested_by_name", width: 20 },
      { header: "Approved By", key: "approved_by_name", width: 20 },
      { header: "Approved On", key: "approved_at", width: 20 },
      { header: "Order Date", key: "order_date", width: 14 },
      { header: "Expected Delivery", key: "expected_delivery_date", width: 16 },
      { header: "Received Date", key: "received_date", width: 14 },
    ];
    sheet.addRows(
      rows.map((r) => ({
        ...r,
        requested_by_name: r.requested_by_name || "—",
        approved_by_name: r.approved_by_name || "NOT APPROVED",
        approved_at: r.approved_at || "—",
        // Spelled out rather than blank, so a filter on the column separates
        // job-attributable spend from general overheads.
        work_order_number: r.work_order_number || "UNLINKED",
        work_order_title: r.work_order_title || "—",
        work_order_customer: r.work_order_customer || "—",
      }))
    );
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
        `SELECT er.id, er.title, er.expense_type, er.cost_center, er.cash_advance_amount, er.status,
                er.created_at, er.submitted_at,
                (e.first_name || ' ' || e.last_name) AS employee_name,
                ca.reference AS advance_reference, ca.amount AS advance_amount,
                COALESCE((SELECT SUM(ei.amount) FROM expense_items ei WHERE ei.report_id = er.id), 0) AS total_expenses
         FROM expense_reports er
         JOIN employees e ON e.id = er.employee_id
         LEFT JOIN cash_advances ca ON ca.id = er.cash_advance_id
         WHERE er.created_at::date BETWEEN ? AND ?
         ORDER BY er.created_at DESC`
      )
      .all(start, end);

    // Every individual expense behind those reports, with the date it was
    // actually incurred. The report's own created_at says when the claim was
    // raised, which is often a different month from the spending itself — so
    // a report that only carries the created date cannot be reconciled
    // against a bank or fuel statement.
    const items = await db
      .prepare(
        `SELECT ei.expense_date, ei.category, ei.description, ei.amount,
                ei.supplier_name, ei.supplier_address, ei.supplier_tin, ei.receipt_ref,
                er.id AS report_id, er.title, er.expense_type, er.cost_center, er.status,
                (e.first_name || ' ' || e.last_name) AS employee_name
         FROM expense_items ei
         JOIN expense_reports er ON er.id = ei.report_id
         JOIN employees e ON e.id = er.employee_id
         WHERE er.created_at::date BETWEEN ? AND ?
         ORDER BY ei.expense_date, er.id`
      )
      .all(start, end);

    // Earliest and latest spend per report, so the summary sheet carries the
    // dates too without having to cross-reference the item sheet.
    const span = new Map();
    for (const it of items) {
      const cur = span.get(it.report_id) || { first: it.expense_date, last: it.expense_date };
      if (it.expense_date < cur.first) cur.first = it.expense_date;
      if (it.expense_date > cur.last) cur.last = it.expense_date;
      span.set(it.report_id, cur);
    }

    const withBalance = rows.map((r) => ({
      ...r,
      expense_type: r.expense_type || "Unspecified",
      advance_reference: r.advance_reference || "—",
      // A report that draws on a released advance carries no advance of its
      // own, so balancing against its own zero would report the whole spend
      // as owed back to the employee. The advance it draws on is the figure
      // that matters — and it is shown, so the sheet says where it came from.
      balance: r.advance_reference
        ? Number((r.advance_amount - r.total_expenses).toFixed(2))
        : Number((r.cash_advance_amount - r.total_expenses).toFixed(2)),
      first_expense_date: span.get(r.id)?.first || "",
      last_expense_date: span.get(r.id)?.last || "",
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = await companyName();
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
        { header: "Drawn On Advance", key: "advance_reference", width: 16 },
        { header: "Total Expenses", key: "total_expenses", width: 15 },
        { header: "Balance", key: "balance", width: 14 },
        { header: "Status", key: "status", width: 12 },
        { header: "First Expense", key: "first_expense_date", width: 14 },
        { header: "Last Expense", key: "last_expense_date", width: 14 },
        { header: "Date Created", key: "created_at", width: 18 },
      ],
      withBalance.map((r) => ({ ...r, cost_center: r.cost_center || "—" }))
    );

    addSheet(
      "Expense Items",
      [
        { header: "Expense Date", key: "expense_date", width: 14 },
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Report Title / Purpose", key: "title", width: 22 },
        { header: "Expenses Type", key: "expense_type", width: 18 },
        { header: "Cost Center", key: "cost_center", width: 16 },
        { header: "Category", key: "category", width: 18 },
        { header: "Description", key: "description", width: 34 },
        { header: "Supplier", key: "supplier_name", width: 26 },
        { header: "Supplier Address", key: "supplier_address", width: 32 },
        { header: "Supplier TIN", key: "supplier_tin", width: 16 },
        { header: "Receipt #", key: "receipt_ref", width: 14 },
        { header: "Amount", key: "amount", width: 14 },
        { header: "Report Status", key: "status", width: 13 },
      ],
      items.map((it) => ({
        ...it,
        expense_type: it.expense_type || "Unspecified",
        cost_center: it.cost_center || "—",
        category: it.category || "—",
        description: it.description || "—",
        supplier_name: it.supplier_name || "—",
        supplier_address: it.supplier_address || "—",
        supplier_tin: it.supplier_tin || "—",
        receipt_ref: it.receipt_ref || "—",
      }))
    );

    // Two independent breakdowns of the same rows, one per "type" grouping the
    // Reports page dropdowns support: the broad Operating/Project classification,
    // and the specific per-title purpose (Fuel, Parking, Meals, ...).
    // Rejected reports stay on the Detail and Expense Items sheets, because
    // those are the record and the Status column says what happened. They are
    // left out of every summary below: a refused claim is not spend, and a
    // total that includes it cannot be reconciled against the dashboard.
    const counted = withBalance.filter((r) => r.status !== "rejected");
    const countedItems = items.filter((it) => it.status !== "rejected");

    const sumBy = (keyFn) => {
      const totals = new Map();
      for (const r of counted) {
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

    // By category, from the line items rather than the report title — the same
    // distinction the dashboard draws. A report titled "Allowance per diem"
    // holds meals and transport, and summing by title alone reported Meals at
    // a fraction of what was actually spent on it.
    //
    // Folded case-insensitively and labelled with the spelling used most
    // often, matching the dashboard exactly so the two cannot disagree.
    const categoryTotals = new Map();
    const categorySpellings = new Map();
    for (const it of countedItems) {
      const label = String(it.category || "").trim() || "Uncategorised";
      const key = label.toLowerCase();
      categoryTotals.set(key, (categoryTotals.get(key) || 0) + Number(it.amount || 0));
      const seen = categorySpellings.get(key) || new Map();
      seen.set(label, (seen.get(label) || 0) + 1);
      categorySpellings.set(key, seen);
    }
    const byCategory = [...categoryTotals.entries()]
      .map(([key, total]) => ({
        label: [...categorySpellings.get(key).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
        total: Number(total.toFixed(2)),
      }))
      .sort((a, b) => b.total - a.total);

    addSheet(
      "By Category",
      [
        { header: "Category", key: "label", width: 24 },
        { header: "Total Expenses", key: "total", width: 16 },
      ],
      byCategory
    );

    // Cash advances released in the period, whether or not anything has been
    // liquidated against them yet. Without this an advance sitting entirely
    // unspent appears nowhere in the export, which is exactly the money most
    // worth chasing.
    const advances = await db
      .prepare(
        `SELECT ca.reference, ca.date_released, ca.amount, ca.returned_amount, ca.status,
                ca.purpose, ca.cost_center,
                (e.first_name || ' ' || e.last_name) AS employee_name,
                COALESCE((
                  SELECT SUM(i.amount) FROM expense_reports r
                  JOIN expense_items i ON i.report_id = r.id
                  WHERE r.cash_advance_id = ca.id AND r.status <> 'rejected'
                ), 0) AS liquidated
         FROM cash_advances ca
         JOIN employees e ON e.id = ca.employee_id
         WHERE ca.date_released BETWEEN ? AND ?
         ORDER BY ca.date_released, ca.reference`
      )
      .all(start, end);

    addSheet(
      "Cash Advances",
      [
        { header: "Reference", key: "reference", width: 16 },
        { header: "Employee", key: "employee_name", width: 24 },
        { header: "Released", key: "date_released", width: 14 },
        { header: "Purpose", key: "purpose", width: 26 },
        { header: "Cost Center", key: "cost_center", width: 18 },
        { header: "Amount", key: "amount", width: 14 },
        { header: "Liquidated", key: "liquidated", width: 14 },
        { header: "Cash Returned", key: "returned_amount", width: 14 },
        { header: "Due To Company", key: "due_to_company", width: 16 },
        { header: "Due To Employee", key: "due_to_employee", width: 16 },
        { header: "Status", key: "status", width: 12 },
      ],
      advances.map((a) => {
        const outstanding = Number((a.amount - a.returned_amount - a.liquidated).toFixed(2));
        return {
          ...a,
          purpose: a.purpose || "—",
          cost_center: a.cost_center || "—",
          liquidated: Number(Number(a.liquidated).toFixed(2)),
          // Split across two columns rather than one signed figure: a
          // spreadsheet gets summed, and a column mixing what is owed each way
          // sums to something that means nothing.
          due_to_company: outstanding > 0 ? outstanding : 0,
          due_to_employee: outstanding < 0 ? Math.abs(outstanding) : 0,
        };
      })
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

// Inventory sits with procurement/operations rather than finance, so it uses
// the same admin/HR-or-finance gate as payroll and expenses.
//
// Two sheets, because the two halves answer different questions and only one
// of them is period-bound: "Stock On Hand" is a snapshot of every item as it
// stands right now (a stock level has no meaning "for last March"), while
// "Stock Movements" covers what actually moved during the chosen period.
router.get(
  "/inventory-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isAdminHrOrFinance(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);

    const items = await db
      .prepare(
        `SELECT i.sku, i.name, i.category, i.unit, i.quantity_on_hand, i.reorder_level,
                i.unit_cost, i.unit_price, i.notes, l.name AS location_name
         FROM inventory_items i LEFT JOIN locations l ON l.id = i.location_id
         ORDER BY i.name`
      )
      .all();

    const movements = await db
      .prepare(
        `SELECT t.created_at, i.sku, i.name AS item_name, i.unit, t.type, t.quantity,
                t.reason, t.reference, (e.first_name || ' ' || e.last_name) AS created_by_name
         FROM inventory_transactions t
         JOIN inventory_items i ON i.id = t.item_id
         LEFT JOIN employees e ON e.id = t.created_by
         WHERE t.created_at BETWEEN ? AND ?
         ORDER BY t.created_at DESC`
      )
      .all(`${start} 00:00:00`, `${end} 23:59:59`);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = await companyName();
    workbook.created = new Date();

    const stockSheet = workbook.addWorksheet("Stock On Hand");
    stockSheet.columns = [
      { header: "SKU", key: "sku", width: 22 },
      { header: "Item", key: "name", width: 34 },
      { header: "Category", key: "category", width: 18 },
      { header: "Unit", key: "unit", width: 10 },
      { header: "On Hand", key: "quantity_on_hand", width: 12 },
      { header: "Reorder Level", key: "reorder_level", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Unit Cost", key: "unit_cost", width: 12 },
      { header: "Stock Value", key: "stock_value", width: 14 },
      { header: "Unit Price", key: "unit_price", width: 12 },
      { header: "Location", key: "location_name", width: 18 },
      { header: "Notes", key: "notes", width: 30 },
    ];
    stockSheet.addRows(
      items.map((i) => ({
        ...i,
        // Mirrors the same reorder-level rule the Inventory page shows on
        // screen, so the spreadsheet and the app never disagree about what
        // counts as low.
        status:
          i.reorder_level > 0 && i.quantity_on_hand <= i.reorder_level
            ? "REORDER"
            : i.quantity_on_hand === 0
              ? "OUT OF STOCK"
              : "OK",
        stock_value: Number(((i.quantity_on_hand || 0) * (i.unit_cost || 0)).toFixed(2)),
        location_name: i.location_name || "—",
        category: i.category || "—",
        notes: i.notes || "",
      }))
    );
    stockSheet.getRow(1).font = { bold: true };

    const totalValue = items.reduce((s, i) => s + (i.quantity_on_hand || 0) * (i.unit_cost || 0), 0);
    const totalRow = stockSheet.addRow({
      name: `TOTAL — ${items.length} items`,
      stock_value: Number(totalValue.toFixed(2)),
    });
    totalRow.font = { bold: true };

    const moveSheet = workbook.addWorksheet("Stock Movements");
    moveSheet.columns = [
      { header: "Date", key: "created_at", width: 20 },
      { header: "SKU", key: "sku", width: 22 },
      { header: "Item", key: "item_name", width: 34 },
      { header: "Type", key: "type", width: 12 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Unit", key: "unit", width: 10 },
      { header: "Reason", key: "reason", width: 26 },
      { header: "Reference", key: "reference", width: 18 },
      { header: "Recorded By", key: "created_by_name", width: 22 },
    ];
    moveSheet.addRows(
      movements.map((m) => ({
        ...m,
        reason: m.reason || "—",
        reference: m.reference || "—",
        created_by_name: m.created_by_name || "—",
      }))
    );
    moveSheet.getRow(1).font = { bold: true };

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "inventory", period_type, period_year, period_index },
    });

    const filename = `marca-group-inventory-report-${period_year}-${period_type}-${period_index}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

router.get(
  "/assets-export",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await isAdminHrOrFinance(req))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { period_type, period_year, period_index } = parsePeriod(req.query);
    const { start, end } = periodDateRange(period_type, period_year, period_index);

    const SELECT = `SELECT a.*, (e.first_name || ' ' || e.last_name) AS employee_name,
                           e.status AS employee_status, d.name AS department_name
                    FROM employee_assets a
                    JOIN employees e ON e.id = a.employee_id
                    LEFT JOIN departments d ON d.id = e.department_id`;

    // Everything still out, as of today — the question an asset register is
    // actually asked. Deliberately not period-filtered, the same way the
    // inventory report's stock-on-hand sheet is a snapshot.
    const onIssue = await db
      .prepare(`${SELECT} WHERE a.status = 'active' ORDER BY e.last_name, e.first_name, a.asset_type`)
      .all();

    // Anything that changed hands during the period, issued or given back.
    const movements = await db
      .prepare(
        `${SELECT} WHERE (a.date_issued BETWEEN ? AND ?) OR (a.date_returned BETWEEN ? AND ?)
         ORDER BY COALESCE(a.date_returned, a.date_issued) DESC`
      )
      .all(start, end, start, end);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = await companyName();
    workbook.created = new Date();

    const COLUMNS = [
      { header: "Employee", key: "employee_name", width: 26 },
      { header: "Department", key: "department_name", width: 18 },
      { header: "Asset", key: "asset_type", width: 18 },
      { header: "Brand", key: "brand", width: 16 },
      { header: "Model", key: "model", width: 24 },
      { header: "Serial Number", key: "serial_number", width: 24 },
      { header: "Asset Tag", key: "asset_tag", width: 14 },
      { header: "Date Issued", key: "date_issued", width: 14 },
      { header: "Date Returned", key: "date_returned", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Condition", key: "condition_note", width: 22 },
      { header: "Market Value", key: "market_value", width: 14 },
      { header: "Notes", key: "notes", width: 30 },
    ];
    const shape = (rows) =>
      rows.map((a) => ({
        ...a,
        department_name: a.department_name || "—",
        brand: a.brand || "—",
        model: a.model || "—",
        serial_number: a.serial_number || "—",
        asset_tag: a.asset_tag || "—",
        date_returned: a.date_returned || "—",
        condition_note: a.condition_note || "—",
        market_value: a.market_value == null ? "—" : Number(a.market_value),
        notes: a.notes || "",
      }));

    const issuedSheet = workbook.addWorksheet("Assets On Issue");
    issuedSheet.columns = COLUMNS;
    issuedSheet.addRows(shape(onIssue));
    issuedSheet.getRow(1).font = { bold: true };
    const issuedTotal = issuedSheet.addRow({
      employee_name: `TOTAL — ${onIssue.length} assets still issued`,
      market_value: Number(onIssue.reduce((sum, a) => sum + (a.market_value || 0), 0).toFixed(2)),
    });
    issuedTotal.font = { bold: true };

    const movementSheet = workbook.addWorksheet("Issued & Returned");
    movementSheet.columns = COLUMNS;
    movementSheet.addRows(shape(movements));
    movementSheet.getRow(1).font = { bold: true };

    // One line per employee, for the handover check when somebody leaves.
    const byEmployee = new Map();
    for (const a of onIssue) {
      const key = a.employee_name;
      if (!byEmployee.has(key)) {
        byEmployee.set(key, { employee_name: key, department_name: a.department_name || "—", count: 0, value: 0, assets: [] });
      }
      const row = byEmployee.get(key);
      row.count += 1;
      row.value = Number((row.value + (a.market_value || 0)).toFixed(2));
      row.assets.push([a.asset_type, a.brand, a.model].filter(Boolean).join(" "));
    }
    const summarySheet = workbook.addWorksheet("Holdings By Employee");
    summarySheet.columns = [
      { header: "Employee", key: "employee_name", width: 26 },
      { header: "Department", key: "department_name", width: 18 },
      { header: "Assets Held", key: "count", width: 12 },
      { header: "Total Value", key: "value", width: 14 },
      { header: "Items", key: "items", width: 70 },
    ];
    summarySheet.addRows(
      [...byEmployee.values()].map((r) => ({ ...r, items: r.assets.join("; ") }))
    );
    summarySheet.getRow(1).font = { bold: true };

    // Requests raised in the period, so the sheet shows what was asked for
    // alongside what was actually handed out.
    const requests = await db
      .prepare(
        `SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name, d.name AS department_name,
                (rv.first_name || ' ' || rv.last_name) AS reviewed_by_name,
                a.serial_number AS issued_serial
         FROM asset_requests r
         JOIN employees e ON e.id = r.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN employees rv ON rv.id = r.reviewed_by
         LEFT JOIN employee_assets a ON a.id = r.asset_id
         WHERE substr(r.created_at, 1, 10) BETWEEN ? AND ?
         ORDER BY r.created_at DESC`
      )
      .all(start, end);

    const requestSheet = workbook.addWorksheet("Asset Requests");
    requestSheet.columns = [
      { header: "Requested", key: "created_at", width: 20 },
      { header: "Employee", key: "employee_name", width: 26 },
      { header: "Department", key: "department_name", width: 18 },
      { header: "Asset Requested", key: "asset_type", width: 22 },
      { header: "Qty", key: "quantity", width: 8 },
      { header: "Reason", key: "reason", width: 34 },
      { header: "Needed By", key: "needed_by", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Decided By", key: "reviewed_by_name", width: 22 },
      { header: "Decided On", key: "reviewed_at", width: 20 },
      { header: "Note", key: "review_note", width: 30 },
      { header: "Issued Serial", key: "issued_serial", width: 24 },
    ];
    requestSheet.addRows(
      requests.map((r) => ({
        ...r,
        department_name: r.department_name || "—",
        reason: r.reason || "—",
        needed_by: r.needed_by || "—",
        reviewed_by_name: r.reviewed_by_name || "—",
        reviewed_at: r.reviewed_at || "—",
        review_note: r.review_note || "—",
        issued_serial: r.issued_serial || "—",
      }))
    );
    requestSheet.getRow(1).font = { bold: true };
    const pending = requests.filter((r) => r.status === "pending").length;
    const pendingRow = requestSheet.addRow({
      employee_name: `TOTAL — ${requests.length} requests, ${pending} still awaiting a decision`,
    });
    pendingRow.font = { bold: true };

    await logRequestEvent(req, "export_excel", {
      entityType: "report",
      details: { report: "assets", period_type, period_year, period_index },
    });

    const filename = `marca-group-company-assets-report-${period_year}-${period_type}-${period_index}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
