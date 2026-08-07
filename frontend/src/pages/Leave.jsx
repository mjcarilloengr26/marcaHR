import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { compressImageFile, readFileAsDataUrl } from "../utils/image";

const emptyForm = { employee_id: "", leave_type_id: "", start_date: "", end_date: "", reason: "" };

function AttachmentCell({ name, data }) {
  if (!data) return <span>—</span>;
  return (
    <a href={data} download={name || "attachment"} target="_blank" rel="noreferrer" className="location-link">
      📎 {name || "View"}
    </a>
  );
}

export default function Leave() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [requests, setRequests] = useState([]);
  const [types, setTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [attachment, setAttachment] = useState(null); // { name, type, data }
  const [attaching, setAttaching] = useState(false);

  const loadRequests = () => api.get("/leave/requests").then(setRequests).catch((err) => setError(err.message));

  useEffect(() => {
    loadRequests();
    api.get("/leave/types").then(setTypes).catch(() => {});
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilePick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setAttaching(true);
    try {
      const data = file.type.startsWith("image/") ? await compressImageFile(file, 1400, 0.8) : await readFileAsDataUrl(file);
      setAttachment({ name: file.name, type: file.type, data });
    } catch (err) {
      setError(err.message);
    } finally {
      setAttaching(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/leave/requests", {
        ...form,
        attachment_name: attachment?.name,
        attachment_type: attachment?.type,
        attachment_data: attachment?.data,
      });
      setShowForm(false);
      setForm(emptyForm);
      setAttachment(null);
      loadRequests();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.put(`/leave/requests/${id}/status`, { status });
      loadRequests();
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelRequest = async (id) => {
    if (!confirm("Cancel this leave request?")) return;
    try {
      await api.del(`/leave/requests/${id}`);
      loadRequests();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Leave</h1>
          <p className="subtitle">{isHr ? "Review and manage leave requests" : "Request and track your time off"}</p>
        </div>
        <button className="btn" onClick={() => setShowForm(true)}>
          + Request leave
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <th>Employee</th>}
              <th>Type</th>
              <th>Dates</th>
              <th>Days</th>
              <th>Reason</th>
              <th>Attachment</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.leave_type_name}</td>
                <td>{r.start_date} → {r.end_date}</td>
                <td>{r.days}</td>
                <td>{r.reason || "—"}</td>
                <td><AttachmentCell name={r.attachment_name} data={r.attachment_data} /></td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>
                  {isHr && r.status === "pending" && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => updateStatus(r.id, "approved")}>Approve</button>
                      <button className="btn btn-sm btn-danger" onClick={() => updateStatus(r.id, "rejected")}>Reject</button>
                    </div>
                  )}
                  {!isHr && r.status === "pending" && (
                    <button className="btn btn-sm btn-secondary" onClick={() => cancelRequest(r.id)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {requests.length === 0 && <div className="empty-state">No leave requests found.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>Request leave</h2>
            {isHr && (
              <div className="form-row">
                <label>Employee</label>
                <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required>
                  <option value="">Select employee</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-row">
              <label>Leave type</label>
              <select value={form.leave_type_id} onChange={(e) => setForm({ ...form, leave_type_id: e.target.value })} required>
                <option value="">Select type</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Start date</label>
                <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>End date</label>
                <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} required />
              </div>
            </div>
            <div className="form-row">
              <label>Reason</label>
              <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Supporting document (optional)</label>
              {attachment ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="subtitle" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    📎 {attachment.name}
                  </span>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAttachment(null)}>
                    Remove
                  </button>
                </div>
              ) : (
                <input type="file" accept="image/*,.pdf,.doc,.docx" onChange={handleFilePick} disabled={attaching} />
              )}
              {attaching && <span className="subtitle">Attaching…</span>}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving || attaching}>{saving ? "Submitting…" : "Submit request"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
