import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { compressImageFile, readFileAsDataUrl } from "../utils/image";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

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
  const [search, setSearch] = useState("");

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

  // Approving deducts the days server-side and un-approving gives them back,
  // so the balance table above has to be re-read too — otherwise it keeps
  // showing the pre-approval figure until the page is reloaded, and the header
  // promise that days are "deducted automatically" looks broken.
  const refreshAfterBalanceChange = () => {
    loadRequests();
    if (balanceEmployeeId) loadBalances(balanceEmployeeId);
  };

  const updateStatus = async (id, status) => {
    try {
      await api.put(`/leave/requests/${id}/status`, { status, review_note: reviewNoteDrafts[id] || undefined });
      setReviewNoteDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      refreshAfterBalanceChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelRequest = async (id) => {
    if (!confirm("Cancel this leave request?")) return;
    try {
      await api.del(`/leave/requests/${id}`);
      refreshAfterBalanceChange();
    } catch (err) {
      setError(err.message);
    }
  };

  // Deleting is an HR/admin tool. An employee withdrawing their own pending
  // request already has "Cancel"; removing a decided request is a records job.
  const canDelete = () => isHr;

  const [selected, setSelected] = useState(() => new Set());
  const [deletingId, setDeletingId] = useState(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Deleting an approved request hands the days back, so say so rather than
  // letting HR discover it from the balance moving.
  const daysWording = (rows) => {
    const approved = rows.filter((r) => r.status === "approved");
    if (approved.length === 0) return "";
    const total = approved.reduce((sum, r) => sum + Number(r.days || 0), 0);
    return (
      `\n\n${approved.length} of them ${approved.length === 1 ? "is" : "are"} already approved, ` +
      `so ${total} day${total === 1 ? "" : "s"} will be added back to the affected balances.`
    );
  };

  const deleteRequest = async (r) => {
    if (!confirm(`Delete ${r.employee_name}'s ${r.leave_type_name} (${r.start_date} → ${r.end_date})?` + daysWording([r]))) {
      return;
    }
    setDeletingId(r.id);
    setError("");
    try {
      await api.del(`/leave/requests/${r.id}`);
      refreshAfterBalanceChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const deleteSelected = async () => {
    const targets = requests.filter((r) => selected.has(r.id) && canDelete());
    if (targets.length === 0) return;
    if (!confirm(`Delete ${targets.length} leave request${targets.length === 1 ? "" : "s"}?` + daysWording(targets))) {
      return;
    }
    setBulkDeleting(true);
    setError("");
    // One at a time rather than in parallel: each delete may adjust a balance,
    // and a partial failure then names exactly which ones survived.
    const failed = [];
    for (const r of targets) {
      try {
        await api.del(`/leave/requests/${r.id}`);
      } catch (err) {
        failed.push(`${r.employee_name} ${r.leave_type_name}: ${err.message}`);
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    if (failed.length) {
      setError(`${failed.length} of ${targets.length} could not be deleted — ${failed.join("; ")}`);
    }
    refreshAfterBalanceChange();
  };

  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(requests.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [requests]);

  const filteredRequests = requests.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.employee_name, r.leave_type_name, r.reason, r.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredRequests, "created_at", "desc");

  // Select-all covers the rows currently listed, so it respects the search
  // rather than quietly taking rows that aren't on screen.
  const selectableVisible = isHr ? sorted : [];
  const selectedVisible = selectableVisible.filter((r) => selected.has(r.id));
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisible.length === selectableVisible.length;

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) selectableVisible.forEach((r) => next.delete(r.id));
      else selectableVisible.forEach((r) => next.add(r.id));
      return next;
    });

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
          <table className="sticky-head">
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

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by employee, type, reason, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Only appears once something is ticked, so a destructive control isn't
          sitting armed on the page during ordinary browsing. */}
      {selected.size > 0 && (
        <div
          className="card"
          style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}
        >
          <strong>{selected.size} selected</strong>
          <button type="button" className="link-btn" disabled={bulkDeleting} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm btn-danger" onClick={deleteSelected} disabled={bulkDeleting}>
            {bulkDeleting ? "Deleting…" : `Delete ${selected.size} selected`}
          </button>
        </div>
      )}

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all requests shown"
                    disabled={selectableVisible.length === 0}
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                  />
                </th>
              )}
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
              <tr key={r.id} className={selected.has(r.id) ? "row-selected" : undefined}>
                {isHr && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.employee_name} ${r.leave_type_name}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                    />
                  </td>
                )}
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
                  {isHr && (
                    <button
                      className="btn btn-sm btn-danger"
                      style={{ marginTop: r.status === "pending" ? 6 : 0 }}
                      disabled={deletingId === r.id}
                      onClick={() => deleteRequest(r)}
                    >
                      {deletingId === r.id ? "Deleting…" : "Delete"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {requests.length === 0 && <div className="empty-state">No leave requests found.</div>}
        {requests.length > 0 && sorted.length === 0 && <div className="empty-state">No leave requests match your search.</div>}
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
              <DecimalInput min="0" value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} autoFocus />
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
