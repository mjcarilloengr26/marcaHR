const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// Rates come from a free, key-less public API. Cached in memory per pair so a
// busy dashboard doesn't hit the provider once per page load — the header
// polls this on every mount, and FX rates don't move meaningfully within an
// hour for a display readout.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // "USD>PHP" -> { rate, fetchedAt }

const RATE_API = (base) => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
const CODE_RE = /^[A-Z]{3}$/;

async function fetchRate(base, quote) {
  const key = `${base}>${quote}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { ...hit, cached: true };
  }

  // Never let a slow or down provider hang an app request — on any failure we
  // fall back to the last known rate if we have one, and otherwise report
  // unavailable so the header can simply hide itself.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(RATE_API(base), { signal: controller.signal });
    if (!res.ok) throw new Error(`rate provider returned ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.[quote];
    if (typeof rate !== "number") throw new Error(`no rate for ${quote}`);
    const entry = { rate, fetchedAt: Date.now() };
    cache.set(key, entry);
    return { ...entry, cached: false };
  } catch (err) {
    if (hit) return { ...hit, cached: true, stale: true };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Quote defaults to whatever currency the app runs in, so the header stays
    // relevant if that's changed; base is USD unless asked otherwise. If the
    // two would match (app currency already USD) fall back to PHP so the
    // readout isn't a pointless 1.00.
    const settings = await db.prepare("SELECT currency_code FROM app_settings WHERE id = 1").get();
    const base = String(req.query.base || "USD").toUpperCase();
    let quote = String(req.query.quote || settings?.currency_code || "PHP").toUpperCase();
    if (quote === base) quote = base === "PHP" ? "USD" : "PHP";

    if (!CODE_RE.test(base) || !CODE_RE.test(quote)) {
      return res.status(400).json({ error: "base and quote must be 3-letter currency codes" });
    }

    const result = await fetchRate(base, quote);
    if (!result) return res.status(503).json({ error: "Exchange rate is unavailable right now" });

    res.json({
      base,
      quote,
      rate: result.rate,
      fetched_at: new Date(result.fetchedAt).toISOString(),
      stale: !!result.stale,
    });
  })
);

module.exports = router;
