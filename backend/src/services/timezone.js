const db = require("../db");

// What the app was hardcoded to before this became a setting, so an install
// that has never touched it behaves exactly as it always did.
const FALLBACK = "Asia/Manila";

// Read on every attendance punch and every period calculation, changed about
// once per installation — so a short cache, same reasoning as branding.
let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function appTimezone() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const row = await db.prepare("SELECT timezone FROM app_settings WHERE id = 1").get();
    const tz = row?.timezone?.trim();
    // A bad value would throw deep inside a date format call, far from the
    // cause. Validate here and fall back loudly instead.
    cached = isValidTimezone(tz) ? tz : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  cachedAt = Date.now();
  return cached;
}

function isValidTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function clearTimezoneCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { appTimezone, clearTimezoneCache, isValidTimezone, FALLBACK };
