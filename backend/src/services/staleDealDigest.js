const db = require("../db");
const { staleDeals } = require("./dealAging");
const { appTimezone } = require("./timezone");
const { notifyStaleDeals } = require("../notifications");
const { companyName } = require("./branding");

const ACTION = "stale_deal_digest";

// The hour, in the app's own timezone, the digest goes out. Early enough to be
// read before the day's calls, late enough not to arrive overnight.
const SEND_HOUR = Number(process.env.STALE_DIGEST_HOUR ?? 8);

// Today's date as the company sees it. Render runs in UTC, so a digest keyed on
// the server's own date would fire mid-afternoon in Manila and could send twice
// across a UTC midnight.
async function localParts() {
  const tz = await appTimezone();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), tz };
}

// The audit log is the record of what was sent, so a restart cannot cause a
// second send and no extra table is needed to remember.
async function alreadySentToday(localDate) {
  const row = await db
    .prepare(`SELECT id FROM audit_logs WHERE action = ? AND details LIKE ? LIMIT 1`)
    .get(ACTION, `%"localDate":"${localDate}"%`);
  return !!row;
}

async function runStaleDealDigest({ force = false } = {}) {
  const { date, hour, tz } = await localParts();
  if (!force) {
    if (hour !== SEND_HOUR) return { skipped: "outside the send hour", hour, tz };
    if (await alreadySentToday(date)) return { skipped: "already sent today", localDate: date };
  }

  const { deals, thresholdDays } = await staleDeals();
  if (deals.length === 0) {
    // Recorded even when empty, so a quiet pipeline doesn't make the job
    // re-check every minute for the rest of the hour.
    await record(date, 0, thresholdDays);
    return { sent: 0, thresholdDays, localDate: date };
  }

  await notifyStaleDeals({ deals, thresholdDays, companyLabel: await companyName() });
  await record(date, deals.length, thresholdDays);
  return { sent: deals.length, thresholdDays, localDate: date };
}

async function record(localDate, count, thresholdDays) {
  await db
    .prepare(
      `INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, details, ip_address)
       VALUES (NULL, ?, ?, 'deal', NULL, ?, NULL)`
    )
    .run("system", ACTION, JSON.stringify({ localDate, count, thresholdDays }));
}

// Checked hourly rather than daily: an hourly tick finds the send hour again
// after a restart, where a 24-hour timer set at boot would drift to whatever
// time the instance happened to wake up.
function scheduleStaleDealDigest() {
  if (process.env.STALE_DIGEST_ENABLED === "false") {
    console.log("Stale-opportunity digest disabled (STALE_DIGEST_ENABLED=false)");
    return;
  }
  const CHECK_EVERY_MS = 15 * 60 * 1000;
  console.log(`Stale-opportunity digest armed for ${String(SEND_HOUR).padStart(2, "0")}:00 app time`);
  const tick = () =>
    runStaleDealDigest()
      .then((r) => {
        if (r && r.sent) console.log(`Stale-opportunity digest sent for ${r.sent} opportunities`);
      })
      .catch((err) => console.error("Stale-opportunity digest failed:", err.message));
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = { runStaleDealDigest, scheduleStaleDealDigest, ACTION };
