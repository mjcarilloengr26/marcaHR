const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { appTimezone } = require("../services/timezone");

const router = express.Router();

// The server's system clock (UTC on Render) isn't the employees' clock —
// attendance date/time must be anchored to the company's own timezone,
// whatever zone the process happens to run in, or a clock-in near midnight
// gets filed under the wrong calendar date. That zone is a setting now
// (Administration > Localization), defaulting to Asia/Manila as before.
async function localToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: await appTimezone() }); // YYYY-MM-DD
}
async function localNow() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: await appTimezone(), hour12: false }); // HH:MM:SS
}
// Calendar arithmetic on an already-resolved Manila date string, not a second
// timezone conversion — avoids DST/offset edge cases from subtracting days off
// a raw `new Date()` in a different zone.
async function localDaysAgo(days) {
  const [y, m, d] = (await localToday()).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

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
// takes priority. If the system already has real Locations set up, an employee
// with none assigned simply hasn't been onboarded yet — clock-in stays
// unenforced (not silently checked against some other office) until HR
// assigns them one, otherwise a brand-new hire can be blocked by a geofence
// that has nothing to do with where they actually work.
// Only falls back to the single global OFFICE_LAT/OFFICE_LNG office when the
// system has no Locations configured at all (legacy single-office mode).
// Null means "no geofence" — location is then purely informational.
async function resolveTargetLocation(employeeId) {
  const assigned = await db
    .prepare(
      `SELECT l.name, l.lat, l.lng, l.radius_meters AS radius
       FROM employees e JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`
    )
    .get(employeeId);
  if (assigned) return assigned;

  const anyLocationsExist = await db.prepare("SELECT 1 FROM locations LIMIT 1").get();
  if (anyLocationsExist) return null;

  const lat = Number(process.env.OFFICE_LAT);
  const lng = Number(process.env.OFFICE_LNG);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = Number(process.env.OFFICE_RADIUS_METERS);
  return { name: "the office", lat, lng, radius: Number.isFinite(radius) && radius > 0 ? radius : 1000 };
}

// Returns {lat, lng, accuracy, distance_m} from the request body, or nulls when
// the client couldn't provide a location. distance_m is only computed when a
// target location (assigned or global) is configured for this employee.
async function parseLocation(body, employeeId) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: null, lng: null, accuracy: null, distance_m: null };
  }
  const accuracy = Number.isFinite(Number(body?.accuracy)) ? Number(body.accuracy) : null;
  const target = await resolveTargetLocation(employeeId);
  const distance_m = target ? distanceMeters(lat, lng, target.lat, target.lng) : null;
  return { lat, lng, accuracy, distance_m };
}

// Accepts a base64 data URL (image compressed client-side) or null. Caps the
// stored size defensively even though express.json()'s limit already bounds
// the whole request — a single field shouldn't be allowed to approach that cap.
function parsePhoto(body) {
  const photo = body?.photo;
  if (!photo) return null;
  if (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 6_000_000) {
    return null;
  }
  return photo;
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Facial verification is opt-in and toggleable at runtime (not a build-time
// flag) so it can be switched off while testing without a redeploy.
router.get(
  "/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT face_recognition_enabled FROM attendance_settings WHERE id = 1").get();
    res.json({ face_recognition_enabled: Boolean(row?.face_recognition_enabled) });
  })
);

router.put(
  "/settings",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const enabled = Boolean(req.body?.face_recognition_enabled);
    await db.prepare("UPDATE attendance_settings SET face_recognition_enabled = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = 1").run(
      enabled ? 1 : 0
    );
    res.json({ face_recognition_enabled: enabled });
  })
);

// Enforces the geofence for a self clock-in/out. Only active when the employee has
// an assigned location or a global office is configured — otherwise there's
// nothing to check against, so location stays optional/informational.
async function checkGeofence(loc, employeeId) {
  const target = await resolveTargetLocation(employeeId);
  if (!target) return null;
  if (loc.lat === null) {
    return "Location is required to clock in/out. Please allow location access and try again.";
  }
  if (loc.distance_m > target.radius) {
    return `You're ${formatDistance(loc.distance_m)} from ${target.name} — you must be within ${formatDistance(target.radius)} to clock in/out.`;
  }
  return null;
}

// Photo blobs (base64) are deliberately excluded from the list — they're the
// overwhelming majority of this endpoint's payload (measured ~943KB of a
// ~972KB response for just 72 records) and the list view only ever needs a
// thumbnail-or-not signal, not the bytes themselves. has_clock_in_photo /
// has_clock_out_photo let the UI show a "view photo" affordance that fetches
// the actual image lazily, only for the one record someone actually opens,
// via GET /:id/photo below.
const LIST_COLUMNS = `a.id, a.employee_id, a.date, a.status,
  a.clock_in, a.clock_in_lat, a.clock_in_lng, a.clock_in_accuracy, a.clock_in_distance_m,
  a.clock_out, a.clock_out_lat, a.clock_out_lng, a.clock_out_accuracy, a.clock_out_distance_m,
  a.note, (a.clock_in_photo IS NOT NULL) AS has_clock_in_photo, (a.clock_out_photo IS NOT NULL) AS has_clock_out_photo`;

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `SELECT ${LIST_COLUMNS}, (e.first_name || ' ' || e.last_name) AS employee_name
             FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE 1=1`;
    const params = [];

    let employeeIdFilter = null;
    if (req.user.role === "employee") {
      employeeIdFilter = req.user.employee_id;
    } else if (req.query.employee_id) {
      employeeIdFilter = req.query.employee_id;
    }
    if (employeeIdFilter) {
      sql += " AND a.employee_id = ?";
      params.push(employeeIdFilter);
    }

    const today = (await localToday());
    // A newly-added employee has no attendance row until they clock in (or HR
    // records one), so the records-only query above would silently omit them —
    // only surface that gap for "today", since backfilling absent placeholders
    // across all of history would misrepresent days before the employee existed.
    let includeTodayPlaceholders = false;

    if (req.query.date) {
      sql += " AND a.date = ?";
      params.push(req.query.date);
      if (req.query.date === today) includeTodayPlaceholders = true;
    } else if (req.query.from && req.query.to) {
      sql += " AND a.date BETWEEN ? AND ?";
      params.push(req.query.from, req.query.to);
      if (req.query.from <= today && today <= req.query.to) includeTodayPlaceholders = true;
    } else {
      // No filter given at all: default to a bounded recent window rather than
      // the entire all-time history — callers who genuinely want older records
      // can still pass an explicit date or from/to range.
      sql += " AND a.date BETWEEN ? AND ?";
      params.push(await localDaysAgo(30), today);
      includeTodayPlaceholders = true;
    }

    sql += " ORDER BY a.date DESC";
    const records = await db.prepare(sql).all(...params);

    if (includeTodayPlaceholders) {
      // Someone on approved leave has no attendance row either, and calling
      // that "absent" is wrong — they are away with permission, and on the
      // Attendance page it reads as though they failed to show up. Pull the
      // covering leave, if any, so the placeholder can say what it actually is.
      let placeholderSql = `SELECT e.id AS employee_id, (e.first_name || ' ' || e.last_name) AS employee_name,
                                  lt.name AS leave_type_name
                           FROM employees e
                           LEFT JOIN leave_requests lr
                             ON lr.employee_id = e.id
                            AND lr.status = 'approved'
                            AND ? BETWEEN lr.start_date AND lr.end_date
                           LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
                           WHERE e.status = 'active'
                             AND (e.hire_date IS NULL OR e.hire_date <= ?)
                             AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.date = ?)`;
      const placeholderParams = [today, today, today];
      if (employeeIdFilter) {
        placeholderSql += " AND e.id = ?";
        placeholderParams.push(employeeIdFilter);
      }
      const missing = await db.prepare(placeholderSql).all(...placeholderParams);
      for (const m of missing) {
        records.unshift({
          id: `placeholder-${m.employee_id}-${today}`,
          employee_id: m.employee_id,
          employee_name: m.employee_name,
          date: today,
          status: m.leave_type_name ? "leave" : "absent",
          leave_type_name: m.leave_type_name || null,
          clock_in: null,
          clock_in_lat: null,
          clock_in_lng: null,
          clock_in_accuracy: null,
          clock_in_distance_m: null,
          clock_out: null,
          clock_out_lat: null,
          clock_out_lng: null,
          clock_out_accuracy: null,
          clock_out_distance_m: null,
          has_clock_in_photo: false,
          has_clock_out_photo: false,
          note: m.leave_type_name ? `On ${m.leave_type_name}` : null,
        });
      }
    }

    res.json(records);
  })
);

// Fetches a single record's actual photo bytes on demand — the list endpoint
// above only ever sends a has_photo boolean, so the UI calls this the moment
// someone actually opens a specific record's photo, not on every list load.
router.get(
  "/:id/photo",
  requireAuth,
  asyncHandler(async (req, res) => {
    const record = await db.prepare("SELECT employee_id, clock_in_photo, clock_out_photo FROM attendance WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ error: "Attendance record not found" });
    const isSelf = req.user.employee_id === record.employee_id;
    const isHr = ["admin", "hr"].includes(req.user.role);
    if (!isSelf && !isHr) return res.status(403).json({ error: "Insufficient permissions" });
    res.json({ clock_in_photo: record.clock_in_photo, clock_out_photo: record.clock_out_photo });
  })
);

// Employee self clock-in/out for today
router.post(
  "/clock-in",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
    const today = (await localToday());
    const now = (await localNow());
    const loc = await parseLocation(req.body, req.user.employee_id);
    const geofenceError = await checkGeofence(loc, req.user.employee_id);
    if (geofenceError) return res.status(403).json({ error: geofenceError });
    const photo = parsePhoto(req.body);
    await db
      .prepare(
        `INSERT INTO attendance (employee_id, date, status, clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance_m, clock_in_photo)
     VALUES (?, ?, 'present', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET
       clock_in = excluded.clock_in, status = 'present',
       clock_in_lat = excluded.clock_in_lat, clock_in_lng = excluded.clock_in_lng,
       clock_in_accuracy = excluded.clock_in_accuracy, clock_in_distance_m = excluded.clock_in_distance_m,
       clock_in_photo = excluded.clock_in_photo`
      )
      .run(req.user.employee_id, today, now, loc.lat, loc.lng, loc.accuracy, loc.distance_m, photo);
    res.json(await db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today));
  })
);

router.post(
  "/clock-out",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.employee_id) return res.status(400).json({ error: "No employee profile linked to this user" });
    const today = (await localToday());
    const now = (await localNow());
    const record = await db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(req.user.employee_id, today);
    if (!record) return res.status(400).json({ error: "You have not clocked in today" });
    const loc = await parseLocation(req.body, req.user.employee_id);
    const geofenceError = await checkGeofence(loc, req.user.employee_id);
    if (geofenceError) return res.status(403).json({ error: geofenceError });
    const photo = parsePhoto(req.body);
    await db
      .prepare(
        `UPDATE attendance SET clock_out = ?, clock_out_lat = ?, clock_out_lng = ?,
     clock_out_accuracy = ?, clock_out_distance_m = ?, clock_out_photo = ? WHERE id = ?`
      )
      .run(now, loc.lat, loc.lng, loc.accuracy, loc.distance_m, photo, record.id);
    res.json(await db.prepare("SELECT * FROM attendance WHERE id = ?").get(record.id));
  })
);

// HR/admin manually record or edit attendance for anyone
router.post(
  "/",
  requireAuth,
  requireRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { employee_id, date, status, clock_in, clock_out, note } = req.body || {};
    if (!employee_id || !date) return res.status(400).json({ error: "employee_id and date are required" });
    await db
      .prepare(
        `INSERT INTO attendance (employee_id, date, status, clock_in, clock_out, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, date) DO UPDATE SET
       status = excluded.status, clock_in = excluded.clock_in,
       clock_out = excluded.clock_out, note = excluded.note`
      )
      .run(employee_id, date, status || "present", clock_in || null, clock_out || null, note || null);
    res.status(201).json(await db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?").get(employee_id, date));
  })
);

router.get(
  "/summary/:employeeId",
  requireAuth,
  requireSelfOrRole((req) => req.params.employeeId, "admin", "hr"),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const params = [req.params.employeeId];
    let sql = `SELECT status, COUNT(*) AS count FROM attendance WHERE employee_id = ?`;
    if (from && to) {
      sql += " AND date BETWEEN ? AND ?";
      params.push(from, to);
    }
    sql += " GROUP BY status";
    res.json(await db.prepare(sql).all(...params));
  })
);

module.exports = router;
