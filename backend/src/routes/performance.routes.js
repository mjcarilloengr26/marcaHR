const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notifyReviewSubmitted } = require("../notifications");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

// --- Review cycles ---
router.get(
  "/cycles",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM review_cycles ORDER BY start_date DESC").all());
  })
);

router.post(
  "/cycles",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { name, start_date, end_date } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    const info = await db
      .prepare("INSERT INTO review_cycles (name, start_date, end_date) VALUES (?, ?, ?)")
      .run(name, start_date || null, end_date || null);
    res.status(201).json(await db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.put(
  "/cycles/:id/status",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    if (!["open", "closed"].includes(status)) return res.status(400).json({ error: "status must be open or closed" });
    await db.prepare("UPDATE review_cycles SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json(await db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id));
  })
);

router.put(
  "/cycles/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Review cycle not found" });

    const { name, start_date, end_date, status } = req.body || {};
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    if (status !== undefined && !["open", "closed"].includes(status)) {
      return res.status(400).json({ error: "status must be open or closed" });
    }
    await db
      .prepare("UPDATE review_cycles SET name = ?, start_date = ?, end_date = ?, status = ? WHERE id = ?")
      .run(
        name !== undefined ? String(name).trim() : existing.name,
        start_date !== undefined ? start_date || null : existing.start_date,
        end_date !== undefined ? end_date || null : existing.end_date,
        status !== undefined ? status : existing.status,
        req.params.id
      );
    const updated = await db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id);
    await logRequestEvent(req, "update_review_cycle", {
      entityType: "review_cycle",
      entityId: Number(req.params.id),
      details: { name: updated.name, status: updated.status },
    });
    res.json(updated);
  })
);

// Refuses rather than cascading: reviews carry the ratings and written
// feedback people actually wrote, and losing those to a tidy-up of the cycle
// list would be silent and unrecoverable. Close the cycle instead.
router.delete(
  "/cycles/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Review cycle not found" });
    const used = await db.prepare("SELECT COUNT(*) AS n FROM performance_reviews WHERE cycle_id = ?").get(req.params.id);
    if (used.n > 0) {
      return res.status(400).json({
        error: `This cycle has ${used.n} review${used.n > 1 ? "s" : ""} against it. Close it instead of deleting, or remove those reviews first.`,
      });
    }
    await db.prepare("DELETE FROM review_cycles WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_review_cycle", {
      entityType: "review_cycle",
      entityId: Number(req.params.id),
      details: { name: existing.name },
    });
    res.status(204).end();
  })
);

// --- Reviews ---
router.get(
  "/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `SELECT r.*, (e.first_name || ' ' || e.last_name) AS employee_name,
             (rv.first_name || ' ' || rv.last_name) AS reviewer_name,
             rc.name AS cycle_name
             FROM performance_reviews r
             JOIN employees e ON e.id = r.employee_id
             LEFT JOIN employees rv ON rv.id = r.reviewer_id
             JOIN review_cycles rc ON rc.id = r.cycle_id
             WHERE 1=1`;
    const params = [];

    if (req.user.role === "employee") {
      sql += " AND r.employee_id = ? AND r.status != 'draft'";
      params.push(req.user.employee_id);
    } else if (req.query.employee_id) {
      sql += " AND r.employee_id = ?";
      params.push(req.query.employee_id);
    }

    if (req.query.cycle_id) {
      sql += " AND r.cycle_id = ?";
      params.push(req.query.cycle_id);
    }

    sql += " ORDER BY r.created_at DESC";
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/reviews",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { cycle_id, employee_id, reviewer_id, rating, goals, strengths, improvements, comments } = req.body || {};
    if (!cycle_id || !employee_id) return res.status(400).json({ error: "cycle_id and employee_id are required" });
    await db
      .prepare(
        `INSERT INTO performance_reviews (cycle_id, employee_id, reviewer_id, rating, goals, strengths, improvements, comments, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
       ON CONFLICT(cycle_id, employee_id) DO UPDATE SET
         reviewer_id = excluded.reviewer_id, rating = excluded.rating, goals = excluded.goals,
         strengths = excluded.strengths, improvements = excluded.improvements, comments = excluded.comments`
      )
      .run(
        cycle_id,
        employee_id,
        reviewer_id || req.user.employee_id || null,
        rating || null,
        goals || null,
        strengths || null,
        improvements || null,
        comments || null
      );
    // lastInsertRowid is unreliable on the UPDATE path of an upsert, so look the row up by its natural key.
    const record = await db
      .prepare("SELECT * FROM performance_reviews WHERE cycle_id = ? AND employee_id = ?")
      .get(cycle_id, employee_id);
    res.status(201).json(record);
  })
);

router.put(
  "/reviews/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    if (!["draft", "submitted", "acknowledged"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const review = await db.prepare("SELECT * FROM performance_reviews WHERE id = ?").get(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });

    const isHr = ["admin", "hr"].includes(req.user.role);
    const isSubject = req.user.employee_id === review.employee_id;

    // Blanket check first: only HR/admin or the reviewed employee may touch this
    // review at all — without this, any authenticated employee could read and
    // rewrite the status of anyone else's review via an arbitrary :id.
    if (!isHr && !isSubject) return res.status(403).json({ error: "Insufficient permissions" });

    if (status === "submitted" && !isHr) return res.status(403).json({ error: "Only HR/admin can submit reviews" });
    if (status === "acknowledged" && !isSubject) {
      return res.status(403).json({ error: "Only the reviewed employee can acknowledge a review" });
    }
    if (status === "draft" && !isHr) {
      return res.status(403).json({ error: "Only HR/admin can reset a review to draft" });
    }

    await db.prepare("UPDATE performance_reviews SET status = ? WHERE id = ?").run(status, req.params.id);

    if (status === "submitted") {
      const cycle = await db.prepare("SELECT name FROM review_cycles WHERE id = ?").get(review.cycle_id);
      notifyReviewSubmitted({ employee_id: review.employee_id, cycle_name: cycle?.name || "your review cycle" });
    }

    res.json(await db.prepare("SELECT * FROM performance_reviews WHERE id = ?").get(req.params.id));
  })
);

module.exports = router;
