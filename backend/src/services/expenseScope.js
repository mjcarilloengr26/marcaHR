// Which expense reports count as spend.
//
// Written once and imported, because this filter had been hand-copied into six
// queries — the dashboard, the per-employee summary, the business review, the
// export, the cost-centre budgets and the cash-advance balance — and they had
// already drifted apart once. The cash-advance balance excluded rejected
// reports while the dashboard did not, which is how the disagreement between
// them was first noticed.
//
// draft is excluded as well as rejected. A draft is somebody part-way through
// typing: it has not been claimed, nobody has seen it, and it can still be
// abandoned. Counting it means a half-entered receipt moves the company's
// spend figures and eats a cost-centre allocation before anyone has asked for
// the money. It was also why a rejected report appeared to come back from the
// dead — reopening one to correct it returns it to draft, and under the old
// rule that immediately made it count again.
//
// submitted counts even though it is not yet approved: the claim has been
// made, and a manager looking at what is committed needs to see it.
const COUNTED_STATUSES = ["submitted", "approved", "reimbursed"];

// For interpolation into a query. The values are a fixed literal list, never
// user input, so there is nothing here to parameterise.
const COUNTED_SQL = `('${COUNTED_STATUSES.join("','")}')`;

module.exports = { COUNTED_STATUSES, COUNTED_SQL };
