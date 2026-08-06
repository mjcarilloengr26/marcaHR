const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");

const router = express.Router();

const EMPLOYEE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "department_id",
  "position",
  "manager_id",
  "hire_date",
  "status",
  "base_salary",
  "address",
];

router.get("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { department_id, status, q } = req.query;
  let sql = `SELECT e.*, d.name AS department_name,
             (m.first_name || ' ' || m.last_name) AS manager_name
             FROM employees e
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN employees m ON m.id = e.manager_id
             WHERE 1=1`;
  const params = [];
  if (department_id) {
    sql += " AND e.department_id = ?";
    params.push(department_id);
  }
  if (status) {
    sql += " AND e.status = ?";
    params.push(status);
  }
  if (q) {
    sql += " AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY e.last_name, e.first_name";
  res.json(db.prepare(sql).all(...params));
});

router.get("/:id", requireAuth, requireSelfOrRole((req) => req.params.id, "admin", "hr"), (req, res) => {
  const employee = db
    .prepare(
      `SELECT e.*, d.name AS department_name,
       (m.first_name || ' ' || m.last_name) AS manager_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.id = ?`
    )
    .get(req.params.id);
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const body = req.body || {};
  if (!body.first_name || !body.last_name || !body.email) {
    return res.status(400).json({ error: "first_name, last_name and email are required" });
  }
  const cols = EMPLOYEE_FIELDS.filter((f) => body[f] !== undefined);
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((f) => body[f]);
  try {
    const info = db
      .prepare(`INSERT INTO employees (${cols.join(", ")}) VALUES (${placeholders})`)
      .run(...values);
    res.status(201).json(db.prepare("SELECT * FROM employees WHERE id = ?").get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "Could not create employee (duplicate email?)" });
  }
});

router.put("/:id", requireAuth, requireSelfOrRole((req) => req.params.id, "admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Employee not found" });

  const body = req.body || {};
  // Employees editing themselves can only update contact info, not salary/status/dept/manager.
  const allowedFields =
    req.user.role === "admin" || req.user.role === "hr"
      ? EMPLOYEE_FIELDS
      : ["phone", "address"];

  const cols = allowedFields.filter((f) => body[f] !== undefined);
  if (cols.length === 0) return res.json(existing);
  const setClause = cols.map((f) => `${f} = ?`).join(", ");
  const values = cols.map((f) => body[f]);
  db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
  res.json(db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Employee not found" });
  db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
