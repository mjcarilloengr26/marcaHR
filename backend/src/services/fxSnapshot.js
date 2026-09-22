const db = require("../db");
const { appTimezone } = require("./timezone");

// The rate a document was raised at, frozen on the day it was raised.
//
// A statement in a foreign currency is a commercial record, not a live
// readout. If it re-read today's rate every time somebody opened it, the peso
// equivalent printed against it would drift daily and two people looking at
// the same statement a week apart would see different numbers. So the figure
// is taken once, when the statement is created, and stored on it.
//
// Read from our own history rather than the provider: the header records a row
// per pair per day already, so the rate is almost always sitting there, and
// raising a statement must not wait on — or fail because of — somebody else's
// API.

async function today() {
  const tz = await appTimezone();
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

// Today's reading if we have one, else the most recent before it. An older
// rate carried forward is a known approximation; no rate at all leaves the
// document with nothing to show.
async function snapshotRate(base = "USD", quote = "PHP") {
  try {
    const day = await today();
    const row = await db
      .prepare(
        `SELECT rate, rate_date FROM exchange_rate_history
         WHERE base = ? AND quote = ? AND rate_date <= ?
         ORDER BY rate_date DESC LIMIT 1`
      )
      .get(base, quote, day);
    if (!row) return { rate: null, date: null };
    return { rate: Number(row.rate), date: row.rate_date };
  } catch {
    // A statement must still be raisable with no rate on file.
    return { rate: null, date: null };
  }
}

module.exports = { snapshotRate };
