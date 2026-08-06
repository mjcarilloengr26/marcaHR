const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notifyCardAssigned } = require("../notifications");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  const columns = db.prepare("SELECT * FROM board_columns ORDER BY position, id").all();
  const cards = db
    .prepare(
      `SELECT c.*, (e.first_name || ' ' || e.last_name) AS employee_name
       FROM board_cards c LEFT JOIN employees e ON e.id = c.employee_id
       ORDER BY c.position, c.id`
    )
    .all();
  const byColumn = new Map(columns.map((col) => [col.id, { ...col, cards: [] }]));
  for (const card of cards) {
    if (byColumn.has(card.column_id)) byColumn.get(card.column_id).cards.push(card);
  }
  res.json(Array.from(byColumn.values()));
});

router.post("/columns", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name is required" });
  const maxPos = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM board_columns").get().m;
  const info = db.prepare("INSERT INTO board_columns (name, position) VALUES (?, ?)").run(name, maxPos + 1);
  res.status(201).json(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(info.lastInsertRowid));
});

router.put("/columns/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM board_columns WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Column not found" });
  const { name, position } = req.body || {};
  db.prepare("UPDATE board_columns SET name = ?, position = ? WHERE id = ?").run(
    name ?? existing.name,
    position ?? existing.position,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(req.params.id));
});

router.delete("/columns/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM board_columns WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Column not found" });
  db.prepare("DELETE FROM board_columns WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

router.post("/cards", requireAuth, (req, res) => {
  const { column_id, title, description, employee_id, due_date } = req.body || {};
  if (!column_id || !title) return res.status(400).json({ error: "column_id and title are required" });
  const column = db.prepare("SELECT * FROM board_columns WHERE id = ?").get(column_id);
  if (!column) return res.status(404).json({ error: "Column not found" });

  const maxPos = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM board_cards WHERE column_id = ?").get(column_id).m;
  const info = db
    .prepare(
      `INSERT INTO board_cards (column_id, title, description, employee_id, due_date, position, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(column_id, title, description || null, employee_id || null, due_date || null, maxPos + 1, req.user.employee_id || null);
  if (employee_id) notifyCardAssigned({ employee_id, title });
  res.status(201).json(db.prepare("SELECT * FROM board_cards WHERE id = ?").get(info.lastInsertRowid));
});

router.put("/cards/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM board_cards WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Card not found" });
  const { title, description, employee_id, due_date } = req.body || {};
  const nextEmployeeId = employee_id !== undefined ? employee_id : existing.employee_id;
  db.prepare(
    "UPDATE board_cards SET title = ?, description = ?, employee_id = ?, due_date = ? WHERE id = ?"
  ).run(
    title ?? existing.title,
    description !== undefined ? description : existing.description,
    nextEmployeeId,
    due_date !== undefined ? due_date : existing.due_date,
    req.params.id
  );
  if (nextEmployeeId && nextEmployeeId !== existing.employee_id) {
    notifyCardAssigned({ employee_id: nextEmployeeId, title: title ?? existing.title });
  }
  res.json(db.prepare("SELECT * FROM board_cards WHERE id = ?").get(req.params.id));
});

// Move a card to a (possibly different) column and position; shifts other cards to keep positions contiguous.
router.put("/cards/:id/move", requireAuth, (req, res) => {
  const { column_id, position } = req.body || {};
  if (!column_id || position === undefined) {
    return res.status(400).json({ error: "column_id and position are required" });
  }
  const card = db.prepare("SELECT * FROM board_cards WHERE id = ?").get(req.params.id);
  if (!card) return res.status(404).json({ error: "Card not found" });
  const column = db.prepare("SELECT * FROM board_columns WHERE id = ?").get(column_id);
  if (!column) return res.status(404).json({ error: "Column not found" });

  const move = db.transaction(() => {
    if (card.column_id === Number(column_id)) {
      // Reordering within the same column.
      if (position < card.position) {
        db.prepare(
          "UPDATE board_cards SET position = position + 1 WHERE column_id = ? AND position >= ? AND position < ? AND id != ?"
        ).run(column_id, position, card.position, card.id);
      } else if (position > card.position) {
        db.prepare(
          "UPDATE board_cards SET position = position - 1 WHERE column_id = ? AND position <= ? AND position > ? AND id != ?"
        ).run(column_id, position, card.position, card.id);
      }
    } else {
      // Moving to a different column: close the gap left behind, open a gap at the destination.
      db.prepare("UPDATE board_cards SET position = position - 1 WHERE column_id = ? AND position > ?").run(
        card.column_id,
        card.position
      );
      db.prepare("UPDATE board_cards SET position = position + 1 WHERE column_id = ? AND position >= ?").run(
        column_id,
        position
      );
    }
    db.prepare("UPDATE board_cards SET column_id = ?, position = ? WHERE id = ?").run(column_id, position, card.id);
  });
  move();

  res.json(db.prepare("SELECT * FROM board_cards WHERE id = ?").get(req.params.id));
});

router.delete("/cards/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM board_cards WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Card not found" });
  db.prepare("DELETE FROM board_cards WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
