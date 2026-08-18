const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { clearTimezoneCache } = require("../services/timezone");

const router = express.Router();

// Currencies offered in the admin dropdown. The symbol here is only for
// labelling the option — actual formatting is done by Intl from the code, so
// placement and grouping follow the currency's own conventions.
const CURRENCIES = [
  { code: "PHP", label: "Philippine Peso", symbol: "₱" },
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "JPY", label: "Japanese Yen", symbol: "¥" },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥" },
  { code: "AUD", label: "Australian Dollar", symbol: "A$" },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$" },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$" },
  { code: "HKD", label: "Hong Kong Dollar", symbol: "HK$" },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ" },
  { code: "SAR", label: "Saudi Riyal", symbol: "﷼" },
  { code: "INR", label: "Indian Rupee", symbol: "₹" },
  { code: "IDR", label: "Indonesian Rupiah", symbol: "Rp" },
  { code: "MYR", label: "Malaysian Ringgit", symbol: "RM" },
  { code: "THB", label: "Thai Baht", symbol: "฿" },
  { code: "VND", label: "Vietnamese Dong", symbol: "₫" },
  { code: "KRW", label: "South Korean Won", symbol: "₩" },
  { code: "NZD", label: "New Zealand Dollar", symbol: "NZ$" },
  { code: "CHF", label: "Swiss Franc", symbol: "CHF" },
];

// Languages with a translation dictionary on the client. English is the
// fallback: any string without a translation renders in English rather than
// showing a raw key.
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fil", label: "Filipino" },
  { code: "es", label: "Español" },
  { code: "ja", label: "日本語" },
];

// Offered in the admin dropdown. Any IANA zone would work technically, but a
// short curated list is a usable control where the full database is not.
const TIMEZONES = [
  { code: "Asia/Manila", label: "Philippines (GMT+8)" },
  { code: "Asia/Singapore", label: "Singapore (GMT+8)" },
  { code: "Asia/Hong_Kong", label: "Hong Kong (GMT+8)" },
  { code: "Asia/Kuala_Lumpur", label: "Malaysia (GMT+8)" },
  { code: "Asia/Jakarta", label: "Indonesia - Jakarta (GMT+7)" },
  { code: "Asia/Bangkok", label: "Thailand (GMT+7)" },
  { code: "Asia/Ho_Chi_Minh", label: "Vietnam (GMT+7)" },
  { code: "Asia/Tokyo", label: "Japan (GMT+9)" },
  { code: "Asia/Seoul", label: "South Korea (GMT+9)" },
  { code: "Asia/Shanghai", label: "China (GMT+8)" },
  { code: "Asia/Kolkata", label: "India (GMT+5:30)" },
  { code: "Asia/Dubai", label: "UAE (GMT+4)" },
  { code: "Asia/Riyadh", label: "Saudi Arabia (GMT+3)" },
  { code: "Australia/Sydney", label: "Australia - Sydney" },
  { code: "Pacific/Auckland", label: "New Zealand" },
  { code: "Europe/London", label: "United Kingdom" },
  { code: "Europe/Paris", label: "Central Europe" },
  { code: "America/New_York", label: "US Eastern" },
  { code: "America/Chicago", label: "US Central" },
  { code: "America/Denver", label: "US Mountain" },
  { code: "America/Los_Angeles", label: "US Pacific" },
  { code: "UTC", label: "UTC" },
];

const CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code));
const TIMEZONE_CODES = new Set(TIMEZONES.map((t) => t.code));
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

// Public and unauthenticated: the sign-in screen needs the language before
// anyone has a token, same as the branding logo.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT currency_code, language, timezone, updated_at FROM app_settings WHERE id = 1").get();
    res.json(row);
  })
);

router.get(
  "/options",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json({ currencies: CURRENCIES, languages: LANGUAGES, timezones: TIMEZONES });
  })
);

router.put(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT currency_code, language, timezone FROM app_settings WHERE id = 1").get();
    const { currency_code, language, timezone } = req.body || {};

    if (currency_code !== undefined && !CURRENCY_CODES.has(currency_code)) {
      return res.status(400).json({ error: "Unsupported currency" });
    }
    if (language !== undefined && !LANGUAGE_CODES.has(language)) {
      return res.status(400).json({ error: "Unsupported language" });
    }
    if (timezone !== undefined && !TIMEZONE_CODES.has(timezone)) {
      return res.status(400).json({ error: "Unsupported timezone" });
    }

    await db
      .prepare(
        `UPDATE app_settings SET currency_code = ?, language = ?, timezone = ?,
         updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(
        currency_code !== undefined ? currency_code : existing.currency_code,
        language !== undefined ? language : existing.language,
        timezone !== undefined ? timezone : existing.timezone,
        req.user.id
      );

    await logRequestEvent(req, "update_app_settings", {
      entityType: "app_settings",
      details: { currency_code, language, timezone },
    });
    // Attendance and the period calculations read this through a cached
    // helper; clear it so a change takes effect on the very next request.
    clearTimezoneCache();
    res.json(await db.prepare("SELECT currency_code, language, timezone, updated_at FROM app_settings WHERE id = 1").get());
  })
);

module.exports = { router, CURRENCIES, LANGUAGES, TIMEZONES };
