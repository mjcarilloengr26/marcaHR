const db = require("../db");

// What has settled a statement, and what is still outstanding.
//
// Three kinds settle a receivable and only one of them is money:
//
//   payment      cash banked.
//   withholding  creditable tax the customer withheld and paid to the BIR on
//                our behalf, evidenced by Form 2307. The invoice is settled by
//                it — chasing the customer for it would be chasing someone who
//                owes nothing — but the business did not receive it, so it
//                must never be counted as cash collected.
//   adjustment   a discount, retention or write-off that was agreed. Settles
//                the receivable; will never arrive.
//
// Kept apart here rather than summed into one figure, because the three answer
// different questions: what is still owed, what reached the bank, and what
// 2307s are owed to us at filing time.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const SUMMARY_SQL = `
  SELECT invoice_id,
         COALESCE(SUM(amount), 0) AS settled,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS paid_cash,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'withholding'), 0) AS withheld,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'adjustment'), 0) AS adjusted,
         COUNT(*)::int AS receipts,
         MAX(received_on) AS last_received_on
  FROM invoice_receipts
  GROUP BY invoice_id`;

// Derived, never typed. An invoice's settlement status is a fact about the
// receipts against it, and a status somebody sets by hand is one that goes
// stale the moment a payment lands.
function settlementOf(invoice, row) {
  const amount = money(invoice.amount);
  const settled = money(row?.settled || 0);
  const outstanding = money(amount - settled);
  return {
    settled,
    outstanding,
    paidCash: money(row?.paid_cash || 0),
    withheld: money(row?.withheld || 0),
    adjusted: money(row?.adjusted || 0),
    // Named receiptCount, not receipts: the list endpoint spreads this over a
    // response that already has a receipts array, and a count silently
    // replacing that array is the kind of collision nothing complains about.
    receiptCount: row?.receipts || 0,
    lastReceivedOn: row?.last_received_on || null,
    // "settled" rather than "paid": some of it may never have been cash.
    settlementStatus: settled <= 0 ? "unsettled" : outstanding > 0 ? "part-settled" : "settled",
    // A customer who has overpaid is a real situation and showing it as
    // negative outstanding is clearer than clamping it to zero and hiding it.
    overpaid: outstanding < 0,
  };
}

const ONE_SQL = `
  SELECT ? AS invoice_id,
         COALESCE(SUM(amount), 0) AS settled,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS paid_cash,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'withholding'), 0) AS withheld,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'adjustment'), 0) AS adjusted,
         COUNT(*)::int AS receipts,
         MAX(received_on) AS last_received_on
  FROM invoice_receipts
  WHERE invoice_id = ?`;

async function settlementFor(invoiceId) {
  return db.prepare(ONE_SQL).get(invoiceId, invoiceId);
}

async function settlementMap() {
  const rows = await db.prepare(SUMMARY_SQL).all();
  return new Map(rows.map((r) => [r.invoice_id, r]));
}

module.exports = { SUMMARY_SQL, settlementOf, settlementMap, settlementFor, money };
