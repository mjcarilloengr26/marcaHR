const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { stage, owner_id } = req.query;
  let sql = `SELECT d.*, (e.first_name || ' ' || e.last_name) AS owner_name
             FROM deals d LEFT JOIN employees e ON e.id = d.owner_id WHERE 1=1`;
  const params = [];
  if (stage) {
    sql += " AND d.stage = ?";
    params.push(stage);
  }
  if (owner_id) {
    sql += " AND d.owner_id = ?";
    params.push(owner_id);
  }
  sql += " ORDER BY d.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { title, customer_name, value, stage, owner_id, expected_close_date, notes } = req.body || {};
  if (!title || !customer_name) return res.status(400).json({ error: "title and customer_name are required" });
  const info = db
    .prepare(
      `INSERT INTO deals (title, customer_name, value, stage, owner_id, expected_close_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, customer_name, value || 0, stage || "lead", owner_id || null, expected_close_date || null, notes || null);
  res.status(201).json(db.prepare("SELECT * FROM deals WHERE id = ?").get(info.lastInsertRowid));
});

router.put("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Deal not found" });
  const { title, customer_name, value, stage, owner_id, expected_close_date, notes } = req.body || {};
  if (stage && !["lead", "qualified", "proposal", "negotiation", "won", "lost"].includes(stage)) {
    return res.status(400).json({ error: "Invalid stage" });
  }
  db.prepare(
    `UPDATE deals SET title = ?, customer_name = ?, value = ?, stage = ?, owner_id = ?, expected_close_date = ?, notes = ?
     WHERE id = ?`
  ).run(
    title ?? existing.title,
    customer_name ?? existing.customer_name,
    value !== undefined ? value : existing.value,
    stage || existing.stage,
    owner_id !== undefined ? owner_id || null : existing.owner_id,
    expected_close_date !== undefined ? expected_close_date : existing.expected_close_date,
    notes !== undefined ? notes : existing.notes,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Deal not found" });
  db.prepare("DELETE FROM deals WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
