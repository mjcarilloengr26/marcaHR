const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const locations = await db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM employees e WHERE e.location_id = l.id) AS employee_count
         FROM locations l ORDER BY l.name`
      )
      .all();
    res.json(locations.map((l) => ({ ...l, employee_count: Number(l.employee_count) })));
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { name, lat, lng, radius_meters, address } = req.body || {};
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!name || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ error: "name, lat and lng are required" });
    }
    try {
      const info = await db
        .prepare("INSERT INTO locations (name, lat, lng, radius_meters, address) VALUES (?, ?, ?, ?, ?)")
        .run(name, latNum, lngNum, radius_meters ? Number(radius_meters) : 1000, address || null);
      res.status(201).json(await db.prepare("SELECT * FROM locations WHERE id = ?").get(info.lastInsertRowid));
    } catch (err) {
      res.status(400).json({ error: "A location with that name already exists" });
    }
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Location not found" });
    const { name, lat, lng, radius_meters, address } = req.body || {};
    await db.prepare("UPDATE locations SET name = ?, lat = ?, lng = ?, radius_meters = ?, address = ? WHERE id = ?").run(
      name ?? existing.name,
      lat !== undefined ? Number(lat) : existing.lat,
      lng !== undefined ? Number(lng) : existing.lng,
      radius_meters !== undefined ? Number(radius_meters) : existing.radius_meters,
      address !== undefined ? address : existing.address,
      req.params.id
    );
    res.json(await db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id));
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const existing = await db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Location not found" });
    await db.prepare("DELETE FROM locations WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
