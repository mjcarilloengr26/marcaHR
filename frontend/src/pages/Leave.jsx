import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { compressImageFile, readFileAsDataUrl } from "../utils/image";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

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
  const currentYear = new Date().getFullYear();
  const [requests, setRequests] = useState([]);
  const [types, setTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [attachment, setAttachment] = useState(null); // { name, type, data }
  const [attaching, setAttaching] = useState(false);
  const [resubmitting, setResubmitting] = useState(null); // the request being resubmitted, or null
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState({}); // { [requestId]: text }
  const [balances, setBalances] = useState([]);
  const [balanceEmployeeId, setBalanceEmployeeId] = useState(isHr ? "" : user.employee_id);
  const [editingBalance, setEditingBalance] = useState(null); // the balance row being edited, or null
  const [balanceAmount, setBalanceAmount] = useState("");

  const loadRequests = () => api.get("/leave/requests").then(setRequests).catch((err) => setError(err.message));

  const loadBalances = (employeeId) => {
    if (!employeeId) {
      setBalances([]);
      return;
    }
    api.get(`/leave/balances/${employeeId}`).then(setBalances).catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadRequests();
    api.get("/leave/types").then(setTypes).catch(() => {});
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    if (balanceEmployeeId) loadBalances(balanceEmployeeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEditBalance = (row) => {
    setEditingBalance(row);
    setBalanceAmount(row.allocated_days);
  };

  const saveBalance = async (e) => {
    e.preventDefault();
    try {
      await api.post("/leave/balances", {
        employee_id: balanceEmployeeId,
        leave_type_id: editingBalance.leave_type_id,
        year: currentYear,
        allocated_days: Number(balanceAmount) || 0,
      });
      setEditingBalance(null);
      loadBalances(balanceEmployeeId);
    } catch (err) {
      setError(err.message);
    }
  };

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

  const openRequestForm = () => {
    setResubmitting(null);
    setForm(emptyForm);
    setAttachment(null);
    setShowForm(true);
  };

  const openResubmitForm = (request) => {
    setResubmitting(request);
    setForm({
      employee_id: request.employee_id,
      leave_type_id: request.leave_type_id,
      start_date: request.start_date,
      end_date: request.end_date,
      reason: request.reason || "",
    });
    setAttachment(null);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        attachment_name: attachment?.name,
        attachment_type: attachment?.type,
        attachment_data: attachment?.data,
      };
      if (resubmitting) {
        await api.put(`/leave/requests/${resubmitting.id}/resubmit`, payload);
      } else {
        await api.post("/leave/requests", payload);
      }
      setShowForm(false);
      setResubmitting(null);
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
      await api.put(`/leave/requests/${id}/status`, { status, review_note: reviewNoteDrafts[id] || undefined });
      setReviewNoteDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
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

  const { sorted, toggleSort, arrow } = useSort(requests, "created_at", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Leave</h1>
          <p className="subtitle">{isHr ? "Review and manage leave requests" : "Request and track your time off"}</p>
        </div>
        <button className="btn" onClick={openRequestForm}>
          + Request leave
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="page-header" style={{ marginBottom: 4 }}>
          <div>
            <h2>Leave Balances</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              Allowed days per year per leave type, {currentYear} — used days are deducted automatically as requests are approved
            </p>
          </div>
          {isHr && (
            <div className="form-row">
              <label>Employee</label>
              <select
                value={balanceEmployeeId}
                onChange={(e) => {
                  setBalanceEmployeeId(e.target.value);
                  loadBalances(e.target.value);
                }}
              >
                <option value="">Select employee</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!balanceEmployeeId && <div className="empty-state">Select an employee to view their leave balances.</div>}
        {balanceEmployeeId && balances.length === 0 && <div className="empty-state">No leave balances found.</div>}
        {balanceEmployeeId && balances.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Allocated</th>
                <th>Used</th>
                <th>Remaining</th>
                {isHr && <th></th>}
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.leave_type_id}>
                  <td>{b.leave_type_name}</td>
                  <td>{b.allocated_days}</td>
                  <td>{b.used_days}</td>
                  <td>{Math.max(b.allocated_days - b.used_days, 0)}</td>
                  {isHr && (
                    <td>
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => openEditBalance(b)}>
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Type" sortKey="leave_type_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Dates" sortKey="start_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Days" sortKey="days" toggleSort={toggleSort} arrow={arrow} />
              <th>Reason</th>
              <th>Attachment</th>
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th>Review note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.leave_type_name}</td>
                <td>{r.start_date} → {r.end_date}</td>
                <td>{r.days}</td>
                <td>{r.reason || "—"}</td>
                <td><AttachmentCell name={r.attachment_name} data={r.attachment_data} /></td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>{r.review_note || "—"}</td>
                <td>
                  {isHr && r.status === "pending" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
                      <input
                        type="text"
                        placeholder="Note (e.g. missing document)"
                        value={reviewNoteDrafts[r.id] || ""}
                        onChange={(e) => setReviewNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      />
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => updateStatus(r.id, "approved")}>Approve</button>
                        <button className="btn btn-sm btn-danger" onClick={() => updateStatus(r.id, "rejected")}>Reject</button>
                      </div>
                    </div>
                  )}
                  {!isHr && r.status === "pending" && (
                    <button className="btn btn-sm btn-secondary" onClick={() => cancelRequest(r.id)}>Cancel</button>
                  )}
                  {!isHr && r.status === "rejected" && (
                    <button className="btn btn-sm" onClick={() => openResubmitForm(r)}>Resubmit</button>
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
            <h2>{resubmitting ? "Resubmit leave request" : "Request leave"}</h2>
            {resubmitting?.review_note && (
              <div className="card" style={{ marginBottom: 12, borderColor: "var(--danger)", color: "var(--danger)" }}>
                Rejected: {resubmitting.review_note}
              </div>
            )}
            {isHr && (
              <div className="form-row">
                <label>Employee</label>
                <select
                  value={form.employee_id}
                  onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                  required
                  disabled={Boolean(resubmitting)}
                >
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
              <label>Supporting document {resubmitting ? "(leave blank to keep the one already attached)" : "(optional)"}</label>
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
                <>
                  {resubmitting?.attachment_name && (
                    <p className="subtitle" style={{ marginTop: 0 }}>Currently attached: 📎 {resubmitting.attachment_name}</p>
                  )}
                  <input type="file" accept="image/*,.pdf,.doc,.docx" onChange={handleFilePick} disabled={attaching} />
                </>
              )}
              {attaching && <span className="subtitle">Attaching…</span>}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving || attaching}>
                {saving ? "Submitting…" : resubmitting ? "Resubmit request" : "Submit request"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingBalance && (
        <div className="modal-backdrop" onClick={() => setEditingBalance(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveBalance}>
            <h2>Edit allocated days — {editingBalance.leave_type_name}</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>{currentYear}</p>
            <div className="form-row">
              <label>Allocated days</label>
              <input type="number" min="0" value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingBalance(null)}>Cancel</button>
              <button type="submit" className="btn">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
