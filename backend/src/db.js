const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "hr.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  position TEXT,
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  hire_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  base_salary REAL DEFAULT 0,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','employee')),
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  default_days_per_year INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  allocated_days REAL NOT NULL DEFAULT 0,
  used_days REAL NOT NULL DEFAULT 0,
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','late','half_day','leave')),
  clock_in TEXT,
  clock_out TEXT,
  clock_in_lat REAL,
  clock_in_lng REAL,
  clock_in_accuracy REAL,
  clock_in_distance_m REAL,
  clock_out_lat REAL,
  clock_out_lng REAL,
  clock_out_accuracy REAL,
  clock_out_distance_m REAL,
  note TEXT,
  UNIQUE(employee_id, date)
);

CREATE TABLE IF NOT EXISTS payroll_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month INTEGER NOT NULL,
  period_year INTEGER NOT NULL,
  base_salary REAL NOT NULL DEFAULT 0,
  bonuses REAL NOT NULL DEFAULT 0,
  deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized','paid')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, period_month, period_year)
);

CREATE TABLE IF NOT EXISTS review_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  goals TEXT,
  strengths TEXT,
  improvements TEXT,
  comments TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','acknowledged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, employee_id)
);

CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS board_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cash_advance_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','reimbursed')),
  notes TEXT,
  reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  review_note TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
  expense_date TEXT NOT NULL,
  category TEXT,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  receipt_ref TEXT
);
`);

// node:sqlite's DatabaseSync has no built-in transaction helper (unlike better-sqlite3),
// so provide a minimal equivalent for the call sites that expect db.transaction(fn).
db.transaction = function (fn) {
  return function (...args) {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
};

// Lightweight migration for databases created before the GPS columns existed:
// CREATE TABLE IF NOT EXISTS doesn't alter existing tables, so add any missing columns here.
const attendanceColumns = db.prepare("PRAGMA table_info(attendance)").all().map((c) => c.name);
for (const col of [
  "clock_in_lat",
  "clock_in_lng",
  "clock_in_accuracy",
  "clock_in_distance_m",
  "clock_out_lat",
  "clock_out_lng",
  "clock_out_accuracy",
  "clock_out_distance_m",
]) {
  if (!attendanceColumns.includes(col)) {
    db.exec(`ALTER TABLE attendance ADD COLUMN ${col} REAL`);
  }
}

module.exports = db;
