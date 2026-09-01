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
  supplier_address: [{ table: "expense_items", column: "supplier_address" }],
  supplier_tin: [{ table: "expense_items", column: "supplier_tin" }],
  competitor: [{ table: "deals", column: "competitor" }],
  cost_center: [{ table: "expense_reports", column: "cost_center" }],
  expense_title: [{ table: "expense_reports", column: "title" }],
  project_title: [
    { table: "deals", column: "title" },
    { table: "work_orders", column: "title" },
  ],
  category: [{ table: "expense_items", column: "category" }],
  expense_description: [{ table: "expense_items", column: "description" }],
  item_category: [{ table: "inventory_items", column: "category" }],
  asset_type: [{ table: "employee_assets", column: "asset_type" }],
  asset_brand: [{ table: "employee_assets", column: "brand" }],
  asset_model: [{ table: "employee_assets", column: "model" }],
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

// Suppliers are more than a list of names: an address and a TIN belong to the
// company, and retyping them per receipt is how the same firm ends up filed
// under two spellings with the TIN on only one of them — which the live data
// already shows. Returning the whole profile lets the form fill itself in once
// the name is picked.
router.get(
  "/suppliers",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT (array_agg(btrim(supplier_name) ORDER BY id DESC))[1] AS name,
                (array_agg(btrim(supplier_address) ORDER BY id DESC)
                   FILTER (WHERE btrim(COALESCE(supplier_address, '')) <> ''))[1] AS address,
                (array_agg(btrim(supplier_tin) ORDER BY id DESC)
                   FILTER (WHERE btrim(COALESCE(supplier_tin, '')) <> ''))[1] AS tin,
                COUNT(*)::int AS uses
         FROM expense_items
         WHERE btrim(COALESCE(supplier_name, '')) <> ''
         -- Folded case, so "NA" and "Na" are one supplier rather than two
         -- competing profiles. The most recently used spelling is the one
         -- offered, and the newest non-blank address and TIN win independently:
         -- a receipt entered without a TIN must not blank out a known one.
         GROUP BY lower(btrim(supplier_name))
         ORDER BY COUNT(*) DESC, 1 ASC
         LIMIT 300`
      )
      .all();

    res.json(
      rows.map((r) => ({ name: r.name, address: r.address || "", tin: r.tin || "", uses: r.uses }))
    );
  })
);

module.exports = { router, SOURCES };
