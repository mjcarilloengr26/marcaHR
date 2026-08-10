import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = { invoice_number: "", order_id: "", customer_name: "", amount: "", status: "draft", issue_date: "", due_date: "", notes: "" };
const STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"];
const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Billing() {
  const [invoices, setInvoices] = useState([]);
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = () => api.get("/invoices").then(setInvoices).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    api.get("/orders").then(setOrders).catch(() => {});
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (inv) => {
    setEditingId(inv.id);
    setForm({
      invoice_number: inv.invoice_number,
      order_id: inv.order_id || "",
      customer_name: inv.customer_name,
      amount: inv.amount,
      status: inv.status,
      issue_date: inv.issue_date || "",
      due_date: inv.due_date || "",
      notes: inv.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, order_id: form.order_id || null, amount: Number(form.amount) || 0 };
      if (editingId) {
        await api.put(`/invoices/${editingId}`, payload);
      } else {
        await api.post("/invoices", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const billOrder = async (orderId) => {
    setError("");
    try {
      await api.post(`/invoices/from-order/${orderId}`, {});
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const quickSetStatus = async (id, status) => {
    try {
      await api.put(`/invoices/${id}`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this invoice?")) return;
    try {
      await api.del(`/invoices/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const unbilledOrders = orders.filter((o) => !invoices.some((inv) => inv.order_id === o.id));

  const filteredInvoices = invoices.filter((inv) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [inv.invoice_number, inv.order_number, inv.customer_name, inv.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredInvoices, "issue_date", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Billing</h1>
          <p className="subtitle">Customer invoices, linked to orders</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add invoice</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {unbilledOrders.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Orders not yet billed</h2>
          <table>
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unbilledOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_number}</td>
                  <td>{o.customer_name}</td>
                  <td>{money(o.amount)}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => billOrder(o.id)}>+ Bill this order</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by invoice #, order #, customer, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <SortTh label="Invoice #" sortKey="invoice_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Order" sortKey="order_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Amount" sortKey="amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Issue date" sortKey="issue_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Due date" sortKey="due_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.invoice_number}</td>
                <td>{inv.order_number || "—"}</td>
                <td>{inv.customer_name}</td>
                <td>{money(inv.amount)}</td>
                <td>{inv.issue_date}</td>
                <td>{inv.due_date || "—"}</td>
                <td>
                  <select value={inv.status} onChange={(e) => quickSetStatus(inv.id, e.target.value)} style={{ width: "auto" }}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(inv)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(inv.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invoices.length === 0 && <div className="empty-state">No invoices yet.</div>}
        {invoices.length > 0 && sorted.length === 0 && <div className="empty-state">No invoices match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit invoice" : "Add invoice"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Invoice number</label>
                <input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })} required />
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
                <label>Amount</label>
                <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Issue date</label>
                <input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Due date</label>
                <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create invoice"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
