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

// Returns {lat, lng, accuracy, distance_m} from the request body, or nulls when
// the client couldn't provide a location. distance_m is only computed when
// OFFICE_LAT/OFFICE_LNG are configured.
function parseLocation(body) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: null, lng: null, accuracy: null, distance_m: null };
  }
  const accuracy = Number.isFinite(Number(body?.accuracy)) ? Number(body.accuracy) : null;
  const officeLat = Number(process.env.OFFICE_LAT);
  const officeLng = Number(process.env.OFFICE_LNG);
  const distance_m =
    Number.isFinite(officeLat) && Number.isFinite(officeLng)
      ? distanceMeters(lat, lng, officeLat, officeLng)
      : null;
  return { lat, lng, accuracy, distance_m };
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
  const loc = parseLocation(req.body);
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
  const loc = parseLocation(req.body);
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
