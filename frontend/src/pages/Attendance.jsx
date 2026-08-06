import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

// Wraps browser geolocation in a promise; resolves null if unavailable/denied/slow.
function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function formatDistance(m) {
  if (m === null || m === undefined) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function LocationCell({ lat, lng, distance }) {
  if (lat === null || lat === undefined) return <span>—</span>;
  const dist = formatDistance(distance);
  return (
    <a
      className="location-link"
      href={`https://www.google.com/maps?q=${lat},${lng}`}
      target="_blank"
      rel="noreferrer"
      title={`${lat.toFixed(5)}, ${lng.toFixed(5)}`}
    >
      📍{dist ? ` ${dist}` : " map"}
    </a>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [nameSort, setNameSort] = useState(null); // null = default order, "asc" | "desc"

  const load = () => api.get("/attendance").then(setRecords).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayRecord = records.find((r) => r.date === today && r.employee_id === user.employee_id);

  let displayed = records;
  if (isHr && search.trim()) {
    const q = search.trim().toLowerCase();
    displayed = displayed.filter((r) => (r.employee_name || "").toLowerCase().includes(q));
  }
  if (isHr && nameSort) {
    displayed = [...displayed].sort((a, b) => {
      const cmp = (a.employee_name || "").localeCompare(b.employee_name || "");
      return nameSort === "asc" ? cmp : -cmp;
    });
  }

  const toggleNameSort = () => setNameSort((prev) => (prev === "asc" ? "desc" : "asc"));

  const punch = async (endpoint) => {
    setBusy(true);
    setError("");
    try {
      const loc = await getPosition();
      if (!loc) {
        const proceed = confirm(
          "Couldn't get your location (GPS denied or unavailable). Continue without recording location?"
        );
        if (!proceed) return;
      }
      await api.post(`/attendance/${endpoint}`, loc || {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Attendance</h1>
          <p className="subtitle">
            {isHr ? "Team attendance records with clock-in/out locations" : "Clock in and out — your GPS location is recorded"}
          </p>
        </div>
        {!isHr && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => punch("clock-in")} disabled={busy || (todayRecord && todayRecord.clock_in)}>
              {busy ? "Working…" : "Clock in"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => punch("clock-out")}
              disabled={busy || !todayRecord || todayRecord.clock_out}
            >
              Clock out
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {isHr && (
        <div className="card form-inline" style={{ marginBottom: 16 }}>
          <div className="form-row">
            <label>Filter by employee</label>
            <input
              type="text"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-secondary" onClick={toggleNameSort}>
            Sort by name {nameSort === "asc" ? "▲" : nameSort === "desc" ? "▼" : ""}
          </button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <th>Employee</th>}
              <th>Date</th>
              <th>Status</th>
              <th>Clock in</th>
              <th>In location</th>
              <th>Clock out</th>
              <th>Out location</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.date}</td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>{r.clock_in || "—"}</td>
                <td><LocationCell lat={r.clock_in_lat} lng={r.clock_in_lng} distance={r.clock_in_distance_m} /></td>
                <td>{r.clock_out || "—"}</td>
                <td><LocationCell lat={r.clock_out_lat} lng={r.clock_out_lng} distance={r.clock_out_distance_m} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state">No attendance records yet.</div>}
        {records.length > 0 && displayed.length === 0 && <div className="empty-state">No employees match your search.</div>}
      </div>
    </div>
  );
}
