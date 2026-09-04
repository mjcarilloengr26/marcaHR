const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const { notifyExpenseSubmitted, notifyExpenseStatusChanged } = require("../notifications");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

const { EXPENSE_TYPES, TITLES, CATEGORIES, resolveChoice } = require("../services/expenseOptions");

// Accepts a base64 data URL (image, PDF, etc.) or null. Caps the stored size
// defensively even though express.json()'s limit already bounds the whole
// request — a single field shouldn't be allowed to approach that cap.
function parseReceipt(body) {
  const data = body?.receipt_data;
  if (!data) return { name: null, type: null, data: null };
  if (typeof data !== "string" || !data.startsWith("data:") || data.length > 6_000_000) {
    return { name: null, type: null, data: null };
  }
  return {
    name: typeof body.receipt_name === "string" ? body.receipt_name.slice(0, 255) : null,
    type: typeof body.receipt_type === "string" ? body.receipt_type.slice(0, 100) : null,
    data,
  };
}

// Receipt blobs are deliberately excluded from the item list. A report's
// receipts are the overwhelming majority of its payload — a single one runs to
// a third of a megabyte base64 — and opening a report only needs to know that
// an attachment exists, not to carry it. has_receipt drives the paperclip
// link, which fetches the bytes from GET /:id/items/:itemId/receipt when
// someone actually clicks it.
//
// Same reasoning, and the same shape, as the attendance list's
// has_clock_in_photo.
const ITEM_COLUMNS = `id, report_id, expense_date, category, description, amount, receipt_ref,
  receipt_name, receipt_type, supplier_name, supplier_address, supplier_tin,
  (receipt_data IS NOT NULL) AS has_receipt`;

async function withTotals(report) {
  const totals = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expense_items WHERE report_id = ?")
    .get(report.id);
  const total_expenses = totals.total;
  return {
    ...report,
    total_expenses,
    balance: Number((report.cash_advance_amount - total_expenses).toFixed(2)),
  };
}

// Same shape as withTotals, but for a whole list at once: one GROUP BY query
// for every report's item sum instead of one query per report. The list
// endpoint used to award each report its own round trip via withTotals in a
// loop — harmless at a handful of reports, but a real, growing N+1 as reports
// accumulate (measured ~2.9s for just 11 reports before this fix).
async function withTotalsBatch(reports) {
  if (reports.length === 0) return [];
  const placeholders = reports.map(() => "?").join(",");
  const sums = await db
    .prepare(`SELECT report_id, COALESCE(SUM(amount), 0) AS total FROM expense_items WHERE report_id IN (${placeholders}) GROUP BY report_id`)
    .all(...reports.map((r) => r.id));
  const totalByReportId = new Map(sums.map((s) => [s.report_id, s.total]));

  // What each report was actually spent on, so the list can show the split
  // without opening every row. One query for the whole page, same as the
  // totals above — a per-report query here would reintroduce the N+1 that
  // withTotalsBatch exists to avoid.
  //
  // Grouped case-insensitively and labelled with the spelling used most often
  // in that report: "sop" and "SOP" are one category typed twice and must not
  // appear as two lines. mode() picks the spelling rather than an arbitrary
  // MIN, which would silently prefer whichever sorts first.
  const catRows = await db
    .prepare(
      `SELECT report_id,
              COALESCE(NULLIF(TRIM(mode() WITHIN GROUP (ORDER BY category)), ''), 'Uncategorised') AS category,
              COALESCE(SUM(amount), 0) AS total,
              COUNT(*)::int AS items
       FROM expense_items
       WHERE report_id IN (${placeholders})
       GROUP BY report_id, LOWER(TRIM(COALESCE(category, '')))
       ORDER BY report_id, 3 DESC`
    )
    .all(...reports.map((r) => r.id));

  const catsByReportId = new Map();
  for (const c of catRows) {
    const list = catsByReportId.get(c.report_id) || [];
    list.push({ category: c.category, total: c.total, items: c.items });
    catsByReportId.set(c.report_id, list);
  }

  return reports.map((report) => {
    const total_expenses = totalByReportId.get(report.id) || 0;
    return {
      ...report,
      total_expenses,
      categories: catsByReportId.get(report.id) || [],
      balance: Number((report.cash_advance_amount - total_expenses).toFixed(2)),
    };
  });
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name,
                    a.reference AS advance_reference, a.amount AS advance_amount
             FROM expense_reports r
             JOIN employees e ON e.id = r.employee_id
             LEFT JOIN cash_advances a ON a.id = r.cash_advance_id
             WHERE 1=1`;
    const params = [];

    if (req.user.role === "employee") {
      sql += " AND r.employee_id = ?";
      params.push(req.user.employee_id);
    } else if (req.query.employee_id) {
      sql += " AND r.employee_id = ?";
      params.push(req.query.employee_id);
    }

    if (req.query.status) {
      sql += " AND r.status = ?";
      params.push(req.query.status);
    }

    sql += " ORDER BY r.created_at DESC";
    const reports = await db.prepare(sql).all(...params);
    res.json(await withTotalsBatch(reports));
  })
);

// The vocabularies the form must offer. Served rather than duplicated in the
// page so the list on screen cannot drift from the list the server enforces.
// Declared before "/:id" or Express would read "options" as a report id.
router.get(
  "/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ types: EXPENSE_TYPES, titles: TITLES, categories: CATEGORIES });
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res, next) => {
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    req.expenseReport = report;
    next();
  }),
  requireSelfOrRole((req) => req.expenseReport.employee_id, "admin", "hr"),
  asyncHandler(async (req, res) => {
    const employee = await db
      .prepare("SELECT first_name, last_name, email FROM employees WHERE id = ?")
      .get(req.expenseReport.employee_id);
    const items = await db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM expense_items WHERE report_id = ? ORDER BY expense_date, id`)
      .all(req.params.id);
    res.json({ ...(await withTotals(req.expenseReport)), employee, items });
  })
);

// One receipt's actual bytes, fetched only when someone opens it. Guarded the
// same way as the report it belongs to: the owner, or HR/admin.
router.get(
  "/:id/items/:itemId/receipt",
  requireAuth,
  asyncHandler(async (req, res, next) => {
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    req.expenseReport = report;
    next();
  }),
  requireSelfOrRole((req) => req.expenseReport.employee_id, "admin", "hr"),
  asyncHandler(async (req, res) => {
    // Matched on the report too, so an id from another report cannot be read
    // through a report the caller happens to have access to.
    const item = await db
      .prepare("SELECT receipt_name, receipt_type, receipt_data FROM expense_items WHERE id = ? AND report_id = ?")
      .get(req.params.itemId, req.params.id);
    if (!item || !item.receipt_data) return res.status(404).json({ error: "No receipt attached to that item" });
    res.json({ receipt_name: item.receipt_name, receipt_type: item.receipt_type, receipt_data: item.receipt_data });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const employee_id = req.user.role === "employee" ? req.user.employee_id : body.employee_id || req.user.employee_id;
    const { expense_type, cash_advance_amount, cost_center, notes, cash_advance_id } = body;
    if (!employee_id) return res.status(400).json({ error: "employee is required" });
    if (expense_type && !EXPENSE_TYPES.includes(expense_type)) {
      return res.status(400).json({ error: `expense_type must be one of: ${EXPENSE_TYPES.join(", ")}` });
    }
    const titleChoice = resolveChoice({
      choice: body.title,
      other: body.title_other,
      allowed: TITLES,
      label: "Title / purpose",
    });
    if (titleChoice.error) return res.status(400).json({ error: titleChoice.error });
    const title = titleChoice.value;

    // A report can liquidate a released advance instead of carrying its own.
    // The money then lives on the advance, so the report's own
    // cash_advance_amount is forced to zero — recording it in both places
    // would double-count it everywhere the two are summed.
    let advanceId = null;
    if (cash_advance_id) {
      const advance = await db.prepare("SELECT * FROM cash_advances WHERE id = ?").get(cash_advance_id);
      if (!advance) return res.status(400).json({ error: "That cash advance does not exist" });
      if (advance.employee_id !== Number(employee_id)) {
        return res.status(400).json({ error: "That advance was released to somebody else" });
      }
      if (advance.status !== "open") {
        return res.status(400).json({ error: `That advance is ${advance.status} and cannot take further liquidation` });
      }
      advanceId = advance.id;
    }

    const info = await db
      .prepare(
        `INSERT INTO expense_reports (employee_id, title, expense_type, cash_advance_amount, cost_center, notes, status, cash_advance_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        employee_id,
        title,
        expense_type || null,
        advanceId ? 0 : cash_advance_amount || 0,
        cost_center || null,
        notes || null,
        advanceId
      );
    res
      .status(201)
      .json(await withTotals(await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(info.lastInsertRowid)));
  })
);

async function loadEditableReport(req, res, next) {
  const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
  if (!report) return res.status(404).json({ error: "Expense report not found" });
  const isOwner = req.user.employee_id === report.employee_id;
  const isHr = ["admin", "hr"].includes(req.user.role);
  if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
  if (report.status !== "draft" && !isHr) {
    return res.status(400).json({ error: "Only draft reports can be edited" });
  }
  req.expenseReport = report;
  next();
}

router.put(
  "/:id",
  requireAuth,
  asyncHandler(loadEditableReport),
  asyncHandler(async (req, res) => {
    const { title, expense_type, cash_advance_amount, cost_center, notes } = req.body || {};
    if (expense_type && !EXPENSE_TYPES.includes(expense_type)) {
      return res.status(400).json({ error: `expense_type must be one of: ${EXPENSE_TYPES.join(", ")}` });
    }
    const report = req.expenseReport;
    await db
      .prepare("UPDATE expense_reports SET title = ?, expense_type = ?, cash_advance_amount = ?, cost_center = ?, notes = ? WHERE id = ?")
      .run(
        title ?? report.title,
        expense_type !== undefined ? expense_type || null : report.expense_type,
        cash_advance_amount ?? report.cash_advance_amount,
        cost_center !== undefined ? cost_center : report.cost_center,
        notes !== undefined ? notes : report.notes,
        report.id
      );
    res.json(await withTotals(await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(report.id)));
  })
);

router.delete(
  "/:id",
  requireAuth,
  asyncHandler(loadEditableReport),
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM expense_reports WHERE id = ?").run(req.expenseReport.id);
    res.status(204).end();
  })
);

router.post(
  "/:id/items",
  requireAuth,
  asyncHandler(loadEditableReport),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { expense_date, description, amount, receipt_ref, supplier_name, supplier_address, supplier_tin } = body;
    const categoryChoice = resolveChoice({
      choice: body.category,
      other: body.category_other,
      allowed: CATEGORIES,
      label: "Category",
    });
    if (categoryChoice.error) return res.status(400).json({ error: categoryChoice.error });
    const category = categoryChoice.value;
    if (!expense_date || amount === undefined) {
      return res.status(400).json({ error: "expense_date and amount are required" });
    }
    const receipt = parseReceipt(body);
    const info = await db
      .prepare(
        `INSERT INTO expense_items (report_id, expense_date, category, description, amount, receipt_ref, receipt_name, receipt_type, receipt_data, supplier_name, supplier_address, supplier_tin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.expenseReport.id,
        expense_date,
        category || null,
        description || null,
        amount,
        receipt_ref || null,
        receipt.name,
        receipt.type,
        receipt.data,
        supplier_name?.trim() || null,
        supplier_address?.trim() || null,
        supplier_tin?.trim() || null
      );
    // Without ITEM_COLUMNS this echoes the receipt straight back to the client
    // that just uploaded it, doubling the cost of every attachment for bytes
    // the caller already holds.
    res
      .status(201)
      .json(await db.prepare(`SELECT ${ITEM_COLUMNS} FROM expense_items WHERE id = ?`).get(info.lastInsertRowid));
  })
);

router.delete(
  "/items/:itemId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const item = await db.prepare("SELECT * FROM expense_items WHERE id = ?").get(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Expense item not found" });
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(item.report_id);
    const isOwner = req.user.employee_id === report.employee_id;
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
    if (report.status !== "draft" && !isHr) {
      return res.status(400).json({ error: "Only draft reports can be edited" });
    }
    await db.prepare("DELETE FROM expense_items WHERE id = ?").run(req.params.itemId);
    res.status(204).end();
  })
);

router.put(
  "/:id/submit",
  requireAuth,
  asyncHandler(async (req, res) => {
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    const isOwner = req.user.employee_id === report.employee_id;
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
    if (report.status !== "draft") return res.status(400).json({ error: "Only draft reports can be submitted" });

    const itemCount = (await db.prepare("SELECT COUNT(*) AS c FROM expense_items WHERE report_id = ?").get(report.id)).c;
    if (itemCount === 0) return res.status(400).json({ error: "Add at least one expense item before submitting" });

    await db
      .prepare("UPDATE expense_reports SET status = 'submitted', submitted_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?")
      .run(report.id);
    notifyExpenseSubmitted({ employee_id: report.employee_id, title: report.title });
    res.json(await withTotals(await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(report.id)));
  })
);

router.put(
  "/:id/status",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status, review_note } = req.body || {};
    if (!["approved", "rejected", "reimbursed"].includes(status)) {
      return res.status(400).json({ error: "status must be approved, rejected or reimbursed" });
    }
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    if (status === "reimbursed" && report.status !== "approved") {
      return res.status(400).json({ error: "Only approved reports can be marked reimbursed" });
    }
    if ((status === "approved" || status === "rejected") && report.status !== "submitted") {
      return res.status(400).json({ error: "Only submitted reports can be approved or rejected" });
    }
    await db
      .prepare("UPDATE expense_reports SET status = ?, reviewed_by = ?, review_note = ? WHERE id = ?")
      .run(status, req.user.employee_id || null, review_note || null, req.params.id);
    notifyExpenseStatusChanged({ employee_id: report.employee_id, title: report.title, status });
    res.json(await withTotals(await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id)));
  })
);

module.exports = router;
