import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = { invoice_number: "", order_id: "", customer_name: "", amount: "", status: "draft", issue_date: "", due_date: "", notes: "" };
const STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"];

export default function Billing() {
  const { money } = useAppSettings();
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

  // Pre-fills the invoice form from an order's remaining balance rather than
  // creating the invoice outright, so the amount (and everything else) is
  // editable before it's saved — billing the full remainder isn't always what's
  // wanted (e.g. a further partial payment, a discount, a different due date).
  const openBillOrder = (order) => {
    const priorCount = invoices.filter((inv) => inv.order_id === order.id).length;
    const suggestedNumber = priorCount === 0 ? `INV-${order.order_number}` : `INV-${order.order_number}-${priorCount + 1}`;
    setEditingId(null);
    setForm({
      invoice_number: suggestedNumber,
      order_id: order.id,
      customer_name: order.customer_name,
      amount: order.remaining,
      status: "draft",
      issue_date: "",
      due_date: "",
      notes: "",
    });
    setShowForm(true);
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

  // An order can carry more than one invoice (e.g. a partial invoice now, another
  // for the remainder later), so "not yet billed" must compare the order's amount
  // against the sum of its non-cancelled invoices, not just whether any invoice
  // exists — otherwise a partially-billed order (billed for less than its full
  // amount) would vanish from this list entirely, leaving its remaining balance
  // untracked and unbillable.
  const billedByOrder = invoices.reduce((acc, inv) => {
    if (inv.status === "cancelled" || !inv.order_id) return acc;
    acc[inv.order_id] = (acc[inv.order_id] || 0) + Number(inv.amount || 0);
    return acc;
  }, {});
  const unbilledOrders = orders
    .map((o) => ({ ...o, billed: billedByOrder[o.id] || 0, remaining: Math.max(o.amount - (billedByOrder[o.id] || 0), 0) }))
    .filter((o) => o.remaining > 0);

  // The cap for whatever order is currently selected in the form — mirrors the
  // backend's own check (server-side is what actually enforces the limit; this
  // is just so the field gives immediate feedback instead of a round-trip).
  // Excludes the invoice being edited from "already billed" so editing an
  // invoice's own amount doesn't count it against itself.
  const formOrderRemaining = (() => {
    if (!form.order_id) return null;
    const order = orders.find((o) => o.id === Number(form.order_id));
    if (!order) return null;
    const billedByOthers = invoices
      .filter((inv) => inv.order_id === Number(form.order_id) && inv.status !== "cancelled" && inv.id !== editingId)
      .reduce((sum, inv) => sum + Number(inv.amount || 0), 0);
    return Math.max(order.amount - billedByOthers, 0);
  })();

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
          <h2>Orders not yet fully billed</h2>
          <table>
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Order amount</th>
                <th>Billed so far</th>
                <th>Remaining</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unbilledOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_number}</td>
                  <td>{o.customer_name}</td>
                  <td>{money(o.amount)}</td>
                  <td>{o.billed > 0 ? money(o.billed) : "—"}</td>
                  <td>{money(o.remaining)}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => openBillOrder(o)}>
                      {o.billed > 0 ? `+ Bill remaining ${money(o.remaining)}` : "+ Bill this order"}
                    </button>
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
                <label>Amount{formOrderRemaining !== null && ` (up to ${money(formOrderRemaining)} remaining on this order)`}</label>
                <input
                  type="number"
                  value={form.amount}
                  max={formOrderRemaining !== null ? formOrderRemaining : undefined}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
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
