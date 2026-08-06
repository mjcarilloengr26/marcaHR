const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin"), (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.employee_id, u.created_at,
       (e.first_name || ' ' || e.last_name) AS employee_name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id
       ORDER BY u.email`
    )
    .all();
  res.json(users);
});

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { email, password, role, employee_id } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ error: "email, password and role are required" });
  }
  if (!["admin", "hr", "employee"].includes(role)) {
    return res.status(400).json({ error: "role must be admin, hr or employee" });
  }
  const password_hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare("INSERT INTO users (email, password_hash, role, employee_id) VALUES (?, ?, ?, ?)")
      .run(email.toLowerCase().trim(), password_hash, role, employee_id || null);
    res.status(201).json(
      db.prepare("SELECT id, email, role, employee_id FROM users WHERE id = ?").get(info.lastInsertRowid)
    );
  } catch (err) {
    res.status(400).json({ error: "A user with that email already exists" });
  }
});

router.put("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "User not found" });

  const { email, role, employee_id, password } = req.body || {};
  if (role && !["admin", "hr", "employee"].includes(role)) {
    return res.status(400).json({ error: "role must be admin, hr or employee" });
  }

  try {
    db.prepare("UPDATE users SET email = ?, role = ?, employee_id = ? WHERE id = ?").run(
      email ? email.toLowerCase().trim() : existing.email,
      role || existing.role,
      employee_id !== undefined ? employee_id || null : existing.employee_id,
      req.params.id
    );
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "A user with that email already exists" });
    }
    if (err.message.includes("FOREIGN KEY")) {
      return res.status(400).json({ error: "That linked employee no longer exists" });
    }
    return res.status(400).json({ error: "Could not update user" });
  }

  if (password) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), req.params.id);
  }

  res.json(
    db
      .prepare(
        `SELECT u.id, u.email, u.role, u.employee_id, (e.first_name || ' ' || e.last_name) AS employee_name
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?`
      )
      .get(req.params.id)
  );
});

router.put("/:id/password", requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password is required" });
  const isSelf = req.user.id === Number(req.params.id);
  const isAdmin = req.user.role === "admin";
  if (!isSelf && !isAdmin) return res.status(403).json({ error: "Insufficient permissions" });
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, req.params.id);
  res.status(204).end();
});

router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
