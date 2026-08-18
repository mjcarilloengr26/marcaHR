import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import { useAuth } from "../context/AuthContext";
import { compressImageFile } from "../utils/image";
import { compareFaces } from "../faceRecognition";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

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

// Must match the backend's date anchoring so "today" here is the same calendar
// day the server just recorded a clock-in against — otherwise the Clock in/out
// buttons could enable or disable on the wrong side of midnight for a device
// set to a different zone from the company's.
function todayIn(timezone) {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
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

// The list endpoint only ever sends a has-photo boolean (see backend), not
// the photo bytes — this fetches the actual image lazily, only when someone
// clicks to actually view it, instead of every row's photo loading upfront.
function PhotoCell({ recordId, hasPhoto, which, onOpen, onError }) {
  const [loading, setLoading] = useState(false);
  if (!hasPhoto) return <span>—</span>;

  const handleClick = async () => {
    setLoading(true);
    try {
      const data = await api.get(`/attendance/${recordId}/photo`);
      const src = which === "in" ? data.clock_in_photo : data.clock_out_photo;
      if (src) onOpen(src);
    } catch (err) {
      onError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      className="link-btn"
      onClick={handleClick}
      disabled={loading}
      title="View photo"
      style={{
        width: 32,
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border)",
        borderRadius: 4,
        background: "var(--surface)",
        cursor: loading ? "default" : "pointer",
      }}
    >
      {loading ? "…" : "📷"}
    </button>
  );
}

export default function Attendance() {
  const { timezone } = useAppSettings();
  const { user, employee } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [search, setSearch] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const [pendingPhotoName, setPendingPhotoName] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const [faceRecognitionEnabled, setFaceRecognitionEnabled] = useState(false);
  const [savingFaceSetting, setSavingFaceSetting] = useState(false);
  const fileInputRef = useRef(null);

  const load = () => api.get("/attendance").then(setRecords).catch((err) => setError(err.message));
  const loadSettings = () =>
    api.get("/attendance/settings").then((s) => setFaceRecognitionEnabled(s.face_recognition_enabled)).catch(() => {});

  useEffect(() => {
    load();
    loadSettings();
  }, []);

  const toggleFaceRecognition = async () => {
    setSavingFaceSetting(true);
    setError("");
    try {
      const updated = await api.put("/attendance/settings", { face_recognition_enabled: !faceRecognitionEnabled });
      setFaceRecognitionEnabled(updated.face_recognition_enabled);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingFaceSetting(false);
    }
  };

  const today = todayIn(timezone);
  const todayRecord = records.find((r) => r.date === today && r.employee_id === user.employee_id);

  let filtered = records;
  if (isHr && search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter((r) => (r.employee_name || "").toLowerCase().includes(q));
  }
  const { sorted: displayed, toggleSort, arrow } = useSort(filtered, "date", "desc");

  const handlePhotoPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const dataUrl = await compressImageFile(file);
      setPendingPhoto(dataUrl);
      setPendingPhotoName(file.name);
    } catch (err) {
      setError(err.message);
    }
  };

  const clearPendingPhoto = () => {
    setPendingPhoto(null);
    setPendingPhotoName("");
  };

  const punch = async (endpoint) => {
    setBusy(true);
    setBusyLabel("Working…");
    setError("");
    try {
      if (faceRecognitionEnabled) {
        if (!employee?.photo) {
          setError("Facial verification is on, but you have no profile photo on file yet — ask HR to add one before you can clock in/out.");
          return;
        }
        if (!pendingPhoto) {
          setError("Facial verification is on — attach a photo of yourself before clocking in/out.");
          return;
        }
        setBusyLabel("Verifying face…");
        const result = await compareFaces(employee.photo, pendingPhoto);
        if (!result.match) {
          setError(result.reason || "Your attached photo doesn't match your profile photo — clock-in/out denied.");
          return;
        }
      }

      setBusyLabel("Working…");
      const loc = await getPosition();
      if (!loc) {
        const proceed = confirm(
          "Couldn't get your location (GPS denied or unavailable). Continue without recording location?"
        );
        if (!proceed) return;
      }
      await api.post(`/attendance/${endpoint}`, { ...(loc || {}), photo: pendingPhoto || undefined });
      clearPendingPhoto();
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
            {isHr ? "Team attendance records with clock-in/out locations" : "Clock in and out — your GPS location is recorded"} (times in GMT+8, Philippine time)
          </p>
        </div>
        {!isHr && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="user"
              onChange={handlePhotoPick}
              style={{ display: "none" }}
            />
            {pendingPhoto ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <img
                  src={pendingPhoto}
                  alt="Attached proof"
                  style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }}
                />
                <span className="subtitle" style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pendingPhotoName}
                </span>
                <button type="button" className="btn btn-sm btn-secondary" onClick={clearPendingPhoto}>
                  ✕
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                📎 {faceRecognitionEnabled ? "Attach selfie (required)" : "Attach photo"}
              </button>
            )}
            <button className="btn" onClick={() => punch("clock-in")} disabled={busy || (todayRecord && todayRecord.clock_in)}>
              {busy ? busyLabel : "Clock in"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => punch("clock-out")}
              disabled={busy || !todayRecord || todayRecord.clock_out}
            >
              {busy ? busyLabel : "Clock out"}
            </button>
          </div>
        )}
        {isHr && (
          <button type="button" className="btn btn-secondary" onClick={toggleFaceRecognition} disabled={savingFaceSetting}>
            Facial recognition: {faceRecognitionEnabled ? "ON" : "OFF"}
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!isHr && faceRecognitionEnabled && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--warning)", color: "var(--warning)" }}>
          🔒 Facial verification is on — your attached photo must match your profile photo to clock in/out.
        </div>
      )}

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
        </div>
      )}

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Date" sortKey="date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th>Clock in</th>
              <th>In location</th>
              <th>In photo</th>
              <th>Clock out</th>
              <th>Out location</th>
              <th>Out photo</th>
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
                <td><PhotoCell recordId={r.id} hasPhoto={r.has_clock_in_photo} which="in" onOpen={setLightbox} onError={setError} /></td>
                <td>{r.clock_out || "—"}</td>
                <td><LocationCell lat={r.clock_out_lat} lng={r.clock_out_lng} distance={r.clock_out_distance_m} /></td>
                <td><PhotoCell recordId={r.id} hasPhoto={r.has_clock_out_photo} which="out" onOpen={setLightbox} onError={setError} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state">No attendance records yet.</div>}
        {records.length > 0 && displayed.length === 0 && <div className="empty-state">No employees match your search.</div>}
      </div>

      {lightbox && (
        <div className="modal-backdrop" onClick={() => setLightbox(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
            <img src={lightbox} alt="Clock-in/out proof" style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 6 }} />
            <div className="modal-actions" style={{ justifyContent: "center", marginTop: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setLightbox(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
