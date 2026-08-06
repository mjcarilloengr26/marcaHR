const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notifyReviewSubmitted } = require("../notifications");

const router = express.Router();

// --- Review cycles ---
router.get("/cycles", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM review_cycles ORDER BY start_date DESC").all());
});

router.post("/cycles", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { name, start_date, end_date } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name is required" });
  const info = db
    .prepare("INSERT INTO review_cycles (name, start_date, end_date) VALUES (?, ?, ?)")
    .run(name, start_date || null, end_date || null);
  res.status(201).json(db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(info.lastInsertRowid));
});

router.put("/cycles/:id/status", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { status } = req.body || {};
  if (!["open", "closed"].includes(status)) return res.status(400).json({ error: "status must be open or closed" });
  db.prepare("UPDATE review_cycles SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id));
});

// --- Reviews ---
router.get("/reviews", requireAuth, (req, res) => {
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
  res.json(db.prepare(sql).all(...params));
});

router.post("/reviews", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { cycle_id, employee_id, reviewer_id, rating, goals, strengths, improvements, comments } = req.body || {};
  if (!cycle_id || !employee_id) return res.status(400).json({ error: "cycle_id and employee_id are required" });
  db.prepare(
    `INSERT INTO performance_reviews (cycle_id, employee_id, reviewer_id, rating, goals, strengths, improvements, comments, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
       ON CONFLICT(cycle_id, employee_id) DO UPDATE SET
         reviewer_id = excluded.reviewer_id, rating = excluded.rating, goals = excluded.goals,
         strengths = excluded.strengths, improvements = excluded.improvements, comments = excluded.comments`
  ).run(
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
  const record = db
    .prepare("SELECT * FROM performance_reviews WHERE cycle_id = ? AND employee_id = ?")
    .get(cycle_id, employee_id);
  res.status(201).json(record);
});

router.put("/reviews/:id/status", requireAuth, (req, res) => {
  const { status } = req.body || {};
  const review = db.prepare("SELECT * FROM performance_reviews WHERE id = ?").get(req.params.id);
  if (!review) return res.status(404).json({ error: "Review not found" });

  const isHr = ["admin", "hr"].includes(req.user.role);
  const isSubject = req.user.employee_id === review.employee_id;

  if (status === "submitted" && !isHr) return res.status(403).json({ error: "Only HR/admin can submit reviews" });
  if (status === "acknowledged" && !isSubject) {
    return res.status(403).json({ error: "Only the reviewed employee can acknowledge a review" });
  }
  if (!["draft", "submitted", "acknowledged"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  db.prepare("UPDATE performance_reviews SET status = ? WHERE id = ?").run(status, req.params.id);

  if (status === "submitted") {
    const cycle = db.prepare("SELECT name FROM review_cycles WHERE id = ?").get(review.cycle_id);
    notifyReviewSubmitted({ employee_id: review.employee_id, cycle_name: cycle?.name || "your review cycle" });
  }

  res.json(db.prepare("SELECT * FROM performance_reviews WHERE id = ?").get(req.params.id));
});

module.exports = router;
