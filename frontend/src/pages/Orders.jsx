import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = { order_number: "", customer_name: "", amount: "", status: "placed", owner_id: "", order_date: "", notes: "" };
const STATUSES = ["placed", "processing", "shipped", "delivered", "cancelled"];
const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = () => api.get("/orders").then(setOrders).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    api.get("/employees").then(setEmployees).catch(() => {});
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (order) => {
    setEditingId(order.id);
    setForm({
      order_number: order.order_number,
      customer_name: order.customer_name,
      amount: order.amount,
      status: order.status,
      owner_id: order.owner_id || "",
      order_date: order.order_date || "",
      notes: order.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, amount: Number(form.amount) || 0, owner_id: form.owner_id || null };
      if (editingId) {
        await api.put(`/orders/${editingId}`, payload);
      } else {
        await api.post("/orders", payload);
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
      await api.put(`/orders/${id}`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this order?")) return;
    try {
      await api.del(`/orders/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredOrders = orders.filter((o) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [o.order_number, o.customer_name, o.owner_name, o.deal_title, o.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredOrders, "order_date", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">Customer orders — track fulfillment from placement to delivery</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add order</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by order #, customer, owner, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <SortTh label="Order #" sortKey="order_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Amount" sortKey="amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Owner" sortKey="owner_name" toggleSort={toggleSort} arrow={arrow} />
              <th>From opportunity</th>
              <SortTh label="Order date" sortKey="order_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => (
              <tr key={o.id}>
                <td>{o.order_number}</td>
                <td>{o.customer_name}</td>
                <td>{money(o.amount)}</td>
                <td>{o.owner_name || "—"}</td>
                <td>{o.deal_title || "—"}</td>
                <td>{o.order_date}</td>
                <td>
                  <select value={o.status} onChange={(e) => quickSetStatus(o.id, e.target.value)} style={{ width: "auto" }}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(o)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(o.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <div className="empty-state">No orders yet.</div>}
        {orders.length > 0 && sorted.length === 0 && <div className="empty-state">No orders match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit order" : "Add order"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Order number</label>
                <input value={form.order_number} onChange={(e) => setForm({ ...form, order_number: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Customer</label>
                <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Amount</label>
                <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
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
                <label>Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Order date</label>
                <input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create order"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
