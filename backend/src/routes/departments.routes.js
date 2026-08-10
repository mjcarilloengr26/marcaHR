const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

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
    res.json(departments.map((d) => ({ ...d, employee_count: Number(d.employee_count) })));
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
      await logRequestEvent(req, "create_department", { entityType: "department", entityId: info.lastInsertRowid, details: { name } });
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
    await logRequestEvent(req, "update_department", { entityType: "department", entityId: Number(req.params.id) });
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
    await logRequestEvent(req, "delete_department", {
      entityType: "department",
      entityId: Number(req.params.id),
      details: { name: existing.name },
    });
    res.status(204).end();
  })
);

module.exports = router;
