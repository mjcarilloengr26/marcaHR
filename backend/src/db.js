const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// DATA_DIR lets a deploy point the SQLite file at a mounted persistent disk
// (e.g. Render's disk add-on) instead of the container's ephemeral local
// filesystem, which is wiped on every redeploy/restart on the free tier.
// Falls back to the local ./data folder for dev, matching prior behavior.
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "hr.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// sales_targets' shape changed (monthly-only -> monthly/quarterly/yearly) before this
// table was ever deployed anywhere, so drop and let CREATE TABLE recreate it below
// rather than carrying migration logic for a shape with no real data at stake.
const existingTargetsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sales_targets'").get();
if (existingTargetsTable) {
  const cols = db.prepare("PRAGMA table_info(sales_targets)").all().map((c) => c.name);
  if (cols.includes("period_month")) {
    db.exec("DROP TABLE sales_targets");
  }
}

// work_orders' shape changed (internal request ticket -> customer-facing job tied to
// an order) before this table was ever deployed anywhere, so drop and recreate rather
// than migrate a shape with no real data at stake.
const existingWorkOrdersTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_orders'").get();
if (existingWorkOrdersTable) {
  const cols = db.prepare("PRAGMA table_info(work_orders)").all().map((c) => c.name);
  if (!cols.includes("work_order_number")) {
    db.exec("DROP TABLE work_orders");
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_meters REAL NOT NULL DEFAULT 1000,
  address TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  position TEXT,
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  hire_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  base_salary REAL DEFAULT 0,
  address TEXT,
  photo TEXT,
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
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_data TEXT,
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
  clock_in_photo TEXT,
  clock_out_photo TEXT,
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
  overtime_pay REAL NOT NULL DEFAULT 0,
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
  cost_center TEXT,
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
  receipt_ref TEXT,
  receipt_name TEXT,
  receipt_type TEXT,
  receipt_data TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  expected_close_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'placed' CHECK(status IN ('placed','processing','shipped','delivered','cancelled')),
  owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  deal_id INTEGER UNIQUE REFERENCES deals(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL DEFAULT (date('now')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL DEFAULT 'monthly' CHECK(period_type IN ('monthly','quarterly','yearly')),
  period_year INTEGER NOT NULL,
  period_index INTEGER NOT NULL DEFAULT 0,
  target_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, period_type, period_year, period_index)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  description TEXT,
  address TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','in_progress','completed','cancelled')),
  scheduled_date TEXT,
  completed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
  issue_date TEXT NOT NULL DEFAULT (date('now')),
  due_date TEXT,
  paid_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL UNIQUE,
  vendor_name TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','received','cancelled')),
  requested_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL DEFAULT (date('now')),
  expected_delivery_date TEXT,
  received_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every stock change (received, consumed, or manually adjusted) is logged here
-- rather than letting callers write quantity_on_hand directly, so there is
-- always an audit trail of who moved how much stock and why.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('in','out','adjustment')),
  quantity REAL NOT NULL,
  reason TEXT,
  reference TEXT,
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Singleton settings row (id is pinned to 1) so the low-stock alarm threshold
-- is a single editable value instead of a one-off config file.
CREATE TABLE IF NOT EXISTS inventory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alarm_threshold_percent REAL NOT NULL DEFAULT 20,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Singleton toggle so facial verification at clock-in/out can be switched
-- off (default) while testing, without a code change or redeploy.
CREATE TABLE IF NOT EXISTS attendance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  face_recognition_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.prepare("INSERT OR IGNORE INTO inventory_settings (id, alarm_threshold_percent) VALUES (1, 20)").run();
db.prepare("INSERT OR IGNORE INTO attendance_settings (id, face_recognition_enabled) VALUES (1, 0)").run();

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
for (const col of ["clock_in_photo", "clock_out_photo"]) {
  if (!attendanceColumns.includes(col)) {
    db.exec(`ALTER TABLE attendance ADD COLUMN ${col} TEXT`);
  }
}

const employeeColumns = db.prepare("PRAGMA table_info(employees)").all().map((c) => c.name);
if (!employeeColumns.includes("location_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL");
}
if (!employeeColumns.includes("photo")) {
  db.exec("ALTER TABLE employees ADD COLUMN photo TEXT");
}

const leaveRequestColumns = db.prepare("PRAGMA table_info(leave_requests)").all().map((c) => c.name);
for (const col of ["attachment_name", "attachment_type", "attachment_data"]) {
  if (!leaveRequestColumns.includes(col)) {
    db.exec(`ALTER TABLE leave_requests ADD COLUMN ${col} TEXT`);
  }
}

const expenseItemColumns = db.prepare("PRAGMA table_info(expense_items)").all().map((c) => c.name);
for (const col of ["receipt_name", "receipt_type", "receipt_data"]) {
  if (!expenseItemColumns.includes(col)) {
    db.exec(`ALTER TABLE expense_items ADD COLUMN ${col} TEXT`);
  }
}

const payrollColumns = db.prepare("PRAGMA table_info(payroll_records)").all().map((c) => c.name);
if (!payrollColumns.includes("overtime_pay")) {
  db.exec("ALTER TABLE payroll_records ADD COLUMN overtime_pay REAL NOT NULL DEFAULT 0");
}

const expenseReportColumns = db.prepare("PRAGMA table_info(expense_reports)").all().map((c) => c.name);
if (!expenseReportColumns.includes("cost_center")) {
  db.exec("ALTER TABLE expense_reports ADD COLUMN cost_center TEXT");
}

// SQLite's ALTER TABLE ADD COLUMN can't carry a UNIQUE constraint, so add the column
// plain and enforce uniqueness via a separate index (fresh installs get UNIQUE inline
// in the CREATE TABLE above; this only runs for databases that predate this column).
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
if (!orderColumns.includes("deal_id")) {
  db.exec("ALTER TABLE orders ADD COLUMN deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_deal_id ON orders(deal_id) WHERE deal_id IS NOT NULL");
}

module.exports = db;
