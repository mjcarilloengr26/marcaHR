import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = { title: "", customer_name: "", value: "", stage: "lead", owner_id: "", expected_close_date: "", notes: "" };
const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Deals() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [deals, setDeals] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/deals").then(setDeals).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const updated = await api.put(`/deals/${editingId}`, payload);
        announceAutoOrder(updated);
      } else {
        const created = await api.post("/deals", payload);
        announceAutoOrder(created);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const announceAutoOrder = (updated) => {
    if (updated.autoCreatedOrder) {
      setNotice(`Won! Order ${updated.autoCreatedOrder.order_number} was created automatically and is now in fulfillment.`);
    }
  };

  const quickSetStage = async (id, stage) => {
    setNotice("");
    try {
      const updated = await api.put(`/deals/${id}`, { stage });
      announceAutoOrder(updated);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this opportunity?")) return;
    try {
      await api.del(`/deals/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const { sorted, toggleSort, arrow } = useSort(deals, "created_at", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sales Opportunities</h1>
          <p className="subtitle">
            {isHr
              ? "Pipeline — track opportunities from lead to close. Winning one auto-creates an order."
              : "Your pipeline — track your opportunities from lead to close. Winning one auto-creates an order."}
          </p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add opportunity</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success)", color: "var(--success)" }}>
          ✓ {notice}
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <SortTh label="Title" sortKey="title" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Value" sortKey="value" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Owner" sortKey="owner_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Expected close" sortKey="expected_close_date" toggleSort={toggleSort} arrow={arrow} />
              <th>Order</th>
              <SortTh label="Stage" sortKey="stage" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.customer_name}</td>
                <td>{money(d.value)}</td>
                <td>{d.owner_name || "—"}</td>
                <td>{d.expected_close_date || "—"}</td>
                <td>{d.linked_order_number || "—"}</td>
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
        {deals.length === 0 && <div className="empty-state">No sales opportunities yet.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit opportunity" : "Add opportunity"}</h2>
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
              {isHr && (
                <div className="form-row">
                  <label>Owner</label>
                  <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
                    <option value="">—</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                    ))}
                  </select>
                </div>
              )}
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
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create opportunity"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
