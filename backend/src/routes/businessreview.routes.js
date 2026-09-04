const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { buildFactSheet, PERIOD_TYPES } = require("../services/businessReview");
const { writeNarrative, configured } = require("../services/reviewNarrative");
const { scheduleSettings, emailReview } = require("../services/businessReviewSchedule");
const { buildPrintableReview } = require("../services/reviewEmail");
const { companyName } = require("../services/branding");

const router = express.Router();

// Admin only, and deliberately not widened to HR or finance. A review reads
// across payroll, margin and every cost line at once — a combination no single
// module exposes to anyone but an admin today.
const adminOnly = [requireAuth, requireRole("admin")];

function parse(query) {
  const periodType = PERIOD_TYPES.includes(query.period_type) ? query.period_type : "monthly";
  const year = Number(query.year) || new Date().getFullYear();
  let index = Number(query.index);
  if (!Number.isFinite(index)) {
    if (periodType === "monthly") index = new Date().getMonth() + 1;
    else if (periodType === "quarterly") index = Math.floor(new Date().getMonth() / 3) + 1;
    else index = 0;
  }
  return { periodType, year, index };
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    period: { type: row.period_type, year: row.period_year, index: row.period_index, label: row.period_label },
    factSheet: JSON.parse(row.fact_sheet),
    narrative: row.narrative,
    narrativeError: row.narrative_error,
    model: row.model,
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    generatedAt: row.created_at,
    generatedByName: row.generated_by_name || null,
  };
}

const SELECT = `
  SELECT r.*, (e.first_name || ' ' || e.last_name) AS generated_by_name
  FROM business_reviews r LEFT JOIN employees e ON e.id = r.generated_by`;

// --- The schedule ----------------------------------------------------------
// When the review goes out, and to whom. Recipients are not editable here:
// they are every admin user, so adding a recipient means granting an admin
// account rather than quietly copying a review to someone outside that role.

const SEND_ON = new Set(["month_end", "first_of_next"]);

async function scheduleRow() {
  const s = await scheduleSettings();
  const admins = await db
    .prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email <> '' ORDER BY email")
    .all();
  return { ...s, recipients: admins.map((a) => a.email), narrativeAvailable: configured() };
}

router.get(
  "/schedule",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    res.json(await scheduleRow());
  })
);

router.put(
  "/schedule",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};

    if (b.sendOn !== undefined && !SEND_ON.has(b.sendOn)) {
      return res.status(400).json({ error: "Send day must be month_end or first_of_next" });
    }
    const hour = Number(b.sendHour);
    if (b.sendHour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
      return res.status(400).json({ error: "Send hour must be a whole number from 0 to 23" });
    }
    // Switching every cadence off leaves the schedule on but silent, which
    // reads as broken rather than as a choice. Say so instead.
    const cadences = ["monthly", "quarterly", "yearly"].map((k) =>
      b[k] === undefined ? undefined : Boolean(b[k])
    );
    const current = await scheduleSettings();
    const merged = {
      monthly: cadences[0] ?? current.monthly,
      quarterly: cadences[1] ?? current.quarterly,
      yearly: cadences[2] ?? current.yearly,
    };
    const enabled = b.enabled === undefined ? current.enabled : Boolean(b.enabled);
    if (enabled && !merged.monthly && !merged.quarterly && !merged.yearly) {
      return res.status(400).json({
        error: "Choose at least one review to send, or switch the schedule off entirely",
      });
    }

    await db
      .prepare(
        `UPDATE app_settings SET
           review_enabled = ?, review_send_on = ?, review_send_hour = ?,
           review_monthly = ?, review_quarterly = ?, review_yearly = ?,
           updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ?
         WHERE id = 1`
      )
      .run(
        enabled,
        b.sendOn === undefined ? current.sendOn : b.sendOn,
        b.sendHour === undefined ? current.sendHour : hour,
        merged.monthly,
        merged.quarterly,
        merged.yearly,
        req.user.id
      );

    await logRequestEvent(req, "update_review_schedule", {
      entityType: "app_settings",
      details: { enabled, sendOn: b.sendOn, sendHour: b.sendHour, ...merged },
    });

    res.json(await scheduleRow());
  })
);

// Send the most recent stored review to the admin list, so the schedule can be
// proved to work without waiting for month-end. Deliberately re-sends an
// existing review rather than writing a new one: this button is about
// delivery, and should not cost an API call.
router.post(
  "/schedule/test",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT period_label, fact_sheet, narrative, narrative_error FROM business_reviews ORDER BY id DESC LIMIT 1")
      .get();
    if (!row) {
      return res.status(400).json({
        error: "There is no review to send yet. Generate one from the Business Review page first.",
      });
    }
    const recipients = await db
      .prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email <> ''")
      .all();
    if (recipients.length === 0) {
      return res.status(400).json({ error: "No admin user has an email address on record." });
    }

    await emailReview({
      factSheet: JSON.parse(row.fact_sheet),
      narrative: row.narrative,
      narrativeError: row.narrative_error,
    });

    await logRequestEvent(req, "review_schedule_test_email", {
      entityType: "app_settings",
      details: { period: row.period_label, recipients: recipients.length },
    });

    res.json({ sent: recipients.map((r) => r.email), period: row.period_label });
  })
);

// The printable report: the same document the email carries, sized for A4.
// Returns HTML rather than a PDF — the browser's own print dialog produces a
// better PDF than a headless renderer would, and adding one would mean
// shipping a browser to Render for a page anyone can already print.
router.get(
  "/print",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const { periodType, year, index } = parse(req.query);
    const stored = await db
      .prepare(`${SELECT} WHERE r.period_type = ? AND r.period_year = ? AND r.period_index = ?`)
      .get(periodType, year, index);

    const company = await companyName();
    const args = stored
      ? {
          factSheet: JSON.parse(stored.fact_sheet),
          narrative: stored.narrative,
          narrativeError: stored.narrative_error,
          company,
        }
      : {
          // Nothing written yet: the figures still print, with the reason the
          // commentary is missing in place of it.
          factSheet: await buildFactSheet({ periodType, year, index }),
          narrative: null,
          narrativeError: "No review has been written for this period yet.",
          company,
        };

    res.type("html").send(buildPrintableReview(args));
  })
);

// Every review written so far, newest first — the value of a review is partly
// in reading it next to the one before.
router.get(
  "/history",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT r.id, r.period_type, r.period_year, r.period_index, r.period_label,
                r.created_at, r.narrative IS NOT NULL AS has_narrative, r.narrative_error,
                (e.first_name || ' ' || e.last_name) AS generated_by_name
         FROM business_reviews r LEFT JOIN employees e ON e.id = r.generated_by
         ORDER BY r.period_year DESC,
                  CASE r.period_type WHEN 'yearly' THEN 0 WHEN 'quarterly' THEN 1 ELSE 2 END,
                  r.period_index DESC
         LIMIT 60`
      )
      .all();
    res.json(rows);
  })
);

// The figures for a period, with the written review if one has been generated.
// Building the fact sheet is fast; writing the narrative is not, which is why
// the two are separate requests.
router.get(
  "/",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const { periodType, year, index } = parse(req.query);
    const stored = await db
      .prepare(`${SELECT} WHERE r.period_type = ? AND r.period_year = ? AND r.period_index = ?`)
      .get(periodType, year, index);

    if (stored) return res.json({ ...shape(stored), stale: false });

    // Nothing written yet — hand back the live figures so the page has
    // something to show, and say the narrative is missing rather than pretend.
    const factSheet = await buildFactSheet({ periodType, year, index });
    res.json({
      id: null,
      period: factSheet.period,
      factSheet,
      narrative: null,
      narrativeError: null,
      model: null,
      usage: { inputTokens: null, outputTokens: null },
      generatedAt: null,
      generatedByName: null,
      narrativeAvailable: configured(),
    });
  })
);

// Write the review. Takes the better part of a minute, so the page shows a
// spinner rather than this being something a page load triggers.
router.post(
  "/generate",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const { periodType, year, index } = parse(req.body || {});
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
      // The figures are worth storing whether or not the prose could be
      // written — a missing key should not lose the numbers too.
      narrativeError = err.message;
    }

    await db
      .prepare(
        `INSERT INTO business_reviews
           (period_type, period_year, period_index, period_label, fact_sheet, narrative, model,
            input_tokens, output_tokens, narrative_error, generated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (period_type, period_year, period_index) DO UPDATE SET
           period_label = excluded.period_label,
           fact_sheet = excluded.fact_sheet,
           narrative = excluded.narrative,
           model = excluded.model,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           narrative_error = excluded.narrative_error,
           generated_by = excluded.generated_by,
           created_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
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
        narrativeError,
        req.user.employee_id || null
      );

    const stored = await db
      .prepare(`${SELECT} WHERE r.period_type = ? AND r.period_year = ? AND r.period_index = ?`)
      .get(periodType, year, index);

    await logRequestEvent(req, "business_review_generated", {
      entityType: "business_review",
      entityId: stored.id,
      details: { period: factSheet.period.label, hadNarrative: Boolean(narrative), error: narrativeError },
    });

    res.status(201).json(shape(stored));
  })
);

router.delete(
  "/:id",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT id FROM business_reviews WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Review not found" });
    await db.prepare("DELETE FROM business_reviews WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
