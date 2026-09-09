const { PassThrough } = require("node:stream");
const db = require("../db");
const { sendMail } = require("../mailer");
const { invoiceForPdf, renderInvoicePdf, invoiceIdentity } = require("./invoicePdf");
const { renderInvoiceEmail } = require("./invoiceEmailTemplate");

// Renders the invoice PDF into memory. The mailer needs the bytes, and there
// is nowhere to put a file — Render's disk does not survive a restart, and the
// PDF is reproducible from the invoice whenever it is wanted again.
function renderToBuffer(data) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const parts = [];
    stream.on("data", (c) => parts.push(c));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
    try {
      renderInvoicePdf(data, stream);
    } catch (err) {
      reject(err);
    }
  });
}

const amount = (n, currency) =>
  `${currency || "PHP"} ` +
  (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Everything that has to be true before an invoice can go to a customer,
// answered in one place so the route and the UI agree on what "ready" means.
async function sendReadiness(invoiceId) {
  const invoice = await db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!invoice) return { error: "Invoice not found", status: 404 };

  if (invoice.status === "draft") {
    return { error: "This invoice has not been approved yet. Approve it first, then send.", status: 400 };
  }
  if (invoice.status === "cancelled") {
    return { error: "This invoice was cancelled and cannot be sent.", status: 400 };
  }

  const customer = invoice.customer_id
    ? await db.prepare("SELECT * FROM customers WHERE id = ?").get(invoice.customer_id)
    : null;

  if (!customer) {
    return {
      error: `"${invoice.customer_name}" is not linked to a customer record, so there is no address to send to. Add them on the Customers page.`,
      status: 400,
    };
  }
  if (!customer.email) {
    return {
      error: `${customer.name} has no email address yet. Add one on the Customers page before sending.`,
      status: 400,
    };
  }

  return { invoice, customer };
}

// Builds and sends the email. Returns who it went to so the caller can record
// it — an invoice nobody can prove was sent is an invoice you cannot chase.
async function sendInvoiceEmail(invoiceId, { sentByName } = {}) {
  const ready = await sendReadiness(invoiceId);
  if (ready.error) return ready;

  const data = await invoiceForPdf(invoiceId);
  const pdf = await renderToBuffer(data);
  const { invoice, customer } = ready;
  const company = invoiceIdentity(data.branding).name || "Accounts";

  const filename = `${String(invoice.invoice_number).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const to = [customer.email, ...(customer.cc_emails || [])];

  const { subject, text } = renderInvoiceEmail({
    invoice,
    customer,
    branding: data.branding,
    companyName: company,
  });

  await sendMail({ to, subject, text, attachments: [{ filename, content: pdf }] });

  return { invoice, customer, recipients: to, filename, bytes: pdf.length, sentByName };
}

module.exports = { sendReadiness, sendInvoiceEmail, renderToBuffer };
