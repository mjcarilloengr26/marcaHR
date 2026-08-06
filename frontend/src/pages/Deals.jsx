import { useEffect, useState } from "react";
import { api } from "../api/client";

const emptyForm = { title: "", customer_name: "", value: "", stage: "lead", owner_id: "", expected_close_date: "", notes: "" };
const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Deals() {
  const [deals, setDeals] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/deals").then(setDeals).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    api.get("/employees").then(setEmployees).catch(() => {});
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (deal) => {
    setEditingId(deal.id);
    setForm({
      title: deal.title,
      customer_name: deal.customer_name,
      value: deal.value,
      stage: deal.stage,
      owner_id: deal.owner_id || "",
      expected_close_date: deal.expected_close_date || "",
      notes: deal.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, value: Number(form.value) || 0, owner_id: form.owner_id || null };
      if (editingId) {
        await api.put(`/deals/${editingId}`, payload);
      } else {
        await api.post("/deals", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const quickSetStage = async (id, stage) => {
    try {
      await api.put(`/deals/${id}`, { stage });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this deal?")) return;
    try {
      await api.del(`/deals/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Deals</h1>
          <p className="subtitle">Sales pipeline — track opportunities from lead to close</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add deal</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Customer</th>
              <th>Value</th>
              <th>Owner</th>
              <th>Expected close</th>
              <th>Stage</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.customer_name}</td>
                <td>{money(d.value)}</td>
                <td>{d.owner_name || "—"}</td>
                <td>{d.expected_close_date || "—"}</td>
                <td>
                  <select value={d.stage} onChange={(e) => quickSetStage(d.id, e.target.value)} style={{ width: "auto" }}>
                    {STAGES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(d)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {deals.length === 0 && <div className="empty-state">No deals yet.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit deal" : "Add deal"}</h2>
            <div className="form-row">
              <label>Title</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Customer</label>
                <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Value</label>
                <input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Owner</label>
                <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
                  <option value="">—</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Stage</label>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Expected close date</label>
                <input type="date" value={form.expected_close_date} onChange={(e) => setForm({ ...form, expected_close_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create deal"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
