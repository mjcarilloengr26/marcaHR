const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken(user);
  const employee = user.employee_id
    ? db
        .prepare(
          `SELECT e.*, d.name AS department_name FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
        )
        .get(user.employee_id)
    : null;

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, employee_id: user.employee_id },
    employee,
  });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, employee_id FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const employee = user.employee_id
    ? db
        .prepare(
          `SELECT e.*, d.name AS department_name FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
        )
        .get(user.employee_id)
    : null;
  res.json({ user, employee });
});

module.exports = router;
