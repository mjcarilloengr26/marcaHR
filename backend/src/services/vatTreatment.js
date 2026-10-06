// How a sale is treated for VAT.
//
// The rate alone cannot say. Zero-rated and VAT-exempt are both 0%, and they
// are not the same thing: a zero-rated sale is a VATable sale taxed at nought,
// which keeps the seller's input VAT claimable; an exempt sale is outside the
// system altogether. BIR wants them classified separately, and the customer's
// own bookkeeper reads the label off the document to know which it was.
//
// So the treatment is stored, and the rate follows from it rather than the
// other way round. Storing only the rate is what left a zero-rated statement
// headed "VATable sales" — a line a customer's accountant would query.

const TREATMENTS = ["standard", "zero_rated", "exempt"];
const DEFAULT_TREATMENT = "standard";
const DEFAULT_RATE = 12;

// What each one is called on screen and on the document. The subtotal label
// matters most: on a zero-rated or exempt sale, "VATable sales" is wrong.
const LABELS = {
  standard: { name: "Standard (VATable)", sales: "VATable sales", vat: (rate) => `VAT (${rate}%)` },
  zero_rated: { name: "Zero-rated", sales: "Zero-rated sales", vat: () => "VAT (zero-rated)" },
  exempt: { name: "VAT-exempt", sales: "VAT-exempt sales", vat: () => "VAT (exempt)" },
};

const isTreatment = (v) => TREATMENTS.includes(v);

function validateTreatment(input, { required = false } = {}) {
  if (input === undefined || input === null || input === "") {
    return required ? { error: "Choose a VAT treatment" } : { treatment: undefined };
  }
  const value = String(input).trim();
  if (!isTreatment(value)) return { error: "VAT treatment must be standard, zero_rated or exempt" };
  return { treatment: value };
}

// A zero-rated or exempt sale is 0% by definition, so the rate is never left
// to be typed alongside the treatment and contradict it. Only a standard sale
// has a rate worth asking about.
function rateFor(treatment, requestedRate) {
  if (treatment !== "standard") return 0;
  const rate = Number(requestedRate);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) / 100 : DEFAULT_RATE;
}

const labelsFor = (treatment, rate) => {
  const l = LABELS[treatment] || LABELS[DEFAULT_TREATMENT];
  return { name: l.name, sales: l.sales, vat: l.vat(rate) };
};

module.exports = { TREATMENTS, DEFAULT_TREATMENT, DEFAULT_RATE, LABELS, isTreatment, validateTreatment, rateFor, labelsFor };
