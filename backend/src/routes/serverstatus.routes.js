const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

const startedAt = Date.now();

// Admin-only view of whether the API and its database are actually healthy.
// Deliberately read-only: the free plan's cold starts are the thing this is
// really for, and knowing the API is awake is what an admin needs before
// telling staff to sign in.
router.get(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    // Timed separately from the request so a slow database is distinguishable
    // from a slow network hop to the API.
    const dbStart = Date.now();
    let database = { ok: false, latency_ms: null, error: null };
    try {
      await db.prepare("SELECT 1 AS ok").get();
      database = { ok: true, latency_ms: Date.now() - dbStart, error: null };
    } catch (err) {
      database = { ok: false, latency_ms: Date.now() - dbStart, error: err.message };
    }

    res.json({
      ok: database.ok,
      server: {
        // Seconds since this process booted. A value near zero means the
        // instance has just cold-started rather than having been up all along.
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        node_version: process.version,
        environment: process.env.NODE_ENV || "development",
        keep_warm_enabled: Boolean(process.env.KEEP_WARM_URL),
        server_time: new Date().toISOString(),
      },
      database,
    });
  })
);

module.exports = router;
