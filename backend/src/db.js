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
  // Supabase is a network round-trip away and opening a fresh TLS Postgres
  // connection to it costs roughly a second. The default idleTimeoutMillis
  // (10s) meant a quiet minute was enough to throw the connection away, so
  // the next request — very often someone signing in — paid that second
  // before its first query even ran. Hold connections open instead, and keep
  // the TCP socket alive so an idle one is not dropped by anything in between.
  keepAlive: true,
  idleTimeoutMillis: 0,
  // Supabase's session-mode pooler allows 15 client connections in total, and
  // holding connections open (above) means an instance keeps its whole
  // allocation for as long as it runs. Two instances therefore have to fit
  // inside 15 — and they routinely coexist, because a deploy runs the new
  // instance before retiring the old one. At 10 each that overlap exhausted
  // the pooler and every request failed; 5 leaves room for the overlap plus a
  // migration or a psql session.
  max: 5,
});

// Holding idle connections open means a connection killed at the far end (a
// Supabase restart, a network blip) surfaces as an error on the pool rather
// than on any one query — and an unhandled one of those takes the whole
// process down. pg has already discarded the bad client by the time this
// fires, so logging is all that is needed; the next query opens a fresh one.
pool.on("error", (err) => {
  console.error("Postgres pool error (idle client discarded):", err.message);
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
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_meters NUMERIC(14,3) NOT NULL DEFAULT 1000,
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
  base_salary NUMERIC(14,2) DEFAULT 0,
  address TEXT,
  photo TEXT,
  deduction_sss NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_hdmf NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_philhealth NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_loans NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_cash_advances NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','employee')),
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  terms_version TEXT,
  terms_accepted_at TEXT,
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
  allocated_days NUMERIC(14,3) NOT NULL DEFAULT 0,
  used_days NUMERIC(14,3) NOT NULL DEFAULT 0,
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days NUMERIC(14,3) NOT NULL,
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
  clock_in_lat DOUBLE PRECISION,
  clock_in_lng DOUBLE PRECISION,
  clock_in_accuracy NUMERIC(14,3),
  clock_in_distance_m NUMERIC(14,3),
  clock_out_lat DOUBLE PRECISION,
  clock_out_lng DOUBLE PRECISION,
  clock_out_accuracy NUMERIC(14,3),
  clock_out_distance_m NUMERIC(14,3),
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
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonuses NUMERIC(14,2) NOT NULL DEFAULT 0,
  overtime_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  night_differential_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_sss NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_hdmf NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_philhealth NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_loans NUMERIC(14,2) NOT NULL DEFAULT 0,
  deduction_cash_advances NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
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

-- A card can be assigned to multiple employees (or all of them) at once, so
-- assignment is many-to-many rather than the single employee_id column above
-- (kept in place, unused going forward, rather than dropped).
CREATE TABLE IF NOT EXISTS board_card_assignees (
  id SERIAL PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE (card_id, employee_id)
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  expense_type TEXT,
  cash_advance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
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
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  receipt_ref TEXT,
  receipt_name TEXT,
  receipt_type TEXT,
  receipt_data TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  expected_close_date TEXT,
  notes TEXT,
  competitor TEXT,
  -- When the deal last moved stage. "Days in stage" is the question a pipeline
  -- review actually asks, and created_at cannot answer it: a deal opened in
  -- January and pushed to Proposal yesterday is not a stale proposal.
  stage_changed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'placed' CHECK(status IN ('placed','processing','shipped','delivered','cancelled')),
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_at TEXT,
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
  target_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
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
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_at TEXT,
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
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status_changed_at TEXT,
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
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','received','cancelled')),
  requested_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  -- What the purchase was for. Completes the chain the rest of the app already
  -- has — opportunity to order to work order — so spend can be traced back to
  -- the job that caused it. Nullable on purpose: office supplies and general
  -- overheads are real purchases with no job behind them, and forcing a link
  -- would only produce a fake one.
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  -- Who signed the spend off, and when. requested_by above already records who
  -- raised it, so together they answer the two questions an audit asks of any
  -- purchase: who wanted this, and who agreed to pay for it.
  approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  approved_at TEXT,
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
  quantity_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('in','out','adjustment')),
  quantity NUMERIC(14,3) NOT NULL,
  reason TEXT,
  reference TEXT,
  created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inventory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alarm_threshold_percent NUMERIC(14,3) NOT NULL DEFAULT 20,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS attendance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  face_recognition_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- Time-boxed page access: lets an admin give one user access to one page
-- (e.g. Inventory) until expires_at, after which it simply stops matching the
-- "active grant" query and access reverts to whatever their role allows.
-- Nothing needs to run on a schedule to revoke it. role_label is a free-text
-- name for the arrangement ("Inventory Staff") shown in the admin list.
-- Enforced server-side in middleware/auth.js, not just in the UI.
CREATE TABLE IF NOT EXISTS page_access_grants (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key TEXT NOT NULL,
  role_label TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_page_access_grants_user ON page_access_grants(user_id);

-- App-wide currency and language, set by an admin at Administration >
-- Localization. Only the ISO currency code is stored — the symbol and where
-- it sits relative to the number are derived per-locale by Intl on the
-- client, which gets placement right for currencies the app has never been
-- explicitly taught (e.g. "1.234 €" vs "€1,234").
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  currency_code TEXT NOT NULL DEFAULT 'PHP',
  language TEXT NOT NULL DEFAULT 'en',
  -- How long an open opportunity may sit in one stage before it is called
  -- stale. Configurable because it is a sales-cycle judgement, not a constant:
  -- a 30-day rule that fits fast-moving supply quotes would flag every
  -- long-lead engineering bid as a failure.
  stale_deal_days INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Admin-defined sidebar ordering. One row per menu link (item_key is the
-- link's route, e.g. "/inventory"); position orders it within its own
-- section. Links with no row here fall back to their built-in order, so a
-- newly shipped menu item still shows up instead of disappearing.
-- id is present (rather than item_key being the primary key) because the
-- prepare() shim above appends "RETURNING id" to any plain INSERT — every
-- table here is expected to have one, and omitting it makes inserts fail.
CREATE TABLE IF NOT EXISTS nav_menu_order (
  id SERIAL PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- Company logo shown on the login screen and sidebar header. logo_data is a
-- base64 data URL (client-compressed to PNG before upload, image.js) or NULL
-- to fall back to the default "M" mark — same storage pattern as attendance
-- clock-in photos and expense receipts elsewhere in this schema.
CREATE TABLE IF NOT EXISTS branding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logo_data TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Idle-session auto-logout: the frontend (useIdleLogout hook) signs a user
-- out client-side after this many minutes of no mouse/keyboard/touch
-- activity, as a data-security measure against a workstation left signed in
-- and unattended. Editable only by admins at Administration > Security.
CREATE TABLE IF NOT EXISTS security_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 15,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Inputs to the automatic payroll calculation (base pay proration + overtime),
-- kept editable rather than hardcoded since neither figure is safe to assume
-- for every company.
CREATE TABLE IF NOT EXISTS payroll_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  standard_hours_per_day NUMERIC(14,3) NOT NULL DEFAULT 8,
  overtime_multiplier NUMERIC(14,3) NOT NULL DEFAULT 1.25,
  regular_start_time TEXT NOT NULL DEFAULT '08:00',
  regular_end_time TEXT NOT NULL DEFAULT '17:00',
  overtime_start_time TEXT NOT NULL DEFAULT '17:00',
  overtime_end_time TEXT NOT NULL DEFAULT '22:00',
  night_shift_multiplier NUMERIC(14,3) NOT NULL DEFAULT 1.10,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- Single editable row holding the post-login Terms and Conditions / Data
-- Privacy / Cybersecurity notice shown by TermsGate. version is bumped on
-- every save (see PUT /api/terms) so editing the text automatically makes
-- every user — even ones who already accepted an earlier version — see and
-- re-accept the notice on their next login.
CREATE TABLE IF NOT EXISTS terms_content (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  version TEXT NOT NULL,
  -- Short footer notice shown on the (pre-login, unauthenticated) sign-in
  -- screen — editable separately from the content column above since it
  -- isn't a consent document, just a pointer to one, so changing it doesn't
  -- need to force every user to re-accept anything.
  login_notice TEXT NOT NULL DEFAULT 'Use of this application is subject to MARCA Group''s Terms and Conditions.',
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_deal_id ON orders(deal_id) WHERE deal_id IS NOT NULL;

-- Audit trail: who did what, when. user_email is denormalized (kept even if the
-- user row is later deleted) so log rows stay readable forever, which a hard FK
-- alone can't guarantee — ON DELETE SET NULL only protects the row from being
-- deleted, not from losing its human-readable identity.
CREATE TABLE IF NOT EXISTS employee_assets (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  asset_tag TEXT,
  date_issued TEXT NOT NULL,
  date_returned TEXT,
  -- 'replaced' is kept distinct from 'returned' on purpose: both mean the item
  -- is no longer with the employee, but only one of them means a replacement
  -- was issued, and the difference matters when auditing what a leaver still
  -- holds versus what was swapped out mid-employment.
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','returned','replaced')),
  condition_note TEXT,
  notes TEXT,
  market_value NUMERIC(14,2),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_employee_assets_employee ON employee_assets(employee_id);

CREATE TABLE IF NOT EXISTS asset_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  needed_by TEXT,
  -- 'approved' and 'issued' are separate steps: approval is the decision, and
  -- issuance is the moment the item actually changes hands and joins the
  -- register. Collapsing them would let an approved-but-unfulfilled request
  -- read as though the employee already had the kit.
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','issued')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  asset_id INTEGER REFERENCES employee_assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_asset_requests_employee ON asset_requests(employee_id);

CREATE TABLE IF NOT EXISTS business_reviews (
  id SERIAL PRIMARY KEY,
  period_type TEXT NOT NULL CHECK(period_type IN ('monthly','quarterly','yearly')),
  period_year INTEGER NOT NULL,
  period_index INTEGER NOT NULL,
  period_label TEXT NOT NULL,
  -- The figures the narrative was written from, kept verbatim. A review read
  -- six months later must be checkable against what was true when it was
  -- written, not against what the database says today.
  fact_sheet TEXT NOT NULL,
  narrative TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  -- Why the written half is missing, when it is: no API key, a refusal, or an
  -- error. The figures are still worth keeping either way.
  narrative_error TEXT,
  generated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(period_type, period_year, period_index)
);

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
  // Each type carries its own yearly allocation rather than a shared 5.
  // Offset Leave gets none on purpose: it is earned by working overtime and
  // taken back later, so an annual grant would hand everybody free days they
  // never worked for. HR can still set a figure per employee under Leave
  // balances, and the amount is editable at Leave > types like any other.
  const requiredTypes = [
    ["Vacation Leave", 5],
    ["Paternity/Maternity Leave", 5],
    ["Sick Leave", 5],
    ["Emergency Leave", 5],
    ["No Pay Leave", 5],
    ["Offset Leave", 0],
  ];
  for (const [name, days] of requiredTypes) {
    await pool.query(
      "INSERT INTO leave_types (name, default_days_per_year) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
      [name, days]
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

// Backfills each card's pre-existing single employee_id assignee into the new
// board_card_assignees join table, so cards created before multi-assignee
// support still show their original assignee. Safe to repeat: ON CONFLICT DO
// NOTHING means a card already backfilled (or since reassigned) is untouched.
// employee_assets shipped before assets carried a value. CREATE TABLE IF NOT
// EXISTS won't add a column to a table that already exists, so any deployment
// that already ran the register needs this explicitly.
async function ensureAssetMarketValue() {
  await pool.query("ALTER TABLE employee_assets ADD COLUMN IF NOT EXISTS market_value REAL");
}

// deals and app_settings both predate stale-deal tracking, and CREATE TABLE
// IF NOT EXISTS won't add a column to a table that already exists. Existing
// deals get their created_at as the stage date — the most honest available
// answer, since nothing recorded when they last moved.
async function ensureDealAging() {
  await pool.query("ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_changed_at TEXT");
  await pool.query("UPDATE deals SET stage_changed_at = created_at WHERE stage_changed_at IS NULL");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS stale_deal_days INTEGER NOT NULL DEFAULT 30");
}

// When the scheduled business review goes out. This lived in environment
// variables first, which meant changing the send time was a redeploy and only
// whoever holds the Render login could do it. It belongs to whoever runs the
// company, so it lives in the database behind an admin screen.
//
// send_on is 'month_end' or 'first_of_next'. Month-end delivers the review
// inside the month it covers, at the cost of missing whatever is recorded
// after the send hour on the final day; first_of_next captures the month
// whole but arrives a day later.
async function ensureReviewSchedule() {
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_enabled BOOLEAN NOT NULL DEFAULT true");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_send_on TEXT NOT NULL DEFAULT 'month_end'");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_send_hour INTEGER NOT NULL DEFAULT 20");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_monthly BOOLEAN NOT NULL DEFAULT true");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_quarterly BOOLEAN NOT NULL DEFAULT true");
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_yearly BOOLEAN NOT NULL DEFAULT true");
}

// Postgres REAL is 4-byte single precision — about seven significant digits.
// That is enough for 1,234.56 and not enough for 484,012.56, which it silently
// stores as 484,013. Every money column in the app was REAL, so any amount
// above ~99,999.99 quietly lost its centavos on save. It looked like a UI bug
// for a long time because the figure typed in was correct and only the stored
// one was wrong.
//
// Money moves to NUMERIC(14,2): exact decimal, no binary-float drift, and
// db.js already parses NUMERIC into a JS number so nothing downstream changes.
// Coordinates move to DOUBLE PRECISION, which is what they always needed.
// Quantities, day counts and multipliers get three decimals.
const MONEY_COLUMNS = [
  ["deals", "value"],
  ["employee_assets", "market_value"],
  ["employees", "base_salary"],
  ["employees", "deduction_sss"],
  ["employees", "deduction_hdmf"],
  ["employees", "deduction_philhealth"],
  ["employees", "deduction_taxes"],
  ["employees", "deduction_loans"],
  ["employees", "deduction_cash_advances"],
  ["expense_items", "amount"],
  ["expense_reports", "cash_advance_amount"],
  ["inventory_items", "unit_cost"],
  ["inventory_items", "unit_price"],
  ["invoices", "amount"],
  ["orders", "amount"],
  ["payroll_records", "base_salary"],
  ["payroll_records", "bonuses"],
  ["payroll_records", "overtime_pay"],
  ["payroll_records", "night_differential_pay"],
  ["payroll_records", "deductions"],
  ["payroll_records", "deduction_sss"],
  ["payroll_records", "deduction_hdmf"],
  ["payroll_records", "deduction_philhealth"],
  ["payroll_records", "deduction_taxes"],
  ["payroll_records", "deduction_loans"],
  ["payroll_records", "deduction_cash_advances"],
  ["payroll_records", "net_pay"],
  ["purchase_orders", "amount"],
  ["sales_targets", "target_amount"],
];

const COORDINATE_COLUMNS = [
  ["attendance", "clock_in_lat"],
  ["attendance", "clock_in_lng"],
  ["attendance", "clock_out_lat"],
  ["attendance", "clock_out_lng"],
  ["attendance", "clock_in_accuracy"],
  ["attendance", "clock_in_distance_m"],
  ["attendance", "clock_out_accuracy"],
  ["attendance", "clock_out_distance_m"],
  ["locations", "lat"],
  ["locations", "lng"],
];

const QUANTITY_COLUMNS = [
  ["inventory_items", "quantity_on_hand"],
  ["inventory_items", "reorder_level"],
  ["inventory_transactions", "quantity"],
  ["inventory_settings", "alarm_threshold_percent"],
  ["leave_balances", "allocated_days"],
  ["leave_balances", "used_days"],
  ["leave_requests", "days"],
  ["locations", "radius_meters"],
  ["payroll_settings", "standard_hours_per_day"],
  ["payroll_settings", "overtime_multiplier"],
  ["payroll_settings", "night_shift_multiplier"],
];

async function widenRealColumns() {
  const convert = async (table, column, type, roundTo) => {
    const existing = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    const row = existing.rows[0];
    // Absent on installs that predate the table, and already done on a second
    // boot — either way there is nothing to convert.
    if (!row || row.data_type !== "real") return false;
    // Rounded on the way across: casting a REAL straight to NUMERIC exposes the
    // binary-float noise underneath it (0.1 becomes 0.100000001490116).
    const using =
      roundTo === null
        ? `${column}::double precision`
        : `ROUND(${column}::numeric, ${roundTo})`;
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING ${using}`);
    return true;
  };

  let changed = 0;
  for (const [t, c] of MONEY_COLUMNS) changed += (await convert(t, c, "NUMERIC(14,2)", 2)) ? 1 : 0;
  for (const [t, c] of COORDINATE_COLUMNS) changed += (await convert(t, c, "DOUBLE PRECISION", null)) ? 1 : 0;
  for (const [t, c] of QUANTITY_COLUMNS) changed += (await convert(t, c, "NUMERIC(14,3)", 3)) ? 1 : 0;
  if (changed > 0) console.log(`Widened ${changed} column(s) off REAL so amounts keep their decimals`);
}

// purchase_orders predates the work-order link, and CREATE TABLE IF NOT EXISTS
// will not add a column to a table that already exists.
async function ensurePurchaseOrderWorkOrder() {
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_purchase_orders_work_order ON purchase_orders(work_order_id)");
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_at TEXT");

  // Orders, invoices and work orders have no approval step of their own, so
  // the pair that answers the same question is who raised it and who last
  // moved it — which in practice is whoever marked it delivered, paid or
  // completed. The current status names which of those it was.
  for (const table of ["orders", "invoices", "work_orders"]) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status_changed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status_changed_at TEXT`);
  }
}

async function ensureBoardCardAssignees() {
  await pool.query(
    `INSERT INTO board_card_assignees (card_id, employee_id)
     SELECT id, employee_id FROM board_cards WHERE employee_id IS NOT NULL
     ON CONFLICT (card_id, employee_id) DO NOTHING`
  );
}

// expense_reports predates the expense_type (Operating/Project) classification
// added alongside the Title/Purpose dropdown — existing deployed tables need
// this column added explicitly since CREATE TABLE IF NOT EXISTS is a no-op on
// a table that already exists. Existing rows are left with a NULL expense_type
// rather than backfilled, since there's no reliable way to infer which type an
// old free-text title belonged to.
async function ensureExpenseType() {
  await pool.query("ALTER TABLE expense_reports ADD COLUMN IF NOT EXISTS expense_type TEXT");
}

// Regular/overtime shift windows and the night shift differential multiplier
// predate this column set — existing deployed payroll_settings rows need
// these added explicitly with the same defaults the fresh-install schema
// uses, so payroll calculation has sane values immediately rather than NULLs.
async function ensurePayrollTimeSettings() {
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS regular_start_time TEXT NOT NULL DEFAULT '08:00'");
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS regular_end_time TEXT NOT NULL DEFAULT '17:00'");
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS overtime_start_time TEXT NOT NULL DEFAULT '17:00'");
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS overtime_end_time TEXT NOT NULL DEFAULT '22:00'");
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS night_shift_multiplier REAL NOT NULL DEFAULT 1.10");

  // How often people are paid, and so how much of the monthly base salary one
  // payroll period is worth. Semi-monthly (1st-15th and 16th-end) is the
  // default because that is what the period_half column already assumed.
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pay_frequency TEXT NOT NULL DEFAULT 'semi_monthly'");

  // How attendance feeds into base pay.
  //   'fixed'       - a salaried employee earns the whole period's salary, less
  //                   whatever absences are actually recorded against them.
  //   'worked_days' - pay only for days attendance shows they worked.
  // Default is fixed: the worked_days rule quietly pays everyone zero at any
  // company that does not use the attendance module, which is not a sensible
  // thing for payroll to do on its own.
  await pool.query("ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS attendance_basis TEXT NOT NULL DEFAULT 'fixed'");
}

async function ensurePayrollNightDifferential() {
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS night_differential_pay REAL NOT NULL DEFAULT 0");
}

// Deductions used to be one lump number; HR needs to see and edit it broken
// down into the actual statutory/voluntary categories below. `deductions`
// itself is kept as the stored total (sum of these six) rather than derived
// on every read, so existing reads (payroll table, Excel export) keep working
// unchanged.
async function ensurePayrollDeductionBreakdown() {
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_sss REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_hdmf REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_philhealth REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_taxes REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_loans REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS deduction_cash_advances REAL NOT NULL DEFAULT 0");
}

// Existing deployed accounts predate the mandatory post-login Terms and
// Conditions / Data Privacy / Cybersecurity acknowledgment — both columns
// come in NULL for them, which is exactly what should make every existing
// user see the acceptance gate once on their next login.
async function ensureUserTermsAcceptance() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TEXT");
}

// Standing per-employee deduction amounts (SSS, HDMF, PhilHealth, taxes,
// loans, cash advances). These typically don't change cut-off to cut-off, so
// each payroll record's deduction breakdown defaults to whatever is here
// instead of resetting to 0 every period; editing the breakdown on a payroll
// record (POST /payroll) writes the new amounts back here too, so the change
// carries forward into future cut-offs until HR/admin edits it again.
// terms_content predates the login-screen notice field — existing deployed
// rows need it added explicitly, same default the fresh-install schema uses.
async function ensureLoginNotice() {
  await pool.query(
    "ALTER TABLE terms_content ADD COLUMN IF NOT EXISTS login_notice TEXT NOT NULL DEFAULT 'Use of this application is subject to MARCA Group''s Terms and Conditions.'"
  );
}

async function ensureEmployeeStandingDeductions() {
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_sss REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_hdmf REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_philhealth REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_taxes REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_loans REAL NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS deduction_cash_advances REAL NOT NULL DEFAULT 0");

  // What the base_salary figure on an employee actually represents:
  //   'monthly'      - a whole month's pay (the default, and what every
  //                    existing row held, so no backfill is needed).
  //   'semi_monthly' - the amount paid each cut-off, i.e. half a month.
  // Separate from payroll_settings.pay_frequency, which is how often the
  // company runs payroll. One is how the number was written down, the other
  // is how often it is paid out, and they are not always the same.
  await pool.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_basis TEXT NOT NULL DEFAULT 'monthly'");

  // Who the money was actually paid to. Kept per expense item rather than per
  // report because a single liquidation routinely covers several suppliers,
  // and a TIN is only meaningful next to the specific purchase it belongs to.
  await pool.query("ALTER TABLE expense_items ADD COLUMN IF NOT EXISTS supplier_name TEXT");
  await pool.query("ALTER TABLE expense_items ADD COLUMN IF NOT EXISTS supplier_address TEXT");
  await pool.query("ALTER TABLE expense_items ADD COLUMN IF NOT EXISTS supplier_tin TEXT");

  // The company this installation belongs to. Kept in the database rather
  // than hardcoded so the same build can be deployed for a different
  // company without touching the source.
  await pool.query("ALTER TABLE branding_settings ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT 'MARCA GROUP'");

  // The timezone this installation operates in. Attendance decides what
  // "today" means from it, and every displayed timestamp is rendered in it,
  // so it has to be one setting rather than a constant repeated per file.
  // Defaults to Asia/Manila, which is what it was hardcoded to.
  await pool.query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Manila'");

  // Who else is bidding. Free text rather than a lookup table — a
  // competitor on one deal is usually a name someone heard in a meeting,
  // not an entity worth maintaining a record for.
  await pool.query("ALTER TABLE deals ADD COLUMN IF NOT EXISTS competitor TEXT");
}

// Seeded once on first boot only (ON CONFLICT DO NOTHING) — after that this
// row is entirely owned by admins via PUT /api/terms, so re-running migrate
// never overwrites edits. version matches what the login gate has always
// checked for, so this migration alone doesn't force existing users to
// re-accept; only an actual edit through the admin page does.
const DEFAULT_TERMS_CONTENT = `By continuing to use this application, you acknowledge and agree to the following terms governing your access to MARCA Group's Human Resources system.

1. Data Privacy
This system collects and processes personal information necessary for employment administration, including your name, contact details, employment records, attendance and time logs, GPS location at clock-in/out, photographs captured for attendance verification, performance records, and payroll and compensation data. This information is collected solely for legitimate HR, payroll, and business operations purposes, is accessible only to authorized personnel, and will not be shared with third parties except as required by law or company policy. You have the right to request access to, correction of, or clarification about your personal data held in this system.

2. Cybersecurity & Acceptable Use
You are responsible for keeping your login credentials confidential and must not share your account with anyone else. Any activity performed under your account is presumed to be yours. Attempting to access data, records, or accounts you are not authorized to view is strictly prohibited. All access and changes made within this system are logged for security and audit purposes. Suspected security incidents, unauthorized access, or lost/compromised credentials must be reported to HR or IT administration immediately.

3. Acknowledgment
Misuse of this system, including unauthorized data access, sharing of credentials, or circumvention of security controls, may result in disciplinary action up to and including termination, and may carry legal liability under applicable data privacy law. Use of this application is further subject to MARCA Group's Terms and Conditions.`;
const DEFAULT_TERMS_VERSION = "2026-08-11";

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
          "INSERT INTO security_settings (id, idle_timeout_minutes) VALUES (1, 15) ON CONFLICT (id) DO NOTHING"
        )
      )
      .then(() => pool.query("INSERT INTO branding_settings (id, logo_data) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING"))
      .then(() =>
        pool.query("INSERT INTO app_settings (id, currency_code, language) VALUES (1, 'PHP', 'en') ON CONFLICT (id) DO NOTHING")
      )
      .then(() =>
        pool.query("INSERT INTO terms_content (id, content, version) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING", [
          DEFAULT_TERMS_CONTENT,
          DEFAULT_TERMS_VERSION,
        ])
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
      .then(() => ensurePayrollPeriodHalf())
      .then(() => ensureBoardCardAssignees())
      .then(() => ensureAssetMarketValue())
      .then(() => ensureDealAging())
      .then(() => ensureReviewSchedule())
      .then(() => widenRealColumns())
      .then(() => ensurePurchaseOrderWorkOrder())
      .then(() => ensureExpenseType())
      .then(() => ensurePayrollTimeSettings())
      .then(() => ensurePayrollNightDifferential())
      .then(() => ensurePayrollDeductionBreakdown())
      .then(() => ensureEmployeeStandingDeductions())
      .then(() => ensureUserTermsAcceptance())
      .then(() => ensureLoginNotice());
  }
  return migrated;
};

module.exports = db;
