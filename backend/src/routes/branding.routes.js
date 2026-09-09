const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { clearCompanyNameCache } = require("../services/branding");
const { DEFAULT_SUBJECT, DEFAULT_BODY, PLACEHOLDERS } = require("../services/invoiceEmailTemplate");

const router = express.Router();

// The letterhead an invoice is printed on. Held apart from logo_data and
// company_name because those two are shown on the sign-in screen to anyone,
// while a TIN and bank details are not for the open internet.
const COMPANY_FIELDS = [
  "invoice_company_name",
  "company_address",
  "company_tin",
  "company_phone",
  "company_email",
  "company_website",
  "payment_instructions",
  "payment_instructions_usd",
  "swift_code",
  "invoice_footer",
  "invoice_email_subject",
  "invoice_email_body",
];

// Public and unauthenticated — the sign-in screen shows the logo before
// anyone has a token yet.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT logo_data, company_name FROM branding_settings WHERE id = 1").get();
    res.json(row);
  })
);

// Everything on the letterhead, for signed-in users only. The public GET above
// deliberately stays limited to the logo and the name.
router.get(
  "/company",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await db
        .prepare(`SELECT logo_data, company_name, invoice_logo_data, ${COMPANY_FIELDS.join(", ")} FROM branding_settings WHERE id = 1`)
        .get()
    );
  })
);

// What the covering email looks like when nobody has customised it, plus the
// fields a template may refer to. Served rather than duplicated in the UI so
// the two can never drift apart.
router.get(
  "/invoice-email-defaults",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json({ subject: DEFAULT_SUBJECT, body: DEFAULT_BODY, placeholders: PLACEHOLDERS });
  })
);

router.put(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    // logo_data is either a base64 data URL or null (reset to the default "M" mark).
    const logoData = req.body?.logo_data ?? null;
    const companyName = req.body?.company_name;
    if (companyName !== undefined && !String(companyName).trim()) {
      return res.status(400).json({ error: "Company name cannot be empty" });
    }
    if (logoData !== null) {
      if (typeof logoData !== "string" || !logoData.startsWith("data:image/")) {
        return res.status(400).json({ error: "logo_data must be an image data URL" });
      }
      if (logoData.length > 2_000_000) {
        return res.status(400).json({ error: "Logo image is too large — please use a smaller image" });
      }
    }
    const invoiceLogo = req.body?.invoice_logo_data;
    if (invoiceLogo !== undefined && invoiceLogo !== null) {
      if (typeof invoiceLogo !== "string" || !invoiceLogo.startsWith("data:image/")) {
        return res.status(400).json({ error: "invoice_logo_data must be an image data URL" });
      }
      if (invoiceLogo.length > 2_000_000) {
        return res.status(400).json({ error: "Invoice logo is too large — please use a smaller image" });
      }
    }
    if (req.body?.swift_code !== undefined && String(req.body.swift_code).trim()) {
      const swift = String(req.body.swift_code).trim().toUpperCase();
      if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) {
        return res.status(400).json({
          error: "SWIFT/BIC must be 8 or 11 characters — four letters for the bank, two for the country, then two or five more",
        });
      }
      req.body.swift_code = swift;
    }
    if (req.body?.company_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(req.body.company_email).trim())) {
      return res.status(400).json({ error: "Company email is not a valid address" });
    }

    const existing = await db
      .prepare(`SELECT company_name, invoice_logo_data, ${COMPANY_FIELDS.join(", ")} FROM branding_settings WHERE id = 1`)
      .get();

    // Only the fields actually sent are changed, so saving the logo from one
    // form does not blank out details entered on another.
    const company = COMPANY_FIELDS.map((f) =>
      req.body?.[f] !== undefined ? String(req.body[f]).trim() || null : existing[f]
    );

    await db
      .prepare(
        `UPDATE branding_settings SET logo_data = ?, company_name = ?, ${COMPANY_FIELDS.map((f) => `${f} = ?`).join(", ")},
         invoice_logo_data = ?,
         updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(
        logoData,
        companyName !== undefined ? String(companyName).trim() : existing.company_name,
        ...company,
        // undefined means "not part of this save"; null means "remove it".
        invoiceLogo === undefined ? existing.invoice_logo_data : invoiceLogo,
        req.user.id
      );
    clearCompanyNameCache();
    await logRequestEvent(req, "update_branding", { entityType: "branding_settings", details: { logo_removed: logoData === null } });
    const row = await db
      .prepare(`SELECT logo_data, company_name, invoice_logo_data, ${COMPANY_FIELDS.join(", ")} FROM branding_settings WHERE id = 1`)
      .get();
    res.json(row);
  })
);

module.exports = router;
