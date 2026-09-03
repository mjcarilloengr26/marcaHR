const db = require("../db");
const { buildFactSheet } = require("./businessReview");
const { writeNarrative, configured } = require("./reviewNarrative");
const { appTimezone } = require("./timezone");
const { companyName } = require("./branding");
const { sendMail } = require("../mailer");

// The hour, in the company's own timezone, a scheduled review is written.
const SEND_HOUR = Number(process.env.REVIEW_HOUR ?? 7);

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

// Which reviews are due today. A period can only be reviewed once it has
// finished, so everything here looks backwards: on the 1st, review what just
// ended.
function periodsDue({ year, month, day }) {
  if (day !== 1) return [];
  const due = [];

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;
  due.push({ periodType: "monthly", year: prevMonthYear, index: prevMonth });

  // A quarter ends on the last day of March, June, September or December, so
  // the 1st of January, April, July and October is the morning after one.
  if ([1, 4, 7, 10].includes(month)) {
    const prevQuarter = month === 1 ? 4 : Math.floor((month - 1) / 3);
    const prevQuarterYear = month === 1 ? year - 1 : year;
    due.push({ periodType: "quarterly", year: prevQuarterYear, index: prevQuarter });
  }

  if (month === 1) due.push({ periodType: "yearly", year: year - 1, index: 0 });

  return due;
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
  const p = factSheet.period;

  const body = narrative
    ? `${narrative}\n\n—\nFigures cover ${p.start} to ${p.end}. Read the full review in ${company} under Reports.`
    : `The figures for ${p.label} are ready, but the written review could not be generated:\n\n` +
      `  ${narrativeError}\n\nThe numbers are in ${company} under Reports.`;

  sendMail({
    to,
    subject: `Business review — ${p.label}`,
    text: body,
  });
}

async function runDueReviews({ force = null } = {}) {
  const today = await localToday();

  const due = force ? [force] : periodsDue(today);
  if (!force && today.hour !== SEND_HOUR) {
    return { skipped: "outside the send hour", hour: today.hour, tz: today.tz };
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
  console.log(
    `Business reviews armed for ${String(SEND_HOUR).padStart(2, "0")}:00 app time on the 1st` +
      (configured() ? "" : " — no ANTHROPIC_API_KEY yet, so figures only")
  );
  const tick = () =>
    runDueReviews()
      .then((r) => {
        if (r && r.written && r.written.length) console.log(`Business review written for ${r.written.join(", ")}`);
      })
      .catch((err) => console.error("Business review job failed:", err.message));
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = { scheduleBusinessReviews, runDueReviews, periodsDue, generateAndStore };
