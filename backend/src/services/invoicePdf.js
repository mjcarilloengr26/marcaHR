const PDFDocument = require("pdfkit");
const db = require("../db");

// The invoice as a document the customer receives. Everything on the
// letterhead — logo, company name, address, TIN, payment instructions — comes
// from branding settings rather than being written into this file, so an admin
// can change what goes out without a deploy.

const PAGE_MARGIN = 48;

// What the outgoing document is called. Deliberately NOT "Invoice": in the
// Philippines a Sales Invoice is a BIR-registered document, and a system that
// has not been accredited to issue one may not print that word at the top of
// a page it sends a customer. A Statement of Account is a billing document,
// not a tax document, and is what this is.
const DOC_TITLE = "STATEMENT OF ACCOUNT";

// Printed at the foot of every statement. The second sentence is the point of
// the first: it says plainly what this document is not, so nobody files it as
// a Sales Invoice or an Official Receipt.
const SYSTEM_REMARK =
  "This Statement of Account is computer-generated and does not require a signature. " +
  "It is not a BIR-registered Sales Invoice or Official Receipt.";
// Column left edges. The money columns carry a currency code as well as the
// figure — "PHP 690,000.00" is about 64pt at 9pt Helvetica — and AMOUNT used
// to be given 51pt, so every total on the document wrapped onto a second line
// inside its own cell. Description gives up the width instead: it wraps
// gracefully and a figure does not.
const RIGHT_EDGE = 547; // A4 width (595) less the right margin
const COL = { desc: 48, qty: 276, unit: 312, price: 356, amount: 446 };
const COL_W = { qty: 30, unit: 40, price: 86 };
// The width of the money column, used by the line items and by the totals
// beneath them so the figures share one right-hand edge all the way down.
const AMOUNT_W = RIGHT_EDGE - COL.amount - 6;

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

// Small vector icons for the contact line.
//
// Drawn rather than typed. pdfkit's built-in fonts are WinAnsi, which has no
// envelope, no globe and no emoji of any kind — a character like U+2709 does
// not survive the encoding, and embedding a symbol font to get four glyphs
// would put a font file in the repository and a licence question with it.
// Four paths cost less and cannot go missing.
function drawIcon(doc, kind, x, y, s, colour) {
  doc.save().strokeColor(colour).lineWidth(0.6);
  if (kind === "mail") {
    const h = s * 0.74;
    const top = y + (s - h) / 2;
    doc.rect(x, top, s, h).stroke();
    // The flap, as the diagonal it actually is.
    doc.moveTo(x, top).lineTo(x + s / 2, top + h * 0.6).lineTo(x + s, top).stroke();
  } else if (kind === "globe") {
    const r = s / 2;
    doc.circle(x + r, y + r, r).stroke();
    doc.ellipse(x + r, y + r, r * 0.42, r).stroke();
    doc.moveTo(x, y + r).lineTo(x + s, y + r).stroke();
  } else if (kind === "id") {
    const h = s * 0.76;
    const top = y + (s - h) / 2;
    doc.rect(x, top, s, h).stroke();
    doc.moveTo(x + s * 0.2, top + h * 0.38).lineTo(x + s * 0.8, top + h * 0.38).stroke();
    doc.moveTo(x + s * 0.2, top + h * 0.66).lineTo(x + s * 0.6, top + h * 0.66).stroke();
  } else if (kind === "phone") {
    // A handset is unreadable at 7pt, so this is a mobile: rounded body, a
    // line for the earpiece. As a plain rectangle it read as an empty box.
    const w = s * 0.62;
    const left = x + (s - w) / 2;
    doc.roundedRect(left, y, w, s, w * 0.22).stroke();
    doc.moveTo(left + w * 0.3, y + s * 0.18).lineTo(left + w * 0.7, y + s * 0.18).stroke();
  }
  doc.restore();
}

// Contact details as one run across the page, each behind its own icon.
//
// They used to be one short line each — email, then website, then TIN, stacked
// down the left — which left the block four lines deep and narrower than the
// address above it. On one line it reads as a single strip of contact details
// and squares off against the address.
function drawContactLine(doc, x, y, width, parts) {
  const SIZE = 8.5;
  const ICON = 7.2;
  const GAP = 3.5; // icon to its own text
  const SEP = 11; // between one pair and the next
  doc.fontSize(SIZE).font("Helvetica").fillColor("#555555");

  let cx = x;
  let cy = y;
  for (const part of parts) {
    const w = doc.widthOfString(part.text);
    // Wrap the whole pair rather than splitting an icon from its value.
    if (cx > x && cx + ICON + GAP + w > x + width) {
      cx = x;
      cy += SIZE + 5;
    }
    drawIcon(doc, part.icon, cx, cy + 0.6, ICON, "#999999");
    doc.fillColor("#555555").text(part.text, cx + ICON + GAP, cy, { lineBreak: false });
    cx += ICON + GAP + w + SEP;
  }
  return cy + SIZE + 3;
}

// The letterhead: the mark, then the name under it, then the address, then one
// line of contact details. The document title sits top right, quieter than the
// company it comes from.
const TITLE_SIZE = 11.5;
const LOGO_BOX = [170, 58];

function drawLetterhead(doc, branding) {
  const identity = invoiceIdentity(branding);
  const logo = logoBuffer(identity.logo);
  const blockWidth = RIGHT_EDGE - PAGE_MARGIN;

  // The mark sits at the top on its own, with the name under it.
  let y = PAGE_MARGIN;
  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, y, { fit: LOGO_BOX });
      y += LOGO_BOX[1] + 6;
    } catch {
      // A corrupt image should cost the letterhead its picture, not the
      // customer their statement.
    }
  }

  // The title shares the company name's baseline rather than sitting up in the
  // corner on its own. They are the two things that say what this is and who
  // it is from, and on one line the eye takes both in at once instead of
  // finding the second halfway down the page.
  //
  // It is measured and placed FIRST, and the name is given only the room left
  // over. Laying the name out first against a fixed width is what used to
  // print it straight over the top of the title.
  doc.fontSize(TITLE_SIZE).font("Helvetica-Bold").fillColor("#111111");
  const titleW = doc.widthOfString(DOC_TITLE) + 2;
  const titleLeft = RIGHT_EDGE - titleW;
  doc.text(DOC_TITLE, titleLeft, y, { width: titleW, align: "right" });
  const titleBottom = doc.y;

  doc.fontSize(13).font("Helvetica-Bold").fillColor("#111111");
  doc.text(identity.name, PAGE_MARGIN, y, { width: titleLeft - PAGE_MARGIN - 20 });
  y = Math.max(doc.y, titleBottom) + 3;

  // Below the title's line, so these may run the full width of the page.
  if (branding?.company_address) {
    doc.fontSize(8.5).font("Helvetica").fillColor("#555555");
    doc.text(branding.company_address, PAGE_MARGIN, y, { width: blockWidth });
    y = doc.y + 3;
  }

  // The scheme is noise on a printed page — nobody types it — and dropping it
  // is what lets the details share one line.
  const site = (branding?.company_website || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const parts = [
    branding?.company_phone ? { icon: "phone", text: branding.company_phone } : null,
    branding?.company_email ? { icon: "mail", text: branding.company_email } : null,
    site ? { icon: "globe", text: site } : null,
    branding?.company_tin ? { icon: "id", text: `TIN ${branding.company_tin}` } : null,
  ].filter(Boolean);
  if (parts.length) y = drawContactLine(doc, PAGE_MARGIN, y, blockWidth, parts);

  return y + 14;
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
    ["Statement no.", invoice.invoice_number],
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
  doc.text("QTY", COL.qty, y + 6.5, { width: COL_W.qty, align: "right" });
  doc.text("UNIT", COL.unit, y + 6.5, { width: COL_W.unit });
  doc.text("UNIT PRICE", COL.price, y + 6.5, { width: COL_W.price, align: "right" });
  doc.text("AMOUNT", COL.amount, y + 6.5, { width: AMOUNT_W, align: "right" });
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
    doc.text(Number(item.quantity).toLocaleString("en-PH"), COL.qty, y + 5, { width: COL_W.qty, align: "right" });
    doc.text(item.unit || "", COL.unit, y + 5, { width: COL_W.unit });
    doc.text(amountIn(item.unit_price, currency), COL.price, y + 5, { width: COL_W.price, align: "right" });
    doc.text(amountIn(item.amount, currency), COL.amount, y + 5, { width: AMOUNT_W, align: "right" });

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
  // The figures sit in the same column as the line items' AMOUNT, so the money
  // on the page reads down one edge instead of stepping in and out. The label
  // column is wide enough for "TOTAL AMOUNT DUE" on one line — at 95pt it
  // wrapped, which put the words and the figure they belong to on different
  // rows.
  const LABEL_W = 130;
  const labelX = COL.amount - 8 - LABEL_W;
  const valueX = COL.amount;

  const row = (label, value, bold) => {
    doc.fontSize(bold ? 11 : 9.5).font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.fillColor(bold ? "#111111" : "#555555").text(label, labelX, y, { width: LABEL_W, align: "right" });
    doc.fillColor("#111111").text(value, valueX, y, { width: AMOUNT_W, align: "right" });
    y += bold ? 20 : 15;
  };

  row("VATable sales", amountIn(vatable, invoice.currency));
  row(rate > 0 ? `VAT (${rate}%)` : "VAT (zero-rated)", amountIn(vat, invoice.currency));

  doc.moveTo(labelX, y + 2).lineTo(RIGHT_EDGE, y + 2).strokeColor("#cccccc").lineWidth(1).stroke();
  y += 8;
  row("TOTAL AMOUNT DUE", amountIn(gross, invoice.currency), true);

  return y;
}

// Notes and payment details, stacked down the left.
//
// The payment block used to sit in a right-hand column, directly under the
// totals. That column is the one the line items push down: a statement with
// enough items to grow the table moved the totals down onto it, and the two
// blocks were laid out independently with no knowledge of each other. Down the
// left, the payment details follow the notes in a single flow and cannot be
// reached by anything above them.
function drawFooter(doc, invoice, branding, startY) {
  const LEFT_W = 300;
  let y = startY + 16;

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

  // Measure the whole block before drawing any of it, and move it to a fresh
  // page rather than let it break across one. pdfkit paginates on overflow,
  // which on a long bill of materials left the PAYMENT heading at the foot of
  // one page and the account number it belongs to at the top of the next —
  // bank details split in half being the one thing on this document that must
  // never happen.
  let needed = 0;
  if (invoice.notes) {
    doc.fontSize(9).font("Helvetica");
    needed += 12 + doc.heightOfString(invoice.notes, { width: LEFT_W }) + 14;
  }
  if (account.body || account.swift) {
    needed += 24; // the PAYMENT heading and the account's own label
    if (account.body) {
      doc.fontSize(9).font("Helvetica");
      needed += doc.heightOfString(account.body, { width: LEFT_W });
    }
    if (account.swift) needed += 12;
  }
  // Room kept below for the centred footer note and the system remark, both of
  // which sit under whatever this block ends up being.
  const floorY = doc.page.height - PAGE_MARGIN - 56;
  if (needed > 0 && y + needed > floorY) {
    doc.addPage();
    y = PAGE_MARGIN;
  }

  if (invoice.notes) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("NOTES", PAGE_MARGIN, y);
    doc.fontSize(9).font("Helvetica").fillColor("#444444");
    doc.text(invoice.notes, PAGE_MARGIN, doc.y + 2, { width: LEFT_W });
    y = doc.y + 14;
  }

  if (account.body || account.swift) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#888888").text("PAYMENT", PAGE_MARGIN, y, { width: LEFT_W });
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#555555").text(account.label, PAGE_MARGIN, doc.y + 4, { width: LEFT_W });
    doc.fontSize(9).font("Helvetica").fillColor("#444444");
    if (account.body) doc.text(account.body, PAGE_MARGIN, doc.y + 1, { width: LEFT_W });
    if (account.swift) doc.font("Helvetica-Bold").text(`SWIFT/BIC: ${account.swift}`, PAGE_MARGIN, doc.y + 1, { width: LEFT_W });
    y = doc.y;
  }

  if (branding?.invoice_footer) {
    doc.fontSize(8).font("Helvetica").fillColor("#999999");
    doc.text(branding.invoice_footer, PAGE_MARGIN, y + 24, {
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
