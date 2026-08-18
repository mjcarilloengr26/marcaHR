const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { clearCompanyNameCache } = require("../services/branding");

const router = express.Router();

// Public and unauthenticated — the sign-in screen shows the logo before
// anyone has a token yet.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT logo_data, company_name FROM branding_settings WHERE id = 1").get();
    res.json(row);
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
    const existing = await db.prepare("SELECT company_name FROM branding_settings WHERE id = 1").get();
    await db
      .prepare(
        `UPDATE branding_settings SET logo_data = ?, company_name = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(logoData, companyName !== undefined ? String(companyName).trim() : existing.company_name, req.user.id);
    clearCompanyNameCache();
    await logRequestEvent(req, "update_branding", { entityType: "branding_settings", details: { logo_removed: logoData === null } });
    const row = await db.prepare("SELECT logo_data, company_name FROM branding_settings WHERE id = 1").get();
    res.json(row);
  })
);

module.exports = router;
