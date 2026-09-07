const { COUNTED_SQL } = require("./expenseScope");
const db = require("../db");

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
// Cash Advances page shows, and it is deliberately identical across every
// report drawing on that advance, because there is only one advance.
const ADVANCE_POSITION_SQL = (placeholders) => `
  SELECT a.id, a.reference, a.amount, a.returned_amount,
         COALESCE(SUM(i.amount), 0) AS liquidated
  FROM cash_advances a
  LEFT JOIN expense_reports r ON r.cash_advance_id = a.id AND r.status IN ${COUNTED_SQL}
  LEFT JOIN expense_items i ON i.report_id = r.id
  WHERE a.id IN (${placeholders})
  GROUP BY a.id, a.reference, a.amount, a.returned_amount`;

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
      const liquidated = Number(r.liquidated) || 0;
      return [
        r.id,
        {
          advance_reference: r.reference,
          advance_amount: amount,
          advance_returned: returned,
          advance_liquidated: liquidated,
          // Negative means the employee spent past the advance and is owed the
          // excess back — a reimbursement against the same release.
          advance_outstanding: Number((amount - returned - liquidated).toFixed(2)),
        },
      ];
    })
  );
}

module.exports = { advancePositions };
