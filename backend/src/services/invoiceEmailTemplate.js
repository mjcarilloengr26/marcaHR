// The covering email an invoice travels in. Held as a template an admin can
// edit rather than a string in the code, because the right register for a
// customer is a commercial decision — and a firm chasing a construction
// progress billing does not write like one billing a monthly retainer.

// Kept deliberately plain. It is a business letter: it says what is attached,
// what is owed, when it is due, and how to raise a query. No marketing, no
// exclamation marks, and no instruction the recipient has to act on twice.
const DEFAULT_SUBJECT = "Invoice {invoice_number} from {company}";

const DEFAULT_BODY = [
  "Dear {contact},",
  "",
  "Please find attached invoice {invoice_number} in the amount of {amount} for your account.",
  "",
  "{due_sentence} Our payment details are set out on the invoice. Kindly quote the invoice number when remitting so that we can apply your payment promptly.",
  "",
  // Invoices and payments cross in the post constantly, and a customer who has
  // already paid should not be left wondering whether they are being chased.
  "If any part of this invoice requires clarification, please reply to this email and we will attend to it. Should the invoice already have been settled, please disregard this notice and accept our thanks.",
  "",
  "Thank you for your continued business.",
  "",
  "Sincerely,",
  "{company}",
].join("\n");

// Every field a template may refer to, documented in one place so the settings
// page and the renderer cannot drift apart.
const PLACEHOLDERS = [
  ["{company}", "Your invoicing company name"],
  ["{customer}", "The customer's name"],
  ["{contact}", "The contact person, or the customer's name if none is set"],
  ["{invoice_number}", "e.g. INV-ORD-OPP-66-4"],
  ["{amount}", "The total due, with its currency"],
  ["{due_date}", "The due date, or blank if none is set"],
  ["{due_sentence}", "A full sentence: the due date if there is one, otherwise \"Payment is due upon receipt.\""],
  ["{issue_date}", "The date the invoice was issued"],
];

const money = (n, currency) =>
  `${currency || "PHP"} ` +
  (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Dates are stored as plain YYYY-MM-DD. Parsed at midday UTC so that rendering
// them never lands on the previous day in a western timezone.
function longDate(iso) {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function valuesFor({ invoice, customer, companyName }) {
  const due = longDate(invoice.due_date);
  return {
    "{company}": companyName || "",
    "{customer}": customer?.name || invoice.customer_name || "",
    "{contact}": customer?.contact_person || customer?.name || invoice.customer_name || "",
    "{invoice_number}": invoice.invoice_number || "",
    "{amount}": money(invoice.amount, invoice.currency),
    "{due_date}": due,
    "{due_sentence}": due ? `Payment is due on or before ${due}.` : "Payment is due upon receipt.",
    "{issue_date}": longDate(invoice.issue_date),
  };
}

function fill(template, values) {
  return String(template).replace(/\{[a-z_]+\}/g, (token) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : token
  );
}

// An admin who clears the field gets the default back rather than an empty
// email — a blank covering note reads as a system fault to the customer.
function renderInvoiceEmail({ invoice, customer, branding, companyName }) {
  const values = valuesFor({ invoice, customer, companyName });
  const subject = (branding?.invoice_email_subject || "").trim() || DEFAULT_SUBJECT;
  const body = (branding?.invoice_email_body || "").trim() || DEFAULT_BODY;
  return { subject: fill(subject, values), text: fill(body, values) };
}

module.exports = { renderInvoiceEmail, DEFAULT_SUBJECT, DEFAULT_BODY, PLACEHOLDERS };
