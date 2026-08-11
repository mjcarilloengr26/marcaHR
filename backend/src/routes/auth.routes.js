const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logEvent, logRequestEvent } = require("../services/auditLog");
const { activeGrantsForUser } = require("../services/pageAccess");

const router = express.Router();

// The current version lives in terms_content (edited via the admin-only
// Terms & Conditions settings page, PUT /api/terms) rather than a hardcoded
// constant, so an admin editing the notice is what forces every user —
// including ones who already accepted the previous text — to re-accept on
// their next login, with no code change or redeploy required.
async function currentTermsVersion() {
  const row = await db.prepare("SELECT version FROM terms_content WHERE id = 1").get();
  return row?.version;
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);
    const employee = user.employee_id
      ? await db
          .prepare(
            `SELECT e.*, d.name AS department_name FROM employees e
             LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
          )
          .get(user.employee_id)
      : null;
    const termsVersion = await currentTermsVersion();
    const pageGrants = await activeGrantsForUser(user.id);

    await logEvent({ userId: user.id, userEmail: user.email, action: "login", ip: req.ip });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        employee_id: user.employee_id,
        terms_accepted: user.terms_version === termsVersion,
        page_grants: pageGrants.map((g) => g.page_key),
      },
      employee,
    });
  })
);

// Blocking gate shown right after login until the user explicitly accepts —
// re-fires whenever the admin edits the notice, since acceptance is tied to
// the exact version string, not just "accepted at some point."
router.post(
  "/accept-terms",
  requireAuth,
  asyncHandler(async (req, res) => {
    const termsVersion = await currentTermsVersion();
    await db
      .prepare(
        `UPDATE users SET terms_version = ?, terms_accepted_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`
      )
      .run(termsVersion, req.user.id);
    await logRequestEvent(req, "accept_terms", { entityType: "user", entityId: req.user.id, details: { terms_version: termsVersion } });
    res.json({ terms_accepted: true });
  })
);

// JWTs are stateless — there's no session to invalidate server-side — so this
// endpoint exists purely to record the logout event before the frontend
// discards its token.
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await logRequestEvent(req, "logout");
    res.status(204).end();
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await db.prepare("SELECT id, email, role, employee_id, terms_version FROM users WHERE id = ?").get(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const employee = user.employee_id
      ? await db
          .prepare(
            `SELECT e.*, d.name AS department_name FROM employees e
             LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
          )
          .get(user.employee_id)
      : null;
    const termsVersion = await currentTermsVersion();
    const pageGrants = await activeGrantsForUser(user.id);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        employee_id: user.employee_id,
        terms_accepted: user.terms_version === termsVersion,
        page_grants: pageGrants.map((g) => g.page_key),
      },
      employee,
    });
  })
);

module.exports = router;
