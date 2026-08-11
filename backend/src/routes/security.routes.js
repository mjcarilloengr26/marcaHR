const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

// Readable by any signed-in role — every session needs this value to run its
// own idle-logout timer (frontend/src/hooks/useIdleLogout.js), not just admins.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT idle_timeout_minutes, updated_at FROM security_settings WHERE id = 1").get();
    res.json(row);
  })
);

router.put(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const minutes = Number(req.body?.idle_timeout_minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
      return res.status(400).json({ error: "idle_timeout_minutes must be a whole number between 1 and 480" });
    }
    await db
      .prepare(
        `UPDATE security_settings SET idle_timeout_minutes = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), updated_by = ? WHERE id = 1`
      )
      .run(minutes, req.user.id);
    await logRequestEvent(req, "update_security_settings", { entityType: "security_settings", details: { idle_timeout_minutes: minutes } });
    const row = await db.prepare("SELECT idle_timeout_minutes, updated_at FROM security_settings WHERE id = 1").get();
    res.json(row);
  })
);

module.exports = router;
