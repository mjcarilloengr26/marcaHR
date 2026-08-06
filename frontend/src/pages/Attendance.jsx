import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function Attendance() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/attendance").then(setRecords).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayRecord = records.find((r) => r.date === today && r.employee_id === user.employee_id);

  const clockIn = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/attendance/clock-in", {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/attendance/clock-out", {});
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
          <p className="subtitle">{isHr ? "Team attendance records" : "Track your daily attendance"}</p>
        </div>
        {!isHr && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={clockIn} disabled={busy || (todayRecord && todayRecord.clock_in)}>
              Clock in
            </button>
            <button className="btn btn-secondary" onClick={clockOut} disabled={busy || !todayRecord || todayRecord.clock_out}>
              Clock out
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <th>Employee</th>}
              <th>Date</th>
              <th>Status</th>
              <th>Clock in</th>
              <th>Clock out</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.date}</td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>{r.clock_in || "—"}</td>
                <td>{r.clock_out || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state">No attendance records yet.</div>}
      </div>
    </div>
  );
}
