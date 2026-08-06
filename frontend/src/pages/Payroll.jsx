import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Payroll() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [editingRecord, setEditingRecord] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/payroll").then(setRecords).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const generate = async () => {
    setGenerating(true);
    setError("");
    try {
      await api.post("/payroll/generate", { period_month: Number(month), period_year: Number(year) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const setStatus = async (id, status) => {
    try {
      await api.put(`/payroll/${id}/status`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const openEdit = (record) => {
    setEditingRecord(record);
    setEditForm({
      base_salary: record.base_salary,
      bonuses: record.bonuses,
      overtime_pay: record.overtime_pay,
      deductions: record.deductions,
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/payroll", {
        employee_id: editingRecord.employee_id,
        period_month: editingRecord.period_month,
        period_year: editingRecord.period_year,
        base_salary: Number(editForm.base_salary) || 0,
        bonuses: Number(editForm.bonuses) || 0,
        overtime_pay: Number(editForm.overtime_pay) || 0,
        deductions: Number(editForm.deductions) || 0,
      });
      setEditingRecord(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Payroll</h1>
          <p className="subtitle">{isHr ? "Manage payroll runs" : "View your payslips"}</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {isHr && (
        <div className="card form-inline" style={{ marginBottom: 16 }}>
          <div className="form-row">
            <label>Month</label>
            <input type="number" min="1" max="12" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <button className="btn" onClick={generate} disabled={generating}>
            {generating ? "Generating…" : "Generate payroll for period"}
          </button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <th>Employee</th>}
              <th>Period</th>
              <th>Base</th>
              <th>Bonuses</th>
              <th>Overtime</th>
              <th>Deductions</th>
              <th>Net pay</th>
              <th>Status</th>
              {isHr && <th></th>}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{MONTH_NAMES[r.period_month]} {r.period_year}</td>
                <td>₱{Number(r.base_salary).toLocaleString()}</td>
                <td>₱{Number(r.bonuses).toLocaleString()}</td>
                <td>₱{Number(r.overtime_pay || 0).toLocaleString()}</td>
                <td>₱{Number(r.deductions).toLocaleString()}</td>
                <td><strong>₱{Number(r.net_pay).toLocaleString()}</strong></td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                {isHr && (
                  <td style={{ display: "flex", gap: 6 }}>
                    {r.status === "draft" && (
                      <>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(r)}>Edit</button>
                        <button className="btn btn-sm" onClick={() => setStatus(r.id, "finalized")}>Finalize</button>
                      </>
                    )}
                    {r.status === "finalized" && (
                      <button className="btn btn-sm" onClick={() => setStatus(r.id, "paid")}>Mark paid</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state">No payroll records yet.</div>}
      </div>

      {editingRecord && (
        <div className="modal-backdrop" onClick={() => setEditingRecord(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveEdit}>
            <h2>Edit payroll — {editingRecord.employee_name}</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              {MONTH_NAMES[editingRecord.period_month]} {editingRecord.period_year}
            </p>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Base salary</label>
                <input
                  type="number"
                  value={editForm.base_salary}
                  onChange={(e) => setEditForm({ ...editForm, base_salary: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Bonuses</label>
                <input
                  type="number"
                  value={editForm.bonuses}
                  onChange={(e) => setEditForm({ ...editForm, bonuses: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Overtime pay</label>
                <input
                  type="number"
                  value={editForm.overtime_pay}
                  onChange={(e) => setEditForm({ ...editForm, overtime_pay: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Deductions</label>
                <input
                  type="number"
                  value={editForm.deductions}
                  onChange={(e) => setEditForm({ ...editForm, deductions: e.target.value })}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingRecord(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
