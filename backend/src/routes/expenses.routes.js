const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const { notifyExpenseSubmitted, notifyExpenseStatusChanged } = require("../notifications");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { advancePositions } = require("../services/advancePosition");
const { resolveCostCenter } = require("../services/costCenterName");

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

// `balance` is kept for out-of-pocket claims, where a debt really is created
// by the report and really is owed to the employee. On a funded report it is
// zero: the cash left the company when the advance was released, and this
// report only accounts for where it went.
function shapeTotals(report, total_expenses, extra = {}) {
  const position = report.cash_advance_id ? extra.position : null;
  return {
    ...report,
    total_expenses,
    ...(extra.categories ? { categories: extra.categories } : {}),
    ...(position || {}),
    balance: position ? 0 : Number((report.cash_advance_amount - total_expenses).toFixed(2)),
  };
}

// Who was paid, where they are, and their TIN. Mandatory on every line, with
// one deliberate escape.
//
// The export already carried these three columns and they came out as "—",
// because nothing ever made anyone fill them in — so the admin retyped supplier
// details by hand off the receipt photos when preparing a report. Requiring
// them at entry is the only place that can be fixed: the person holding the
// receipt is the only one who can read it.
//
// The escape is "N/A", which the form fills in when a line genuinely has no
// receipt. A great many real expenses have none, and forcing an invention
// would be worse than an honest blank — but it has to be an explicit N/A
// rather than an empty box, so a reader can tell "no receipt exists" apart
// from "nobody bothered".
const NO_RECEIPT = "N/A";

function resolveSupplier(raw, where) {
  const out = {};
  for (const field of ["supplier_name", "supplier_address", "supplier_tin"]) {
    const v = String(raw?.[field] ?? "").trim();
    if (!v) {
      const label = field.replace("supplier_", "").replace("tin", "TIN");
      return { error: `${where}: give the supplier ${label}, or mark the line as having no receipt` };
    }
    out[field] = v;
  }
  return out;
}

// The report's title is derived from what is on it, never typed.
//
// It used to be its own dropdown drawn from the same vocabulary as the line
// categories, so the form asked the same question twice and the two answers
// could disagree: a report titled "Maintenance" holding items categorised
// "Car Maintenance" produced two dashboard charts with identical amounts and
// different labels. Worse, a title is one value for a whole report while money
// is spent per line, so a report covering several categories landed entirely
// in one bucket — 29,954 of Meals, Transport, Laundry and fees all credited to
// "Allowance".
//
// Categories are per line and therefore true, so the title now follows them.
function deriveTitle(categories) {
  const seen = [];
  for (const c of categories) {
    const v = typeof c === "string" ? c.trim() : "";
    if (v && !seen.some((s) => s.toLowerCase() === v.toLowerCase())) seen.push(v);
  }
  if (seen.length === 0) return null;
  if (seen.length === 1) return seen[0];
  // Names the largest contributor rather than listing all of them, which would
  // not fit a column: the count says the rest are there.
  return `${seen[0]} + ${seen.length - 1} more`;
}

// Recomputed after any change to the lines. Without this the title is right
// when the report is filed and silently wrong the moment a line is added,
// edited or removed — which is exactly the drift the derivation exists to end.
async function refreshDerivedTitle(reportId) {
  const rows = await db
    .prepare(
      `SELECT category, SUM(amount) AS total FROM expense_items
       WHERE report_id = ? AND COALESCE(TRIM(category), '') <> ''
       GROUP BY category ORDER BY 2 DESC`
    )
    .all(reportId);
  const title = deriveTitle(rows.map((r) => r.category));
  // A report stripped back to no lines keeps whatever it last said rather than
  // becoming blank, so the list never shows a nameless row.
  if (title) await db.prepare("UPDATE expense_reports SET title = ? WHERE id = ?").run(title, reportId);
  return title;
}

async function withTotals(report) {
  const totals = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expense_items WHERE report_id = ?")
    .get(report.id);
  const total_expenses = totals.total;
  const positions = await advancePositions([report.cash_advance_id]);
  return shapeTotals(report, total_expenses, { position: positions.get(report.cash_advance_id) });
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

  const positions = await advancePositions(reports.map((r) => r.cash_advance_id));

  return reports.map((report) =>
    shapeTotals(report, totalByReportId.get(report.id) || 0, {
      categories: catsByReportId.get(report.id) || [],
      position: positions.get(report.cash_advance_id),
    })
  );
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name,
                    a.reference AS advance_reference, a.amount AS advance_amount,
                    pr.code AS project_code, pr.name AS project_name
             FROM expense_reports r
             JOIN employees e ON e.id = r.employee_id
             LEFT JOIN cash_advances a ON a.id = r.cash_advance_id
             LEFT JOIN projects pr ON pr.id = r.project_id
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
    const { expense_type, cash_advance_amount, cost_center, notes, cash_advance_id, project_id } = body;
    if (!employee_id) return res.status(400).json({ error: "employee is required" });
    // Type, cost centre and category are all mandatory now. Every breakdown on
    // the dashboard groups by one of them, and a blank turns into an
    // "Unspecified" slice that means nothing and cannot be acted on — the
    // report has to say which pot the money came out of.
    if (!expense_type) {
      return res.status(400).json({ error: "Expenses type is required" });
    }
    if (!EXPENSE_TYPES.includes(expense_type)) {
      return res.status(400).json({ error: `expense_type must be one of: ${EXPENSE_TYPES.join(", ")}` });
    }
    const cc = await resolveCostCenter(body.cost_center, { required: true });
    if (cc.error) return res.status(400).json({ error: cc.error });
    body.cost_center = cc.name;

    // Lines can arrive with the report, so one dialog creates both. They stay
    // optional: the backend ships before the frontend, and for those few
    // minutes the old page is still posting a header on its own.
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const lines = [];
    for (const [i, raw] of rawItems.entries()) {
      const where = `Line ${i + 1}`;
      const categoryChoice = resolveChoice({
        choice: raw?.category,
        other: raw?.category_other,
        allowed: CATEGORIES,
        label: `${where} category`,
      });
      if (categoryChoice.error) return res.status(400).json({ error: categoryChoice.error });

      const expense_date = String(raw?.expense_date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
        return res.status(400).json({ error: `${where}: give the date as YYYY-MM-DD` });
      }
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: `${where}: amount must be more than zero` });
      }
      let receipt;
      try {
        receipt = parseReceipt(raw || {});
      } catch (err) {
        return res.status(400).json({ error: `${where}: ${err.message}` });
      }
      const supplier = resolveSupplier(raw, where);
      if (supplier.error) return res.status(400).json({ error: supplier.error });
      lines.push({
        expense_date,
        category: categoryChoice.value,
        description: String(raw?.description || "").trim() || null,
        amount,
        receipt_ref: String(raw?.receipt_ref || "").trim() || null,
        receipt,
        ...supplier,
      });
    }

    // Title comes from the lines when there are lines. The old title field is
    // still honoured when a caller sends one and no lines, which is what the
    // previous page does — and what every report already in the database was
    // created with.
    let title = null;
    if (lines.length > 0) {
      const byCategory = new Map();
      for (const l of lines) byCategory.set(l.category, (byCategory.get(l.category) || 0) + l.amount);
      const ordered = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
      title = deriveTitle(ordered);
    } else {
      const titleChoice = resolveChoice({
        choice: body.title,
        other: body.title_other,
        allowed: TITLES,
        label: "Title / purpose",
      });
      if (titleChoice.error) return res.status(400).json({ error: titleChoice.error });
      title = titleChoice.value;
    }

    // Two kinds of claim, and the difference is whether money was handed over
    // first.
    //
    // A liquidation accounts for a released advance: the money lives on the
    // advance and nowhere else, so the report never carries an amount of its
    // own — recording it in both places would double-count it everywhere the
    // two are summed.
    //
    // A reimbursement is out of pocket. There is no advance to name and
    // requiring one would mean nobody could claim back a PHP 200 taxi without
    // asking for cash first, which is not how anybody works.
    let advance = null;
    if (cash_advance_id) {
      advance = await db.prepare("SELECT * FROM cash_advances WHERE id = ?").get(cash_advance_id);
      if (!advance) return res.status(400).json({ error: "That cash advance does not exist" });
      if (advance.employee_id !== Number(employee_id)) {
        return res.status(400).json({ error: "That advance was released to somebody else" });
      }
      if (advance.status !== "open") {
        return res.status(400).json({ error: `That advance is ${advance.status} and cannot take liquidation` });
      }
    }
    const advanceId = advance ? advance.id : null;

    // One transaction: a report that exists with none of its lines is the
    // phantom draft the merged dialog is meant to stop creating.
    let reportId;
    await db.transaction(async () => {
      const info = await db
        .prepare(
          `INSERT INTO expense_reports (employee_id, title, expense_type, cash_advance_amount, cost_center, notes, status, cash_advance_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
        )
        .run(
          employee_id,
          title,
          expense_type || null,
          0,
          // body.cost_center, not the destructured copy: the check above rewrites
          // it to the spelling the admin defined, and the copy was taken before
          // that. Independent of the advance on purpose — one advance can fund
          // several projects, so inheriting its cost centre would file work
          // against the wrong one more often than the right one.
          body.cost_center || null,
          notes || null,
          advanceId,
          // Optional, and left null rather than guessed. Overheads genuinely
          // belong to no project, and inventing a link would put made-up cost
          // into a project P&L that is meant to be the trustworthy one.
          project_id || null
        );
      reportId = info.lastInsertRowid;

      for (const l of lines) {
        await db
          .prepare(
            `INSERT INTO expense_items (report_id, expense_date, category, description, amount, receipt_ref, receipt_name, receipt_type, receipt_data, supplier_name, supplier_address, supplier_tin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            reportId, l.expense_date, l.category, l.description, l.amount, l.receipt_ref,
            l.receipt.name, l.receipt.type, l.receipt.data,
            l.supplier_name, l.supplier_address, l.supplier_tin
          );
      }
    })();

    await logRequestEvent(req, "create_expense_report", {
      entityType: "expense_report",
      entityId: reportId,
      details: { title, expense_type, cost_center: body.cost_center, lines: lines.length },
    });

    res
      .status(201)
      .json(await withTotals(await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(reportId)));
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
    const { title, expense_type, cash_advance_amount, cost_center, notes, project_id } = req.body || {};
    // Held to the same rule as creating one, or a report could be filed
    // correctly and then edited back to blank.
    if (expense_type !== undefined) {
      if (!expense_type) return res.status(400).json({ error: "Expenses type is required" });
      if (!EXPENSE_TYPES.includes(expense_type)) {
        return res.status(400).json({ error: `expense_type must be one of: ${EXPENSE_TYPES.join(", ")}` });
      }
    }
    let costCenterName = cost_center;
    if (cost_center !== undefined) {
      const cc = await resolveCostCenter(cost_center, { required: true });
      if (cc.error) return res.status(400).json({ error: cc.error });
      costCenterName = cc.name;
    }
    const report = req.expenseReport;
    await db
      .prepare(
        "UPDATE expense_reports SET title = ?, expense_type = ?, cash_advance_amount = ?, cost_center = ?, notes = ?, project_id = ? WHERE id = ?"
      )
      .run(
        title ?? report.title,
        expense_type !== undefined ? expense_type || null : report.expense_type,
        cash_advance_amount ?? report.cash_advance_amount,
        cost_center !== undefined ? costCenterName : report.cost_center,
        notes !== undefined ? notes : report.notes,
        project_id !== undefined ? project_id || null : report.project_id,
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
    await refreshDerivedTitle(req.expenseReport.id);
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
    await refreshDerivedTitle(item.report_id);
    res.status(204).end();
  })
);

// Edit one line. Removing and retyping was the only way to correct a figure or
// a category, which on a rejected report meant re-entering the receipt too —
// the exact thing that had been queried.
//
// Guarded like the delete above: the owner while the report is a draft, or HR
// at any time.
router.put(
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

    const body = req.body || {};
    const categoryChoice = resolveChoice({
      choice: body.category,
      other: body.category_other,
      allowed: CATEGORIES,
      label: "Category",
    });
    if (categoryChoice.error) return res.status(400).json({ error: categoryChoice.error });

    const expense_date = String(body.expense_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      return res.status(400).json({ error: "expense_date must be YYYY-MM-DD" });
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be more than zero" });
    }

    const text = (v) => {
      const t = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
      return t === "" ? null : t;
    };

    // A new file replaces the old one; sending nothing keeps whatever is
    // already attached. Replacing a receipt is the common reason for editing a
    // rejected line, so losing it silently would defeat the point.
    const photo = parseReceipt(body);
    const keepReceipt = !body.receipt_data;

    await db
      .prepare(
        `UPDATE expense_items SET expense_date = ?, category = ?, description = ?, amount = ?,
                receipt_ref = ?, supplier_name = ?, supplier_address = ?, supplier_tin = ?,
                receipt_name = CASE WHEN ?::boolean THEN receipt_name ELSE ? END,
                receipt_type = CASE WHEN ?::boolean THEN receipt_type ELSE ? END,
                receipt_data = CASE WHEN ?::boolean THEN receipt_data ELSE ? END
         WHERE id = ?`
      )
      .run(
        expense_date,
        categoryChoice.value,
        text(body.description),
        amount,
        text(body.receipt_ref),
        text(body.supplier_name),
        text(body.supplier_address),
        text(body.supplier_tin),
        keepReceipt, photo.name,
        keepReceipt, photo.type,
        keepReceipt, photo.data,
        req.params.itemId
      );

    await logRequestEvent(req, "edit_expense_item", {
      entityType: "expense_item",
      entityId: Number(req.params.itemId),
      details: {
        report_id: item.report_id,
        was: { category: item.category, amount: item.amount, expense_date: item.expense_date },
        now: { category: categoryChoice.value, amount, expense_date },
        receipt_replaced: !keepReceipt,
      },
    });

    await refreshDerivedTitle(item.report_id);
    res.json(await db.prepare(`SELECT ${ITEM_COLUMNS} FROM expense_items WHERE id = ?`).get(req.params.itemId));
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

// Send a rejected report back to draft so it can be corrected and submitted
// again. Without this a rejection was terminal: the report froze, and the only
// way to claim the money was to type the whole thing in a second time.
//
// review_note is deliberately kept. Whoever is fixing the report needs to see
// why it came back while they are editing it, and the next decision overwrites
// the note anyway.
router.put(
  "/:id/reopen",
  requireAuth,
  asyncHandler(async (req, res) => {
    const report = await db.prepare("SELECT * FROM expense_reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Expense report not found" });
    const isOwner = req.user.employee_id === report.employee_id;
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isOwner && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
    // Only a rejection reopens. Pulling an approved or reimbursed report back
    // into draft would let settled money be edited after the fact.
    if (report.status !== "rejected") {
      return res.status(400).json({ error: `Only a rejected report can be reopened — this one is ${report.status}` });
    }

    await db
      .prepare("UPDATE expense_reports SET status = 'draft', submitted_at = NULL WHERE id = ?")
      .run(report.id);
    await logRequestEvent(req, "reopen_expense_report", {
      entityType: "expense_report",
      entityId: report.id,
      details: { title: report.title, employee_id: report.employee_id, was: report.review_note || null },
    });
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
