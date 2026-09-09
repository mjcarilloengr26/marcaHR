const PDFDocument = require("pdfkit");
const db = require("../db");

// The invoice as a document the customer receives. Everything on the
// letterhead — logo, company name, address, TIN, payment instructions — comes
// from branding settings rather than being written into this file, so an admin
// can change what goes out without a deploy.

const PAGE_MARGIN = 48;

// Printed at the foot of every invoice.
const SYSTEM_REMARK = "This is a computer-generated invoice and does not require a signature.";
const COL = { desc: 48, qty: 300, unit: 350, price: 400, amount: 490 };
const RIGHT_EDGE = 547; // A4 width (595) less the right margin

// Every figure on the document carries its currency code. A bare number on an
// invoice that could be either peso or dollar is the kind of ambiguity that
// gets paid wrong.
const amountIn = (n, currency) =>
  `${currency || "PHP"} ` +
  (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The logo arrives as a base64 data URL. pdfkit wants a buffer, and only
// understands PNG and JPEG — an SVG logo would throw, so it is skipped rather
// than taking the whole document down with it.
function logoBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
}

// The invoicing entity, which is deliberately allowed to differ from the name
// and mark the application wears on its sign-in page. Falls back to the app's
// own when no separate identity has been set.
function invoiceIdentity(branding) {
  return {
    name: (branding?.invoice_company_name || "").trim() || branding?.company_name || "",
    logo: branding?.invoice_logo_data || branding?.logo_data || null,
  };
}

function drawLetterhead(doc, branding) {
  const identity = invoiceIdentity(branding);
  const logo = logoBuffer(identity.logo);
  let textLeft = PAGE_MARGIN;

  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, PAGE_MARGIN, { fit: [110, 55] });
      textLeft = PAGE_MARGIN + 125;
    } catch {
      // A corrupt image should cost the letterhead its picture, not the
      // customer their invoice.
      textLeft = PAGE_MARGIN;
    }
  }

  doc.fontSize(15).font("Helvetica-Bold").fillColor("#111111");
  doc.text(identity.name, textLeft, PAGE_MARGIN, { width: 330 });

  doc.fontSize(8.5).font("Helvetica").fillColor("#555555");
  const lines = [
    branding?.company_address,
    [branding?.company_phone, branding?.company_email].filter(Boolean).join("  ·  "),
    branding?.company_website,
    branding?.company_tin ? `TIN: ${branding.company_tin}` : null,
  ].filter(Boolean);
  for (const line of lines) doc.text(line, textLeft, doc.y + 1, { width: 330 });

  doc.fontSize(20).font("Helvetica-Bold").fillColor("#111111");
  doc.text("INVOICE", 380, PAGE_MARGIN, { width: RIGHT_EDGE - 380, align: "right" });

  return Math.max(doc.y, PAGE_MARGIN + 70) + 14;
}

function drawParties(doc, invoice, customer, top) {
  doc.moveTo(PAGE_MARGIN, top).lineTo(RIGHT_EDGE, top).strokeColor("#dddddd").lineWidth(1).stroke();
  const y = top + 14;

  doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("BILL TO", PAGE_MARGIN, y);
  doc.fontSize(10.5).font("Helvetica-Bold").fillColor("#111111");
  doc.text(customer?.name || invoice.customer_name || "", PAGE_MARGIN, doc.y + 2, { width: 280 });

  doc.fontSize(9).font("Helvetica").fillColor("#444444");
  for (const line of [
    customer?.contact_person,
    customer?.billing_address,
    customer?.email,
    customer?.tin ? `TIN: ${customer.tin}` : null,
  ].filter(Boolean)) {
    doc.text(line, PAGE_MARGIN, doc.y + 1, { width: 280 });
  }
  const leftBottom = doc.y;

  // The facts a customer checks first, kept as a label/value pair so the
  // values line up whatever length the labels are.
  const rows = [
    ["Invoice no.", invoice.invoice_number],
    ["Issue date", invoice.issue_date || "—"],
    ["Due date", invoice.due_date || "—"],
    invoice.order_number ? ["Order", invoice.order_number] : null,
    invoice.project_code ? ["Project", invoice.project_code] : null,
  ].filter(Boolean);

  let ry = y;
  for (const [label, value] of rows) {
    doc.fontSize(9).font("Helvetica").fillColor("#888888").text(label, 350, ry, { width: 90 });
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#111111").text(String(value), 440, ry, {
      width: RIGHT_EDGE - 440,
      align: "right",
    });
    ry += 14;
  }

  return Math.max(leftBottom, ry) + 18;
}

function drawItemsHeader(doc, y) {
  doc.rect(PAGE_MARGIN, y, RIGHT_EDGE - PAGE_MARGIN, 20).fill("#f4f5f7");
  doc.fontSize(8).font("Helvetica-Bold").fillColor("#555555");
  doc.text("DESCRIPTION", COL.desc + 6, y + 6.5);
  doc.text("QTY", COL.qty, y + 6.5, { width: 40, align: "right" });
  doc.text("UNIT", COL.unit, y + 6.5, { width: 40 });
  doc.text("UNIT PRICE", COL.price, y + 6.5, { width: 80, align: "right" });
  doc.text("AMOUNT", COL.amount, y + 6.5, { width: RIGHT_EDGE - COL.amount - 6, align: "right" });
  return y + 20;
}

function drawItems(doc, items, startY, currency) {
  let y = startY;
  doc.fontSize(9).font("Helvetica").fillColor("#111111");

  for (const item of items) {
    const descHeight = doc.heightOfString(item.description, { width: COL.qty - COL.desc - 16 });
    const rowHeight = Math.max(descHeight + 10, 22);

    // A long invoice runs onto a second page rather than off the bottom of
    // the first, with the column headings repeated so it stays readable.
    if (y + rowHeight > 700) {
      doc.addPage();
      y = drawItemsHeader(doc, PAGE_MARGIN);
      doc.fontSize(9).font("Helvetica").fillColor("#111111");
    }

    doc.text(item.description, COL.desc + 6, y + 5, { width: COL.qty - COL.desc - 16 });
    doc.text(Number(item.quantity).toLocaleString("en-PH"), COL.qty, y + 5, { width: 40, align: "right" });
    doc.text(item.unit || "", COL.unit, y + 5, { width: 40 });
    doc.text(amountIn(item.unit_price, currency), COL.price, y + 5, { width: 80, align: "right" });
    doc.text(amountIn(item.amount, currency), COL.amount, y + 5, { width: RIGHT_EDGE - COL.amount - 6, align: "right" });

    y += rowHeight;
    doc.moveTo(PAGE_MARGIN, y).lineTo(RIGHT_EDGE, y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
  }
  return y;
}

// The order's notes, printed under the breakdown. This is where a PO number,
// a quotation reference or a delivery note lives — the details a customer's
// accounts department matches the invoice against before paying it. They are
// kept on the order rather than retyped per invoice, so every invoice raised
// against that order carries the same references.
function drawOrderReferences(doc, invoice, startY) {
  const notes = (invoice.order_notes || "").trim();
  if (!notes) return startY;

  let y = startY + 10;
  const width = 300;

  // Keeps the block with the items rather than orphaned at the top of page
  // two on a long invoice.
  const needed = doc.heightOfString(notes, { width }) + 24;
  if (y + needed > 700) {
    doc.addPage();
    y = PAGE_MARGIN;
  }

  doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("REFERENCES", PAGE_MARGIN, y);
  doc.fontSize(9).font("Helvetica").fillColor("#444444");
  doc.text(notes, PAGE_MARGIN, doc.y + 3, { width });

  return Math.max(doc.y, y);
}

function drawTotals(doc, invoice, startY) {
  const gross = money2(invoice.amount);
  const rate = Number(invoice.vat_rate) || 0;
  // VAT-inclusive: backed out of the total, taken as the remainder so the two
  // halves always add back to exactly what is due.
  const vatable = rate > 0 ? money2(gross / (1 + rate / 100)) : gross;
  const vat = money2(gross - vatable);

  let y = startY + 12;
  const labelX = 330;
  const valueX = 430;

  const row = (label, value, bold) => {
    doc.fontSize(bold ? 11 : 9.5).font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.fillColor(bold ? "#111111" : "#555555").text(label, labelX, y, { width: 95, align: "right" });
    doc.fillColor("#111111").text(value, valueX, y, { width: RIGHT_EDGE - valueX, align: "right" });
    y += bold ? 20 : 15;
  };

  row("VATable sales", amountIn(vatable, invoice.currency));
  row(rate > 0 ? `VAT (${rate}%)` : "VAT (zero-rated)", amountIn(vat, invoice.currency));

  doc.moveTo(labelX, y + 2).lineTo(RIGHT_EDGE, y + 2).strokeColor("#cccccc").lineWidth(1).stroke();
  y += 8;
  row("TOTAL AMOUNT DUE", amountIn(gross, invoice.currency), true);

  return y;
}

function drawFooter(doc, invoice, branding, startY) {
  const LEFT_W = 250;
  const RIGHT_X = 310;
  const RIGHT_W = RIGHT_EDGE - RIGHT_X;
  let leftBottom = startY + 16;
  let rightBottom = startY + 16;

  if (invoice.notes) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("NOTES", PAGE_MARGIN, leftBottom);
    doc.fontSize(9).font("Helvetica").fillColor("#444444");
    doc.text(invoice.notes, PAGE_MARGIN, doc.y + 2, { width: LEFT_W });
    leftBottom = doc.y;
  }

  // Two accounts, labelled and kept apart. An overseas client paying into the
  // peso account, or a local one quoting a SWIFT code, both cost real money to
  // unpick — so the document never leaves which is which to inference.
  const pesoAcct = (branding?.payment_instructions || "").trim();
  const usdAcct = (branding?.payment_instructions_usd || "").trim();
  const swift = (branding?.swift_code || "").trim();
  const isUsd = (invoice.currency || "PHP") === "USD";

  // Only the account matching the invoice's currency is printed. Showing both
  // invites a customer to pay into the wrong one, and recovering a misdirected
  // international transfer is slow and expensive. If the matching account is
  // not set up, the other is shown rather than nothing at all.
  const primary = isUsd
    ? { label: "US dollar account", body: usdAcct, swift: swift }
    : { label: "Peso account", body: pesoAcct, swift: "" };
  const fallback = isUsd
    ? { label: "Peso account", body: pesoAcct, swift: "" }
    : { label: "US dollar account", body: usdAcct, swift: swift };
  const account = primary.body || primary.swift ? primary : fallback;

  if (account.body || account.swift) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("PAYMENT", RIGHT_X, rightBottom, { width: RIGHT_W });
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#555555").text(account.label, RIGHT_X, doc.y + 4, { width: RIGHT_W });
    doc.fontSize(9).font("Helvetica").fillColor("#444444");
    if (account.body) doc.text(account.body, RIGHT_X, doc.y + 1, { width: RIGHT_W });
    if (account.swift) doc.font("Helvetica-Bold").text(`SWIFT/BIC: ${account.swift}`, RIGHT_X, doc.y + 1, { width: RIGHT_W });
    rightBottom = doc.y;
  }

  if (branding?.invoice_footer) {
    doc.fontSize(8).font("Helvetica").fillColor("#999999");
    doc.text(branding.invoice_footer, PAGE_MARGIN, Math.max(leftBottom, rightBottom) + 24, {
      width: RIGHT_EDGE - PAGE_MARGIN,
      align: "center",
    });
  }

  // Anchored to the foot of the page rather than flowing after the content, so
  // it reads as a statement about the document itself rather than another
  // note. Printed on every invoice: a customer who expects a wet signature
  // needs to be told on the page why there isn't one.
  doc.fontSize(7.5).font("Helvetica-Oblique").fillColor("#999999");
  doc.text(SYSTEM_REMARK, PAGE_MARGIN, doc.page.height - PAGE_MARGIN - 12, {
    width: RIGHT_EDGE - PAGE_MARGIN,
    align: "center",
  });
}

// Everything the document needs, gathered in one place so the drawing code
// never issues a query mid-render.
async function invoiceForPdf(invoiceId) {
  const invoice = await db
    .prepare(
      `SELECT i.*, o.order_number, o.notes AS order_notes, pr.code AS project_code, pr.name AS project_name
       FROM invoices i
       LEFT JOIN orders o ON o.id = i.order_id
       LEFT JOIN projects pr ON pr.id = i.project_id
       WHERE i.id = ?`
    )
    .get(invoiceId);
  if (!invoice) return null;

  const items = await db
    .prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id")
    .all(invoiceId);

  const customer = invoice.customer_id
    ? await db.prepare("SELECT * FROM customers WHERE id = ?").get(invoice.customer_id)
    : null;

  const branding = await db.prepare("SELECT * FROM branding_settings WHERE id = 1").get();

  return { invoice, items, customer, branding };
}

// Streams a finished PDF into the response. Nothing is written to disk.
function renderInvoicePdf({ invoice, items, customer, branding }, stream) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  doc.pipe(stream);

  // A draft that reaches somebody's inbox by accident should say so on its
  // face, not just in the app.
  if (invoice.status === "draft") {
    doc.save();
    doc.rotate(-45, { origin: [300, 400] });
    doc.fontSize(72).font("Helvetica-Bold").fillColor("#f0f0f0").text("DRAFT", 120, 360, { width: 400, align: "center" });
    doc.restore();
    doc.fillColor("#111111");
  }

  let y = drawLetterhead(doc, branding);
  y = drawParties(doc, invoice, customer, y);

  // An invoice with no breakdown is still a valid invoice — it is billed as a
  // single amount, and saying so beats printing an empty table.
  const rows = items.length
    ? items
    : [{ description: invoice.notes || "Amount billed", quantity: 1, unit: "", unit_price: invoice.amount, amount: invoice.amount }];

  y = drawItemsHeader(doc, y);
  const itemsBottom = drawItems(doc, rows, y, invoice.currency);
  // References run down the left, totals down the right, from the same line —
  // so a long list of PO numbers never pushes the amount due off the page.
  const refsBottom = drawOrderReferences(doc, invoice, itemsBottom);
  const totalsBottom = drawTotals(doc, invoice, itemsBottom);
  drawFooter(doc, invoice, branding, Math.max(refsBottom, totalsBottom));

  doc.end();
}

module.exports = { invoiceForPdf, renderInvoicePdf, invoiceIdentity };
