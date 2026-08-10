import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = {
  work_order_number: "",
  title: "",
  customer_name: "",
  description: "",
  address: "",
  order_id: "",
  assigned_to: "",
  priority: "medium",
  scheduled_date: "",
  notes: "",
};
const STATUSES = ["open", "assigned", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

export default function WorkOrders() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [workOrders, setWorkOrders] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = () => api.get("/work-orders").then(setWorkOrders).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    if (isHr) {
      api.get("/employees").then(setEmployees).catch(() => {});
      api.get("/orders").then(setOrders).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (wo) => {
    setEditingId(wo.id);
    setForm({
      work_order_number: wo.work_order_number,
      title: wo.title,
      customer_name: wo.customer_name,
      description: wo.description || "",
      address: wo.address || "",
      order_id: wo.order_id || "",
      assigned_to: wo.assigned_to || "",
      priority: wo.priority,
      scheduled_date: wo.scheduled_date || "",
      notes: wo.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, order_id: form.order_id || null, assigned_to: form.assigned_to || null };
      if (editingId) {
        await api.put(`/work-orders/${editingId}`, payload);
      } else {
        await api.post("/work-orders", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const quickSetStatus = async (id, status) => {
    try {
      await api.put(`/work-orders/${id}`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this work order?")) return;
    try {
      await api.del(`/work-orders/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredWorkOrders = workOrders.filter((w) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [w.work_order_number, w.title, w.customer_name, w.assigned_to_name, w.priority, w.status].some((v) =>
      (v || "").toLowerCase().includes(q)
    );
  });
  const { sorted, toggleSort, arrow } = useSort(filteredWorkOrders, "scheduled_date", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Work Orders</h1>
          <p className="subtitle">{isHr ? "Customer service jobs — assign staff and track completion" : "Work orders assigned to you"}</p>
        </div>
        {isHr && <button className="btn" onClick={openAdd}>+ Add work order</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by WO #, title, customer, assignee, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <SortTh label="WO #" sortKey="work_order_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Title" sortKey="title" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Assigned to" sortKey="assigned_to_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Priority" sortKey="priority" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Scheduled" sortKey="scheduled_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              {isHr && <th></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((w) => (
              <tr key={w.id}>
                <td>{w.work_order_number}</td>
                <td>{w.title}</td>
                <td>{w.customer_name}</td>
                <td>{w.assigned_to_name || "—"}</td>
                <td><span className={`badge badge-${w.priority === "urgent" || w.priority === "high" ? "rejected" : "draft"}`}>{w.priority}</span></td>
                <td>{w.scheduled_date || "—"}</td>
                <td>
                  <select value={w.status} onChange={(e) => quickSetStatus(w.id, e.target.value)} style={{ width: "auto" }}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s.replace("_", " ")}</option>
                    ))}
                  </select>
                </td>
                {isHr && (
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => openEdit(w)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(w.id)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {workOrders.length === 0 && <div className="empty-state">No work orders yet.</div>}
        {workOrders.length > 0 && sorted.length === 0 && <div className="empty-state">No work orders match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit work order" : "Add work order"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Work order #</label>
                <input value={form.work_order_number} onChange={(e) => setForm({ ...form, work_order_number: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Title</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Customer</label>
                <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Related order</label>
                <select value={form.order_id} onChange={(e) => setForm({ ...form, order_id: e.target.value })}>
                  <option value="">—</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>{o.order_number} — {o.customer_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Assigned to</label>
                <select value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}>
                  <option value="">Unassigned</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Priority</label>
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Scheduled date</label>
                <input type="date" value={form.scheduled_date} onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Service address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Description</label>
              <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create work order"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
