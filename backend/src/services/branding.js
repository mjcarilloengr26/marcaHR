const db = require("../db");

const FALLBACK = "MARCA GROUP";

// Cached briefly: the company name is read on nearly every notification and
// every Excel export, but changes about once in the lifetime of an install.
// A short TTL means a rename still shows up quickly without a database round
// trip on every send.
let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function companyName() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const row = await db.prepare("SELECT company_name FROM branding_settings WHERE id = 1").get();
    cached = row?.company_name?.trim() || FALLBACK;
  } catch {
    // Never let branding break an email or a report.
    cached = FALLBACK;
  }
  cachedAt = Date.now();
  return cached;
}

// Called after a save so a rename is visible immediately rather than up to a
// minute later.
function clearCompanyNameCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { companyName, clearCompanyNameCache, FALLBACK };
