const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");

const router = express.Router();

// Distance in meters between two lat/lng points (haversine).
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// The geofence target for an employee: their assigned location (locations table)
// takes priority; falls back to a single global office via OFFICE_LAT/OFFICE_LNG
// env vars when the employee has no assigned location. Null means "no geofence" —
// location is then purely informational, not enforced.
function resolveTargetLocation(employeeId) {
  const assigned = db
    .prepare(
      `SELECT l.name, l.lat, l.lng, l.radius_meters AS radius
       FROM employees e JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`
    )
    .get(employeeId);
  if (assigned) return assigned;

  const lat = Number(process.env.OFFICE_LAT);
  const lng = Number(process.env.OFFICE_LNG);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = Number(process.env.OFFICE_RADIUS_METERS);
  return { name: "the office", lat, lng, radius: Number.isFinite(radius) && radius > 0 ? radius : 1000 };
}

// Returns {lat, lng, accuracy, distance_m} from the request body, or nulls when
// the client couldn't provide a location. distance_m is only computed when a
// target location (assigned or global) is configured for this employee.
function parseLocation(body, employeeId) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: null, lng: null, accuracy: null, distance_m: null };
  }
  const accuracy = Number.isFinite(Number(body?.accuracy)) ? Number(body.accuracy) : null;
  const target = resolveTargetLocation(employeeId);
  const distance_m = target ? distanceMeters(lat, lng, target.lat, target.lng) : null;
  return { lat, lng, accuracy, distance_m };
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Enforces the geofence for a self clock-in/out. Only active when the employee has
// an assigned location or a global office is configured — otherwise there's
// nothing to check against, so location stays optional/informational.
function checkGeofence(loc, employeeId) {
  const target = resolveTargetLocation(employeeId);
  if (!target) return null;
  if (loc.lat === null) {
    return "Location is required to clock in/out. Please allow location access and try again.";
  }
  if (loc.distance_m > target.radius) {
    return `You're ${formatDistance(loc.distance_m)} from ${target.name} — you must be within ${formatDistance(target.radius)} to clock in/out.`;
  }
  return null;
}

router.get("/", requireAuth, (req, res) => {
  let sql = `SELECT a.*, (e.first_name || ' ' || e.last_name) AS employee_name
             FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE 1=1`;
  const params = [];

  if (req.user.role === "employee") {
    sql += " AND a.employee_id = ?";
    params.push(req.user.employee_id);
  } else if (req.query.employee_id) {
    sql += " AND a.employee_id = ?";
    params.push(req.query.employee_id);
  }

  if (req.query.date) {
    sql += " AND a.date = ?";
    params.push(req.query.date);
  } else if (req.query.from && req.query.to) {
    sql += " AND a.date BETWEEN ? AND ?";
    params.push(req.query.from, req.query.to);
  }

  sql += " ORDER BY a.date DESC";
  res.json(db.prepare(sql).all(...params));
});

// Employee self clock-in/out for today
router.post("/clock-in", requireAuth, (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(11, 19);
  const loc = parseLocation(req.body, req.user.employee_id);
  const geofenceError = checkGeofence(loc, req.user.employee_id);
  if (geofenceError) return res.status(403).json({ error: geofenceError });
  db.prepare(
    `INSERT INTO attendance (employee_id, date, status, clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance_m)
     VALUES (?, ?, 'present', ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET
       clock_in = excluded.clock_in, status = 'present',
       clock_in_lat = excluded.clock_in_lat, clock_in_lng = excluded.clock_in_lng,
       clock_in_accuracy = excluded.clock_in_accuracy, clock_in_distance_m = excluded.clock_in_distance_m`
  ).run(req.user.employee_id, today, now, loc.lat, loc.lng, loc.accuracy, loc.distance_m);
  res.json(db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today));
});

router.post("/clock-out", requireAuth, (req, res) => {
  if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(11, 19);
  const record = db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today);
  if (!record) return res.status(400).json({ error: "You have not clocked in today" });
  const loc = parseLocation(req.body, req.user.employee_id);
  const geofenceError = checkGeofence(loc, req.user.employee_id);
  if (geofenceError) return res.status(403).json({ error: geofenceError });
  db.prepare(
    `UPDATE attendance SET clock_out = ?, clock_out_lat = ?, clock_out_lng = ?,
     clock_out_accuracy = ?, clock_out_distance_m = ? WHERE id = ?`
  ).run(now, loc.lat, loc.lng, loc.accuracy, loc.distance_m, record.id);
  res.json(db.prepare("SELECT * FROM attendance WHERE id = ?").get(record.id));
});

// HR/admin manually record or edit attendance for anyone
router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { employee_id, date, status, clock_in, clock_out, note } = req.body || {};
  if (!employee_id || !date) return res.status(400).json({ error: "employee_id and date are required" });
  db.prepare(
    `INSERT INTO attendance (employee_id, date, status, clock_in, clock_out, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET
       status = excluded.status, clock_in = excluded.clock_in,
       clock_out = excluded.clock_out, note = excluded.note`
  ).run(employee_id, date, status || "present", clock_in || null, clock_out || null, note || null);
  res.status(201).json(db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(employee_id, date));
});

router.get(
  "/summary/:employeeId",
  requireAuth,
  requireSelfOrRole((req) => req.params.employeeId, "admin", "hr"),
  (req, res) => {
  const { from, to } = req.query;
  const params = [req.params.employeeId];
  let sql = `SELECT status, COUNT(*) AS count FROM attendance WHERE employee_id = ?`;
  if (from && to) {
    sql += " AND date BETWEEN ? AND ?";
    params.push(from, to);
  }
  sql += " GROUP BY status";
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
