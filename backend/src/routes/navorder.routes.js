const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");

const router = express.Router();

// Readable by any signed-in role — everyone's sidebar needs the order, not
// just the admins who can change it.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT item_key, position FROM nav_menu_order ORDER BY position").all());
  })
);

// Replaces the whole ordering in one transaction. The frontend always sends
// the complete list, so a stale row can't survive and leave a link stranded
// at an old position.
router.put(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items must be an array of { item_key, position }" });
    }
    for (const it of items) {
      if (!it || typeof it.item_key !== "string" || !it.item_key || !Number.isInteger(it.position)) {
        return res.status(400).json({ error: "Each item needs an item_key string and an integer position" });
      }
    }

    const replaceAll = db.transaction(async (rows) => {
      await db.prepare("DELETE FROM nav_menu_order").run();
      const insert = db.prepare("INSERT INTO nav_menu_order (item_key, position) VALUES (?, ?)");
      for (const r of rows) await insert.run(r.item_key, r.position);
    });
    await replaceAll(items);

    await logRequestEvent(req, "update_menu_order", {
      entityType: "nav_menu_order",
      details: { item_count: items.length },
    });
    res.json(await db.prepare("SELECT item_key, position FROM nav_menu_order ORDER BY position").all());
  })
);

module.exports = router;
