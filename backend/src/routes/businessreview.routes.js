const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { buildFactSheet, PERIOD_TYPES } = require("../services/businessReview");
const { writeNarrative, configured } = require("../services/reviewNarrative");

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
