const db = require("../db");

// Finding expense lines that look like the same receipt claimed twice.
//
// Four checks, ranked by how sure each one lets you be. None of them blocks
// anything: two taxi rides at the same fare on the same day are genuinely
// identical and genuinely both real, so a false positive that refused a claim
// would cost an employee their own money. They surface for a person to judge.
//
// A line is reported once, at the highest tier that catches it — a pair that
// shares a receipt number will usually share a date and amount too, and
// listing it three times would bury the two clusters that need real attention.

// Rejected reports are excluded. A rejected claim has not been paid and is not
// going to be, so a line inside one cannot be a double payment — and leaving
// them in means every corrected-and-resubmitted report flags against the
// version it replaced.
const LIVE = "('draft','submitted','approved','reimbursed')";

// Vendor names are typed by hand, so "Shell  Katipunan" and "shell katipunan"
// are the same vendor and have to hash to the same key.
const VENDOR = "lower(btrim(regexp_replace(i.supplier_name, '\\s+', ' ', 'g')))";

const TIERS = {
  1: {
    label: "Same receipt number, same vendor",
    detail: "An official receipt number is unique per vendor, so two lines carrying the same one are the same receipt — or one of them was mistyped.",
    certainty: "certain",
  },
  2: {
    label: "The same receipt image, filed more than once",
    detail: "Byte-for-byte the same file. Nothing typed around it can disguise this one.",
    certainty: "certain",
  },
  3: {
    label: "Same vendor, same day, same amount",
    detail: "No receipt number was entered on these, so they cannot be told apart by one. Often a line keyed in twice — but two identical small purchases on one day do happen.",
    certainty: "strong",
  },
  4: {
    label: "Two people claiming the same purchase",
    detail: "The same vendor, day and amount on two different employees' reports. Usually one receipt that has been claimed by both.",
    certainty: "worth a look",
  },
};

// Everything a reviewer needs to judge the cluster without opening each report.
const ITEM_COLUMNS = `
  i.id AS item_id, i.expense_date, i.category, i.description, i.amount,
  i.receipt_ref, i.supplier_name, (i.receipt_data IS NOT NULL) AS has_receipt,
  r.id AS report_id, r.title, r.status, r.employee_id,
  (e.first_name || ' ' || e.last_name) AS employee_name`;

const FROM = `
  FROM expense_items i
  JOIN expense_reports r ON r.id = i.report_id
  JOIN employees e ON e.id = r.employee_id`;

// Each query returns rows already carrying the key that groups them.
const QUERIES = {
  1: `
    SELECT ${VENDOR} || '|' || lower(btrim(i.receipt_ref)) AS group_key, ${ITEM_COLUMNS}
    ${FROM}
    WHERE r.status IN ${LIVE}
      AND COALESCE(btrim(i.receipt_ref), '') <> ''
      AND COALESCE(btrim(i.supplier_name), '') <> ''
      AND (${VENDOR} || '|' || lower(btrim(i.receipt_ref))) IN (
        SELECT ${VENDOR} || '|' || lower(btrim(i.receipt_ref))
        ${FROM}
        WHERE r.status IN ${LIVE}
          AND COALESCE(btrim(i.receipt_ref), '') <> ''
          AND COALESCE(btrim(i.supplier_name), '') <> ''
        GROUP BY 1 HAVING COUNT(*) > 1
      )`,
  2: `
    SELECT i.receipt_hash AS group_key, ${ITEM_COLUMNS}
    ${FROM}
    WHERE r.status IN ${LIVE} AND i.receipt_hash IS NOT NULL
      AND i.receipt_hash IN (
        SELECT i.receipt_hash ${FROM}
        WHERE r.status IN ${LIVE} AND i.receipt_hash IS NOT NULL
        GROUP BY 1 HAVING COUNT(*) > 1
      )`,
  // 3 and 4 share a shape and are split by whether one person or two are
  // involved, which is the difference between a slip and a claim to question.
  34: `
    SELECT ${VENDOR} || '|' || i.expense_date || '|' || i.amount::text AS group_key, ${ITEM_COLUMNS}
    ${FROM}
    WHERE r.status IN ${LIVE}
      AND COALESCE(btrim(i.supplier_name), '') <> ''
      AND i.amount > 0
      AND (${VENDOR} || '|' || i.expense_date || '|' || i.amount::text) IN (
        SELECT ${VENDOR} || '|' || i.expense_date || '|' || i.amount::text
        ${FROM}
        WHERE r.status IN ${LIVE}
          AND COALESCE(btrim(i.supplier_name), '') <> ''
          AND i.amount > 0
        GROUP BY 1 HAVING COUNT(*) > 1
      )`,
};

function groupRows(rows) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row.group_key) || [];
    list.push(row);
    out.set(row.group_key, list);
  }
  return out;
}

const shape = (row) => ({
  item_id: row.item_id,
  report_id: row.report_id,
  title: row.title,
  status: row.status,
  employee_id: row.employee_id,
  employee_name: row.employee_name,
  expense_date: row.expense_date,
  category: row.category,
  description: row.description,
  amount: Number(row.amount),
  receipt_ref: row.receipt_ref,
  supplier_name: row.supplier_name,
  has_receipt: !!row.has_receipt,
});

async function findDuplicates() {
  const [tier1, tier2, tier34, reviews] = await Promise.all([
    db.prepare(QUERIES[1]).all(),
    db.prepare(QUERIES[2]).all(),
    db.prepare(QUERIES[34]).all(),
    db.prepare("SELECT cluster_key, verdict, note, decided_at, decided_by FROM expense_duplicate_reviews").all(),
  ]);

  const decided = new Map(reviews.map((r) => [r.cluster_key, r]));
  const clusters = [];
  // A line already reported at a higher tier is not reported again lower down.
  const claimed = new Set();

  const collect = (tier, rows, filter) => {
    for (const [key, items] of groupRows(rows)) {
      const kept = items.filter((i) => !claimed.has(i.item_id));
      if (kept.length < 2) continue;
      if (filter && !filter(kept)) continue;
      for (const i of kept) claimed.add(i.item_id);
      clusters.push({
        key: `${tier}:${key}`,
        tier,
        ...TIERS[tier],
        items: kept.map(shape),
        total: kept.reduce((n, i) => n + Number(i.amount), 0),
        // What is at stake if these really are one receipt: everything past
        // the first copy.
        exposure: kept.slice(1).reduce((n, i) => n + Number(i.amount), 0),
      });
    }
  };

  collect(1, tier1);
  collect(2, tier2);
  // Same person twice over is tier 3; two people is tier 4.
  collect(4, tier34, (items) => new Set(items.map((i) => i.employee_id)).size > 1);
  collect(3, tier34, (items) => items.every((i) => !String(i.receipt_ref || "").trim()));

  for (const c of clusters) {
    const review = decided.get(c.key);
    c.review = review || null;
  }

  // Certain first, then by what is at stake. A cleared cluster drops to the
  // bottom rather than vanishing, so a decision can be looked at again.
  clusters.sort((a, b) => {
    const aDone = a.review ? 1 : 0;
    const bDone = b.review ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.exposure - a.exposure;
  });

  return {
    clusters,
    open_count: clusters.filter((c) => !c.review).length,
    exposure: clusters.filter((c) => !c.review).reduce((n, c) => n + c.exposure, 0),
  };
}

module.exports = { findDuplicates, TIERS };
