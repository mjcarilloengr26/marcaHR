const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const departments = await db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employee_count
         FROM departments d ORDER BY d.name`
      )
      .all();
    res.json(departments);
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
      const info = await db.prepare("INSERT INTO departments (name, description) VALUES (?, ?)").run(name, description || null);
      res.status(201).json(await db.prepare("SELECT * FROM departments WHERE id = ?").get(info.lastInsertRowid));
    } catch (err) {
      res.status(400).json({ error: "A department with that name already exists" });
    }
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { name, description } = req.body || {};
    const existing = await db.prepare("SELECT * FROM departments WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Department not found" });
    await db.prepare("UPDATE departments SET name = ?, description = ? WHERE id = ?").run(
      name ?? existing.name,
      description ?? existing.description,
      req.params.id
    );
    res.json(await db.prepare("SELECT * FROM departments WHERE id = ?").get(req.params.id));
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM departments WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Department not found" });
    await db.prepare("DELETE FROM departments WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
