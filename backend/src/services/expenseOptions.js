// The vocabularies for expense reports, held server-side so they are actually
// enforceable. They used to live only in the React page, which meant the list
// was a suggestion: anything could still be written by an edited request, and
// nothing stopped the same category arriving under a new spelling.
//
// There is no free text at all. "Others" used to let somebody type a name and
// have it stored as the category, which is how a single ₱290 line called "Key
// Duplicate" became a permanent slice on the spend-by-category chart beside
// Meals and Fuel. One person's one-off phrase is not a category: the chart is
// only readable if the vocabulary is fixed, and a vocabulary anybody can
// extend is not fixed.
//
// Picking "Others" now stores exactly that, and what the money actually bought
// goes in the line's own description, which is the field for it and which no
// chart groups by.

const EXPENSE_TYPES = ["Operating Expenses", "Project Expenses"];

const OTHER = "Others";

// One list for both the report's title and the line item's category.
//
// They were two lists, and the overlap fought: "Maintenance" and "Car
// Maintenance" as titles against "Vehicle Maintenance" as a category, "Hotel"
// against "Hotel / Accommodation", "Foods" against "Meals", "Parts" against
// "Spare Parts". The same spend then landed under different words depending on
// which field it went in, and the purpose and category charts could not be
// read against each other even when they described the same money.
//
// Overlaps were resolved to the more specific wording — Vehicle Maintenance
// covers a mechanic's bill and a service, Spare Parts covers Parts, Meals
// covers Foods, Hotel / Accommodation covers Hotel — and the result is sorted
// alphabetically, because at two dozen entries finding a word beats any
// grouping someone has to learn.
const TERMS = [
  "Airfare",
  "Allowance per diem",
  "Bank & Transfer Fees",
  "Communication / Load",
  "Equipment Rental",
  "Fuel",
  "Government Fees",
  "Hotel / Accommodation",
  "Labor",
  "Laundry",
  "Marketing",
  "Materials",
  "Meals",
  "Office Rental",
  "Parking",
  "SOP",
  "Spare Parts",
  "Supplies",
  "Toll Fees",
  "Transport",
  "Utilities",
  "Vehicle Maintenance",
  "Vehicle Rental",
  // Always last: it is the escape hatch, and a reader scanning the list should
  // reach it after the real choices.
  OTHER,
];

// Both fields draw on the same list. Kept as two exported names because the
// two are different questions — what the advance was for, and what the money
// bought — and a future divergence should be a deliberate edit here rather
// than a surprise.
const TITLES = TERMS;
const CATEGORIES = TERMS;

// Resolves a { choice, other } pair to the value to store, or an error.
//
// The client sends what was picked rather than a pre-resolved string. That is
// the whole point: if it resolved "Others" itself, the server would receive
// free text and have no way to tell a legitimate "Others" from anything else
// somebody chose to send.
function resolveChoice({ choice, other, allowed, label, required = true }) {
  const picked = typeof choice === "string" ? choice.trim() : "";

  if (!picked) {
    if (required) return { error: `${label} is required` };
    return { value: null };
  }
  if (!allowed.includes(picked)) {
    return { error: `${label} must be one of the listed options` };
  }
  // "Others" stores "Others". The `other` field is accepted and ignored so an
  // older page still in somebody's browser cannot slip a new category past
  // this — the enforcement has to be here, because the client is whatever the
  // caller chooses to send.
  return { value: picked };
}

module.exports = { EXPENSE_TYPES, TERMS, TITLES, CATEGORIES, OTHER, resolveChoice };
