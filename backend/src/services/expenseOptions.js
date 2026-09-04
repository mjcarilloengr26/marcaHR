// The vocabularies for expense reports, held server-side so they are actually
// enforceable. They used to live only in the React page, which meant the list
// was a suggestion: anything could still be written by an edited request, and
// nothing stopped the same category arriving under a new spelling.
//
// Free text survives in exactly one place — picking "Others" and saying what
// it is. Everything else must be one of these.

const EXPENSE_TYPES = ["Operating Expenses", "Project Expenses"];

const OTHER = "Others";

const TITLES = [
  "Fuel", "Parking", "Toll Fees", "Meals", "Maintenance", "Car Maintenance",
  "Utilities", "Allowance per diem", "Supplies", "Materials", "Labor", "Airfare",
  "Hotel", "Foods", "Equipment Rental", "Vehicle Rental", "Office Rental",
  "SOP", "Marketing", "Government Fees",
  OTHER,
];

const CATEGORIES = [
  "Meals", "Transport", "Fuel", "Parking", "Toll Fees", "Airfare",
  "Hotel / Accommodation", "Vehicle Maintenance", "Spare Parts",
  "Supplies", "Materials", "Labor", "Equipment Rental", "Vehicle Rental",
  "Utilities", "Communication / Load", "Laundry", "Bank & Transfer Fees",
  "Government Fees", "SOP", "Marketing",
  OTHER,
];

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
  if (picked !== OTHER) return { value: picked };

  const typed = typeof other === "string" ? other.trim() : "";
  if (!typed) return { error: `Say what the ${label.toLowerCase()} is when choosing ${OTHER}` };
  // Storing the literal word would put the whole point back: a column full of
  // "Others" tells nobody anything.
  if (typed.toLowerCase() === OTHER.toLowerCase()) {
    return { error: `Give the ${label.toLowerCase()} a real name rather than "${OTHER}"` };
  }
  return { value: typed.slice(0, 120) };
}

module.exports = { EXPENSE_TYPES, TITLES, CATEGORIES, OTHER, resolveChoice };
