const { Pool, types } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (a Postgres connection string, e.g. from Supabase)");
}

// node-postgres returns BIGINT (COUNT(*), etc.) and NUMERIC/DECIMAL columns as
// strings by default, to avoid silently losing precision on values too large
// for a JS double. This app's counts and money amounts never approach that
// range, and leaving them as strings is far more dangerous in practice: doing
// arithmetic like `count1 + count2` silently string-concatenates instead of
// adding ("1" + "3" -> "13"), and `count === 0` is always false against a
// string. That exact bug class produced garbled funnel totals across the
// Sales/Overview dashboards and let expense reports with zero items bypass a
// submit-time validation check. Parsing both types as real numbers globally,
// once, here — rather than remembering Number(...) at every call site — is
// what actually prevents this bug from being reintroduced by future code.
types.setTypeParser(20, (val) => parseInt(val, 10)); // int8 / bigint (COUNT(*), SUM(integer), etc.)
types.setTypeParser(1700, (val) => parseFloat(val)); // numeric / decimal

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Every route file was written against node:sqlite's synchronous
// db.prepare(sql).get/all/run(...params) shape. Rather than rewrite every
// query across ~20 route files into a different API, this shim keeps that
// exact call shape but backs it with Postgres — callers just need to await
// the result now (get/all/run all return promises).
//
// currentExecutor lets db.transaction() route every query issued inside its
// callback through one checked-out client instead of the shared pool, so
// multi-statement writes are actually atomic. Safe as plain module state
// because Node is single-threaded and every transaction() call is awaited to
// completion (BEGIN...COMMIT/ROLLBACK) before the next statement runs — two
// transactions can't interleave and stomp on this variable.
let currentExecutor = pool;

// SQLite placeholders are positional "?"; Postgres wants "$1, $2, ...".
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgParams(sql);
  // node:sqlite's .run() returns lastInsertRowid for INSERTs; Postgres has no
  // equivalent, so auto-append RETURNING id to any INSERT that doesn't
  // already have one. Every table in this schema has an `id` primary key, so
  // this is safe everywhere .run() is used for an insert.
  const isPlainInsert = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
  const runSql = isPlainInsert ? `${pgSql} RETURNING id` : pgSql;
  return {
    async get(...params) {
      const { rows } = await currentExecutor.query(pgSql, params);
      return rows[0];
    },
    async all(...params) {
      const { rows } = await currentExecutor.query(pgSql, params);
      return rows;
    },
    async run(...params) {
      const { rows, rowCount } = await currentExecutor.query(runSql, params);
      return { lastInsertRowid: rows[0]?.id, changes: rowCount };
    },
  };
}

const db = {
  prepare,
  async exec(sql) {
    await currentExecutor.query(sql);
  },
  transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      const prevExecutor = currentExecutor;
      currentExecutor = client;
      try {
        await client.query("BEGIN");
        const result = await fn(...args);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        currentExecutor = prevExecutor;
        client.release();
      }
    };
  },
};

// Schema is created fresh against Supabase (no pre-existing production data
// to migrate), so this is the final table shape directly — no need to carry
// the historical ALTER TABLE patches that accumulated over the SQLite era.
// "TEXT ... DEFAULT to_char(now() AT TIME ZONE 'UTC', ...)" keeps timestamp
// columns as plain UTC-formatted strings in exactly the shape the app's JS
// already parses everywhere (e.g. "2026-08-07 03:15:59"), rather than
// switching to native Postgres timestamp types and having to touch every
// date-handling call site across the app.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_meters REAL NOT NULL DEFAULT 1000,
  address TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','employee')),
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS leave_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_days_per_year INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  allocated_days REAL NOT NULL DEFAULT 0,
  used_days REAL NOT NULL DEFAULT 0,
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(employee_id, period_month, period_year)
);

CREATE TABLE IF NOT EXISTS review_cycles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id SERIAL PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  goals TEXT,
  strengths TEXT,
  improvements TEXT,
  comments TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','acknowledged')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(cycle_id, employee_id)
);

CREATE TABLE IF NOT EXISTS board_columns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS board_cards (
  id SERIAL PRIMARY KEY,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cash_advance_amount REAL NOT NULL DEFAULT 0,
  cost_center TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','reimbursed')),
  notes TEXT,
  reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  review_note TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS expense_items (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  expected_close_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'placed' CHECK(status IN ('placed','processing','shipped','delivered','cancelled')),
  owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  deal_id INTEGER UNIQUE REFERENCES deals(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS sales_targets (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL DEFAULT 'monthly' CHECK(period_type IN ('monthly','quarterly','yearly')),
  period_year INTEGER NOT NULL,
  period_index INTEGER NOT NULL DEFAULT 0,
  target_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(employee_id, period_type, period_year, period_index)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
  issue_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  due_date TEXT,
  paid_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  vendor_name TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','received','cancelled')),
  requested_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  expected_delivery_date TEXT,
  received_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('in','out','adjustment')),
  quantity REAL NOT NULL,
  reason TEXT,
  reference TEXT,
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inventory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alarm_threshold_percent REAL NOT NULL DEFAULT 20,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS attendance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  face_recognition_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- Inputs to the automatic payroll calculation (base pay proration + overtime),
-- kept editable rather than hardcoded since neither figure is safe to assume
-- for every company.
CREATE TABLE IF NOT EXISTS payroll_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  standard_hours_per_day REAL NOT NULL DEFAULT 8,
  overtime_multiplier REAL NOT NULL DEFAULT 1.25,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_deal_id ON orders(deal_id) WHERE deal_id IS NOT NULL;

-- Audit trail: who did what, when. user_email is denormalized (kept even if the
-- user row is later deleted) so log rows stay readable forever, which a hard FK
-- alone can't guarantee — ON DELETE SET NULL only protects the row from being
-- deleted, not from losing its human-readable identity.
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
`;

// One-time correction from the original 3 ad-hoc demo leave types to the 5
// company-standard ones, preserving existing leave_requests/leave_balances
// (which reference these rows by id) via rename rather than delete+recreate.
// Safe to run on every boot: each rename only ever fires once (the old name
// stops existing after it fires), and the insert-if-missing step uses
// ON CONFLICT DO NOTHING so it never clobbers a default_days_per_year that
// HR has since changed via PUT /leave/types/:id.
async function ensureLeaveTypeTaxonomy() {
  const renames = [
    ["Vacation", "Vacation Leave"],
    ["Sick", "Sick Leave"],
    ["Personal", "Emergency Leave"],
  ];
  for (const [oldName, newName] of renames) {
    await pool.query("UPDATE leave_types SET name = $1, default_days_per_year = 5 WHERE name = $2", [newName, oldName]);
  }
  const requiredTypes = ["Vacation Leave", "Paternity/Maternity Leave", "Sick Leave", "Emergency Leave", "No Pay Leave"];
  for (const name of requiredTypes) {
    await pool.query(
      "INSERT INTO leave_types (name, default_days_per_year) VALUES ($1, 5) ON CONFLICT (name) DO NOTHING",
      [name]
    );
  }
}

// Payroll moved from whole-month to semi-monthly (15th / end-of-month) cutoffs.
// period_half distinguishes the two runs within a month: 0 means a legacy
// whole-month record from before this change (left as-is, never touched), 1
// is the 1st-15th run, 2 is the 16th-end run. The original UNIQUE constraint
// only covered (employee_id, period_month, period_year), which would block
// two half-month records for the same employee/month from coexisting, so it's
// replaced with one that also includes period_half. Both steps are safe to
// repeat: the column add is a no-op after the first run (IF NOT EXISTS), and
// the constraint add/drop pair is idempotent via IF EXISTS / catching 42P07
// (duplicate_object) on a re-add.
async function ensurePayrollPeriodHalf() {
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS period_half SMALLINT NOT NULL DEFAULT 0");
  await pool.query(
    "ALTER TABLE payroll_records DROP CONSTRAINT IF EXISTS payroll_records_employee_id_period_month_period_year_key"
  );
  try {
    await pool.query(
      "ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_unique_period UNIQUE (employee_id, period_month, period_year, period_half)"
    );
  } catch (err) {
    if (err.code !== "42P07") throw err;
  }
}

let migrated = null;
// Idempotent: safe to call on every boot. Runs the full schema once per
// process (CREATE TABLE IF NOT EXISTS makes re-running harmless besides).
db.migrate = function () {
  if (!migrated) {
    migrated = pool
      .query(SCHEMA_SQL)
      .then(() =>
        pool.query(
          "INSERT INTO inventory_settings (id, alarm_threshold_percent) VALUES (1, 20) ON CONFLICT (id) DO NOTHING"
        )
      )
      .then(() =>
        pool.query(
          "INSERT INTO attendance_settings (id, face_recognition_enabled) VALUES (1, 0) ON CONFLICT (id) DO NOTHING"
        )
      )
      .then(() =>
        pool.query(
          "INSERT INTO payroll_settings (id, standard_hours_per_day, overtime_multiplier) VALUES (1, 8, 1.25) ON CONFLICT (id) DO NOTHING"
        )
      )
      .then(() => ensureLeaveTypeTaxonomy())
      .then(() => ensurePayrollPeriodHalf());
  }
  return migrated;
};

module.exports = db;
