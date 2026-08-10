const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { action, user_id, from, to, q } = req.query;
    let sql = "SELECT * FROM audit_logs WHERE 1=1";
    const params = [];
    if (action) {
      sql += " AND action = ?";
      params.push(action);
    }
    if (user_id) {
      sql += " AND user_id = ?";
      params.push(user_id);
    }
    if (from) {
      sql += " AND created_at >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND created_at <= ?";
      params.push(`${to} 23:59:59`);
    }
    if (q) {
      sql += " AND (user_email ILIKE ? OR action ILIKE ? OR entity_type ILIKE ? OR details ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    params.push(limit);
    res.json(await db.prepare(sql).all(...params));
  })
);

// Distinct action names, for the filter dropdown — cheaper than shipping the
// full fixed list client-side and keeps it in sync as new event types appear.
router.get(
  "/actions",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const rows = await db.prepare("SELECT DISTINCT action FROM audit_logs ORDER BY action").all();
    res.json(rows.map((r) => r.action));
  })
);

module.exports = router;
