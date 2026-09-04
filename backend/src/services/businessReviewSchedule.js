const db = require("../db");
const { buildFactSheet } = require("./businessReview");
const { writeNarrative, configured } = require("./reviewNarrative");
const { appTimezone } = require("./timezone");
const { companyName } = require("./branding");
const { sendMail } = require("../mailer");
const { buildReviewEmail } = require("./reviewEmail");

// Defaults for a database that predates the settings screen. REVIEW_HOUR is
// still read so an existing deployment's environment variable keeps working,
// but the stored setting wins once an admin has saved one.
const DEFAULTS = {
  enabled: true,
  sendOn: "month_end",
  sendHour: Number(process.env.REVIEW_HOUR ?? 20),
  monthly: true,
  quarterly: true,
  yearly: true,
};

// Read fresh on every tick rather than cached at boot: an admin changing the
// send time should not have to wait for a redeploy for it to take effect.
async function scheduleSettings() {
  try {
    const row = await db
      .prepare(
        `SELECT review_enabled, review_send_on, review_send_hour,
                review_monthly, review_quarterly, review_yearly
         FROM app_settings WHERE id = 1`
      )
      .get();
    if (!row) return { ...DEFAULTS };
    const hour = Number(row.review_send_hour);
    return {
      enabled: row.review_enabled !== false,
      sendOn: row.review_send_on === "first_of_next" ? "first_of_next" : "month_end",
      sendHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULTS.sendHour,
      monthly: row.review_monthly !== false,
      quarterly: row.review_quarterly !== false,
      yearly: row.review_yearly !== false,
    };
  } catch {
    // A settings read must never be what stops a review going out.
    return { ...DEFAULTS };
  }
}

// Today as the company sees it. Render runs in UTC, so a job keyed on the
// server's own date would fire mid-afternoon in Manila and could run twice
// across a UTC midnight.
async function localToday() {
  const tz = await appTimezone();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    tz,
  };
}

// The last calendar day of a month — 28, 29, 30 or 31. Asking for "the 30th or
// 31st" literally would skip February entirely and fire a day early in every
// 31-day month, so the rule is the month's own last day.
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Which reviews are due today. They go out on the last day of the month, so
// each one covers the month it is sent in — September's review arrives on
// 30 September, not on 1 October.
//
// The trade-off is deliberate: anything recorded after SEND_HOUR on the final
// day is not in the figures. Running on the 1st would capture the month whole
// but deliver it a day late, and month-end delivery is what was asked for.
// 'first_of_next' is the alternative: on the 1st, review the month that just
// ended. Nothing is missed, but it lands a day after the month it covers.
function periodsDue({ year, month, day }, settings = DEFAULTS) {
  const wanted = (t) =>
    (t === "monthly" && settings.monthly) ||
    (t === "quarterly" && settings.quarterly) ||
    (t === "yearly" && settings.yearly);

  const due = [];

  if (settings.sendOn === "first_of_next") {
    if (day !== 1) return [];
    const m = month === 1 ? 12 : month - 1;
    const y = month === 1 ? year - 1 : year;
    due.push({ periodType: "monthly", year: y, index: m });
    if (m % 3 === 0) due.push({ periodType: "quarterly", year: y, index: m / 3 });
    if (m === 12) due.push({ periodType: "yearly", year: y, index: 0 });
  } else {
    if (day !== lastDayOfMonth(year, month)) return [];
    due.push({ periodType: "monthly", year, index: month });
    // A quarter ends with March, June, September or December.
    if (month % 3 === 0) due.push({ periodType: "quarterly", year, index: month / 3 });
    if (month === 12) due.push({ periodType: "yearly", year, index: 0 });
  }

  return due.filter((d) => wanted(d.periodType));
}

// The table's own unique constraint is the record of what has been written, so
// a restart cannot produce a second copy and no separate bookkeeping is needed.
async function alreadyWritten({ periodType, year, index }) {
  const row = await db
    .prepare(
      "SELECT id FROM business_reviews WHERE period_type = ? AND period_year = ? AND period_index = ?"
    )
    .get(periodType, year, index);
  return Boolean(row);
}

async function adminEmails() {
  const rows = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  return rows.map((r) => r.email).filter(Boolean);
}

async function generateAndStore({ periodType, year, index }) {
  const factSheet = await buildFactSheet({ periodType, year, index });

  let narrative = null;
  let model = null;
  let usage = { inputTokens: null, outputTokens: null };
  let narrativeError = null;
  try {
    const written = await writeNarrative(factSheet);
    narrative = written.narrative;
    model = written.model;
    usage = written.usage;
  } catch (err) {
    // Store the figures regardless. A missing key or a bad API day should not
    // also cost the month's numbers.
    narrativeError = err.message;
  }

  await db
    .prepare(
      `INSERT INTO business_reviews
         (period_type, period_year, period_index, period_label, fact_sheet, narrative, model,
          input_tokens, output_tokens, narrative_error, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (period_type, period_year, period_index) DO NOTHING`
    )
    .run(
      periodType,
      year,
      index,
      factSheet.period.label,
      JSON.stringify(factSheet),
      narrative,
      model,
      usage.inputTokens,
      usage.outputTokens,
      narrativeError
    );

  return { factSheet, narrative, narrativeError };
}

async function emailReview({ factSheet, narrative, narrativeError }) {
  const to = await adminEmails();
  if (to.length === 0) return;
  const company = await companyName();

  // Figures, the one chart, the summary and what needs attention, in both an
  // HTML and a plain-text form. Built in one place so the email, the printed
  // report and the page cannot drift apart.
  const { subject, text, html } = buildReviewEmail({ factSheet, narrative, narrativeError, company });

  sendMail({ to, subject, text, html });
}

async function runDueReviews({ force = null } = {}) {
  const settings = await scheduleSettings();
  const today = await localToday();

  // A forced run is an admin pressing a button, so it ignores the switch and
  // the calendar — but not the model, which may still be unconfigured.
  if (!force && !settings.enabled) return { skipped: "scheduled reviews are switched off" };

  const due = force ? [force] : periodsDue(today, settings);
  if (!force && today.hour !== settings.sendHour) {
    return { skipped: "outside the send hour", hour: today.hour, sendHour: settings.sendHour, tz: today.tz };
  }
  if (due.length === 0) return { skipped: "nothing due today", day: today.day };

  const written = [];
  for (const period of due) {
    if (!force && (await alreadyWritten(period))) continue;
    const result = await generateAndStore(period);
    await emailReview(result);
    written.push(result.factSheet.period.label);
  }
  return { written, checked: due.length };
}

// Checked hourly rather than daily: an hourly tick finds the send hour again
// after a restart, where a 24-hour timer set at boot would drift to whatever
// time the instance happened to wake.
function scheduleBusinessReviews() {
  if (process.env.BUSINESS_REVIEW_ENABLED === "false") {
    console.log("Scheduled business reviews disabled (BUSINESS_REVIEW_ENABLED=false)");
    return;
  }
  const CHECK_EVERY_MS = 30 * 60 * 1000;
  scheduleSettings()
    .then((s) =>
      console.log(
        s.enabled
          ? `Business reviews armed for ${String(s.sendHour).padStart(2, "0")}:00 app time ` +
            (s.sendOn === "month_end" ? "on the last day of each month" : "on the 1st of each month") +
            (configured() ? "" : " — no ANTHROPIC_API_KEY yet, so figures only")
          : "Scheduled business reviews are switched off in Administration → Review Schedule"
      )
    )
    .catch(() => {});
  const tick = () =>
    runDueReviews()
      .then((r) => {
        if (r && r.written && r.written.length) console.log(`Business review written for ${r.written.join(", ")}`);
      })
      .catch((err) => console.error("Business review job failed:", err.message));
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = {
  scheduleBusinessReviews,
  runDueReviews,
  periodsDue,
  generateAndStore,
  emailReview,
  scheduleSettings,
  DEFAULTS,
};
