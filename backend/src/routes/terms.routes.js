const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

// Public and unauthenticated — the sign-in screen shows this before anyone
// has a token yet.
router.get(
  "/login-notice",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT login_notice FROM terms_content WHERE id = 1").get();
    res.json(row);
  })
);

router.put(
  "/login-notice",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { login_notice } = req.body || {};
    if (!login_notice || !login_notice.trim()) {
      return res.status(400).json({ error: "login_notice is required" });
    }
    await db
      .prepare(
        `UPDATE terms_content SET login_notice = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(login_notice, req.user.id);
    await logRequestEvent(req, "update_login_notice", { entityType: "terms_content" });
    const row = await db.prepare("SELECT login_notice FROM terms_content WHERE id = 1").get();
    res.json(row);
  })
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT content, version, updated_at FROM terms_content WHERE id = 1").get();
    res.json(row);
  })
);

// Saving always mints a new version (a timestamp, so it's guaranteed unique
// and sortable) rather than letting the admin type one in — this is what
// makes every user, including ones who already accepted the previous text,
// see and re-accept the notice on their next login (see auth.routes.js).
router.put(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { content } = req.body || {};
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content is required" });
    }
    const version = new Date().toISOString();
    await db
      .prepare(
        `UPDATE terms_content SET content = ?, version = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(content, version, req.user.id);
    await logRequestEvent(req, "update_terms", { entityType: "terms_content", details: { version } });
    const row = await db.prepare("SELECT content, version, updated_at FROM terms_content WHERE id = 1").get();
    res.json(row);
  })
);

module.exports = router;
