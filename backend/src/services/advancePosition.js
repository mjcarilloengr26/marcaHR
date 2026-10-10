const { COUNTED_SQL } = require("./expenseScope");
const db = require("../db");

// What an advance still owes, in the one direction or the other.
//
// This arithmetic was copied into six places and then only one of them was
// corrected when reimbursements were added, so the same advance reported two
// different debts depending on which page you were standing on. Laiza's
// CA-2026-0001 was square on the Cash Advances page and 40 pesos "due to
// employee" on her own Expenses page, on all four of the reports drawing on
// it, indefinitely. It lives here now, and the callers that used to do their
// own sums import it.
//
//   released, plus anything paid back out to cover an overspend,
//   less cash handed back, less everything counted against it.
//
// Positive: the employee still holds company cash. Negative: they spent past
// the advance and are owed the excess. Zero: square.
//
// The reimbursement term is the one that was missing. When the company settles
// an overspend it pays the employee the difference, and that payment cancels
// the debt — leaving it out means the debt is still on the books after it has
// been paid, which is the shape of the bug this fixes.
function outstandingOf({ amount, returned, reimbursed, liquidated }) {
  const n = (v) => Number(v) || 0;
  return Number((n(amount) + n(reimbursed) - n(returned) - n(liquidated)).toFixed(2));
}

// The reckoning on an advance-funded report is not a property of the report.
//
// Several reports can draw on one advance — three of Laiza's claims all draw
// on CA-2026-0001 — so "the advance, less this report's spend" counts the same
// release once per report and invents money that was never handed out: three
// claims of 596, 1,262 and 40 against a 2,000 advance came out as 1,404 + 738
// + 1,960 owed, over four thousand pesos of debt from two thousand of cash.
//
// Worse was the other direction. `cash_advance_amount` is the report's own
// funding field, left over from when each report carried its own advance. Now
// that advances are separate it is zero on every funded report, so the balance
// read as `0 - spent` and every liquidation claimed the company owed the
// employee money it had already handed them.
//
// So the position lives on the advance: what was released, less anything
// handed back, less everything counted against it. It is the same figure the
// Cash Advances page shows — now literally, through outstandingOf — and it is
// deliberately identical across every report drawing on that advance, because
// there is only one advance.
const ADVANCE_POSITION_SQL = (placeholders) => `
  SELECT a.id, a.reference, a.amount, a.returned_amount, a.reimbursed_amount,
         COALESCE(SUM(i.amount), 0) AS liquidated
  FROM cash_advances a
  LEFT JOIN expense_reports r ON r.cash_advance_id = a.id AND r.status IN ${COUNTED_SQL}
  LEFT JOIN expense_items i ON i.report_id = r.id
  WHERE a.id IN (${placeholders})
  GROUP BY a.id, a.reference, a.amount, a.returned_amount, a.reimbursed_amount`;

async function advancePositions(ids) {
  const unique = [...new Set(ids.filter((v) => v != null))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .prepare(ADVANCE_POSITION_SQL(unique.map(() => "?").join(",")))
    .all(...unique);
  return new Map(
    rows.map((r) => {
      const amount = Number(r.amount) || 0;
      const returned = Number(r.returned_amount) || 0;
      const reimbursed = Number(r.reimbursed_amount) || 0;
      const liquidated = Number(r.liquidated) || 0;
      return [
        r.id,
        {
          advance_reference: r.reference,
          advance_amount: amount,
          advance_returned: returned,
          advance_reimbursed: reimbursed,
          advance_liquidated: liquidated,
          // Negative means the employee spent past the advance and has not yet
          // been paid the excess back.
          advance_outstanding: outstandingOf({ amount, returned, reimbursed, liquidated }),
        },
      ];
    })
  );
}

module.exports = { advancePositions, outstandingOf };
