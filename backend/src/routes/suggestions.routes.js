const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// Only these are offered, keyed by name rather than taking a table and column
// from the caller — a query string that reaches straight into any column is an
// injection waiting to happen, and there is no reason to allow it.
//
// Several names read from more than one table on purpose: a customer typed on
// an opportunity should be suggested when raising the invoice, otherwise the
// same company ends up spelled three ways across three modules and nothing
// about it can be totalled.
const SOURCES = {
  customer_name: [
    { table: "deals", column: "customer_name" },
    { table: "orders", column: "customer_name" },
    { table: "invoices", column: "customer_name" },
    { table: "work_orders", column: "customer_name" },
  ],
  vendor_name: [{ table: "purchase_orders", column: "vendor_name" }],
  supplier_name: [{ table: "expense_items", column: "supplier_name" }],
  competitor: [{ table: "deals", column: "competitor" }],
  cost_center: [{ table: "expense_reports", column: "cost_center" }],
  expense_title: [{ table: "expense_reports", column: "title" }],
  project_title: [
    { table: "deals", column: "title" },
    { table: "work_orders", column: "title" },
  ],
  category: [{ table: "expense_items", column: "category" }],
  item_category: [{ table: "inventory_items", column: "category" }],
};

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const field = String(req.query.field || "");
    const sources = SOURCES[field];
    if (!sources) {
      return res.status(400).json({ error: `Unknown field. Available: ${Object.keys(SOURCES).join(", ")}` });
    }

    // Union across the sources, then fold case and surrounding whitespace so
    // "Acme Corp", "acme corp" and " Acme Corp" collapse to one suggestion —
    // the live data already has a customer stored with a leading space.
    const union = sources
      .map((s) => `SELECT btrim(${s.column}) AS v FROM ${s.table} WHERE ${s.column} IS NOT NULL AND btrim(${s.column}) <> ''`)
      .join(" UNION ALL ");

    const rows = await db
      .prepare(
        `SELECT v AS value, COUNT(*)::int AS uses
         FROM (${union}) t
         GROUP BY v
         ORDER BY COUNT(*) DESC, v ASC
         LIMIT 300`
      )
      .all();

    res.json({ field, values: rows.map((r) => r.value), detail: rows });
  })
);

module.exports = { router, SOURCES };
