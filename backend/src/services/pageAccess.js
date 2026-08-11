const db = require("../db");

// The set of pages an admin can hand out temporary access to, and the API
// route prefix each one actually needs to function. requireRole consults this
// so a grant unlocks the real endpoints too — hiding a nav link alone would
// not be access control.
//
// Deliberately excluded: Users, Events, and the Administration settings pages
// (Terms, Security, Branding, Page Access). Temporary access to user
// management is a privilege-escalation path — a grantee could mint themselves
// a permanent admin account — so those stay admin-only, permanently.
const GRANTABLE_PAGES = [
  { key: "inventory", label: "Inventory", route: "/inventory", apiPrefix: "/api/inventory" },
  { key: "employees", label: "Employees", route: "/employees", apiPrefix: "/api/employees" },
  { key: "departments", label: "Departments", route: "/departments", apiPrefix: "/api/departments" },
  { key: "locations", label: "Locations", route: "/locations", apiPrefix: "/api/locations" },
  { key: "payroll", label: "Payroll", route: "/payroll", apiPrefix: "/api/payroll" },
  { key: "orders", label: "Orders", route: "/orders", apiPrefix: "/api/orders" },
  { key: "billing", label: "Billing", route: "/billing", apiPrefix: "/api/invoices" },
  { key: "purchase-orders", label: "Purchase Orders", route: "/purchase-orders", apiPrefix: "/api/purchase-orders" },
  { key: "work-orders", label: "Work Orders", route: "/work-orders", apiPrefix: "/api/work-orders" },
  { key: "sales", label: "Sales Dashboard", route: "/sales", apiPrefix: "/api/sales" },
  { key: "deals", label: "Sales Opportunities", route: "/deals", apiPrefix: "/api/deals" },
  { key: "expenses", label: "Expenses", route: "/expenses", apiPrefix: "/api/expenses" },
  { key: "reports", label: "Export Reports", route: "/reports", apiPrefix: "/api/reports" },
];

const PAGE_BY_KEY = new Map(GRANTABLE_PAGES.map((p) => [p.key, p]));
const PAGE_KEY_BY_API_PREFIX = new Map(GRANTABLE_PAGES.map((p) => [p.apiPrefix, p.key]));

function isGrantablePageKey(key) {
  return PAGE_BY_KEY.has(key);
}

// Active = not revoked and not yet expired. Times are UTC strings in
// 'YYYY-MM-DD HH24:MI:SS' form, which compares correctly lexicographically.
async function activeGrantsForUser(userId) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT page_key, expires_at, role_label FROM page_access_grants
       WHERE user_id = ? AND revoked_at IS NULL
         AND expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
    )
    .all(userId);
}

// Does this user currently hold a grant covering the API route mounted at
// `apiPrefix` (i.e. req.baseUrl)? Returns false for anything not grantable.
async function hasActiveGrantForApiPrefix(userId, apiPrefix) {
  const pageKey = PAGE_KEY_BY_API_PREFIX.get(apiPrefix);
  if (!pageKey) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM page_access_grants
       WHERE user_id = ? AND page_key = ? AND revoked_at IS NULL
         AND expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
       LIMIT 1`
    )
    .get(userId, pageKey);
  return !!row;
}

module.exports = {
  GRANTABLE_PAGES,
  isGrantablePageKey,
  activeGrantsForUser,
  hasActiveGrantForApiPrefix,
};
