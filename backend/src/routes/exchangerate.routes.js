const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { appTimezone } = require("../services/timezone");

const router = express.Router();

// Rates come from a free, key-less public API. Cached in memory per pair so a
// busy dashboard doesn't hit the provider once per page load — the header
// polls this on every mount, and FX rates don't move meaningfully within an
// hour for a display readout.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // "USD>PHP" -> { rate, fetchedAt }

// The whole response, not just the provider's number.
//
// The rate was already cached for an hour, but every request still paid for
// three database round trips behind it — read the app currency, upsert today's
// history row, then read the previous day to compare against. The header
// mounts on every page in the app, so that was most of a second added to every
// single navigation to recompute a comparison that cannot change until either
// the rate refreshes or the day rolls over.
//
// Keyed by pair and day so it expires naturally at midnight, and cleared
// whenever the rate itself is refetched.
const responseCache = new Map(); // "USD>PHP@2026-09-08" -> payload
const RESPONSE_TTL_MS = 5 * 60 * 1000;

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
    // A fresh rate makes any stored comparison for this pair out of date.
    for (const k of responseCache.keys()) if (k.startsWith(`${key}@`)) responseCache.delete(k);
    return { ...entry, cached: false };
  } catch (err) {
    if (hit) return { ...hit, cached: true, stale: true };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

let currencyCache = null;
let currencyCachedAt = 0;
async function appCurrency() {
  if (currencyCache && Date.now() - currencyCachedAt < 60_000) return currencyCache;
  currencyCache = await db.prepare("SELECT currency_code FROM app_settings WHERE id = 1").get();
  currencyCachedAt = Date.now();
  return currencyCache;
}

// Today as the company sees it. A snapshot keyed on the server's UTC date
// would roll over at 8am Manila, so a morning reading would be compared
// against a rate taken a few hours earlier the same working day.
async function localDate() {
  const tz = await appTimezone();
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

// Record today's rate and hand back the most recent earlier day to compare
// against. The write is best-effort: a header readout must not fail because a
// history row could not be stored.
async function recordAndCompare(base, quote, rate, today) {
  try {
    // Last write wins within a day, so the figure shown is the latest reading
    // rather than whatever happened to be first thing in the morning.
    await db
      .prepare(
        `INSERT INTO exchange_rate_history (base, quote, rate_date, rate) VALUES (?, ?, ?, ?)
         ON CONFLICT (base, quote, rate_date) DO UPDATE SET rate = excluded.rate,
           recorded_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
      )
      .run(base, quote, today, rate);
  } catch {
    /* history is a nicety; the rate itself still renders */
  }

  try {
    // The most recent earlier day, not literally yesterday: the provider does
    // not move at weekends, and a Monday should compare against Friday rather
    // than show nothing.
    const prev = await db
      .prepare(
        `SELECT rate, rate_date FROM exchange_rate_history
         WHERE base = ? AND quote = ? AND rate_date < ?
         ORDER BY rate_date DESC LIMIT 1`
      )
      .get(base, quote, today);
    if (!prev) return { previous_rate: null, previous_date: null, change: null, change_percent: null, direction: null };

    const change = rate - Number(prev.rate);
    // Anything under a hundredth of a centavo is noise at two decimals, and
    // an arrow next to an unchanged-looking number reads as a bug.
    const flat = Math.abs(change) < 0.005;
    return {
      previous_rate: Number(prev.rate),
      previous_date: prev.rate_date,
      change: Number(change.toFixed(6)),
      change_percent: Number(((change / Number(prev.rate)) * 100).toFixed(4)),
      direction: flat ? "flat" : change > 0 ? "up" : "down",
    };
  } catch {
    return { previous_rate: null, previous_date: null, change: null, change_percent: null, direction: null };
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
    const settings = await appCurrency();
    const base = String(req.query.base || "USD").toUpperCase();
    let quote = String(req.query.quote || settings?.currency_code || "PHP").toUpperCase();
    if (quote === base) quote = base === "PHP" ? "USD" : "PHP";

    if (!CODE_RE.test(base) || !CODE_RE.test(quote)) {
      return res.status(400).json({ error: "base and quote must be 3-letter currency codes" });
    }

    const day = await localDate();
    const cacheKey = `${base}>${quote}@${day}`;
    const hit = responseCache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < RESPONSE_TTL_MS) {
      return res.json(hit.payload);
    }

    const result = await fetchRate(base, quote);
    if (!result) return res.status(503).json({ error: "Exchange rate is unavailable right now" });

    const comparison = await recordAndCompare(base, quote, result.rate, day);

    const payload = {
      base,
      quote,
      rate: result.rate,
      fetched_at: new Date(result.fetchedAt).toISOString(),
      stale: !!result.stale,
      ...comparison,
    };
    responseCache.set(cacheKey, { payload, storedAt: Date.now() });
    res.json(payload);
  })
);

module.exports = router;
