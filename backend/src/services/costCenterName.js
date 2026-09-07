const db = require("../db");

// Resolving a typed or picked cost centre to the one an admin actually defined.
//
// Written once because three handlers need it — creating an expense report,
// editing one, and releasing or amending a cash advance — and it started as a
// copy in each. Cost centre used to be free text, which is how "Engineering"
// and "engineering" became two cost centres as far as any budget was
// concerned.
//
// Returns { error } or { name }. `name` is the admin's own spelling, so spend
// folds back onto the right allocation however it was picked or typed.
async function resolveCostCenter(value, { required = false } = {}) {
  const wanted = String(value ?? "").trim();
  if (!wanted) {
    if (required) {
      return { error: "Cost center is required — choose one from the list" };
    }
    return { name: null };
  }
  const known = await db
    .prepare("SELECT name FROM cost_centers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND active")
    .get(wanted);
  if (!known) {
    return { error: "Choose a cost center from the list — new ones are added by an admin" };
  }
  return { name: known.name };
}

module.exports = { resolveCostCenter };
