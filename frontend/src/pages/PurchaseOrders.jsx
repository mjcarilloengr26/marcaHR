import { useEffect, useState } from "react";
import { api } from "../api/client";
import SuggestInput from "../components/SuggestInput";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

const emptyForm = { po_number: "", vendor_name: "", description: "", amount: "", order_date: "", expected_delivery_date: "", notes: "" };
const STATUSES = ["draft", "submitted", "approved", "received", "cancelled"];

export default function PurchaseOrders() {
  const { money } = useAppSettings();
  const [pos, setPos] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = () => api.get("/purchase-orders").then(setPos).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (po) => {
    setEditingId(po.id);
    setForm({
      po_number: po.po_number,
      vendor_name: po.vendor_name,
      description: po.description || "",
      amount: po.amount,
      order_date: po.order_date || "",
      expected_delivery_date: po.expected_delivery_date || "",
      notes: po.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, amount: Number(form.amount) || 0 };
      if (editingId) {
        await api.put(`/purchase-orders/${editingId}`, payload);
      } else {
        await api.post("/purchase-orders", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id, status) => {
    try {
      await api.put(`/purchase-orders/${id}/status`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this purchase order?")) return;
    try {
      await api.del(`/purchase-orders/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredPos = pos.filter((po) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [po.po_number, po.vendor_name, po.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredPos, "order_date", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Purchase Orders</h1>
          <p className="subtitle">Procurement — orders placed with vendors</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add purchase order</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by PO #, vendor, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              <SortTh label="PO #" sortKey="po_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Vendor" sortKey="vendor_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Amount" sortKey="amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Order date" sortKey="order_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Expected delivery" sortKey="expected_delivery_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((po) => (
              <tr key={po.id}>
                <td>{po.po_number}</td>
                <td>{po.vendor_name}</td>
                <td>{money(po.amount)}</td>
                <td>{po.order_date}</td>
                <td>{po.expected_delivery_date || "—"}</td>
                <td><span className={`badge badge-${po.status}`}>{po.status}</span></td>
                <td style={{ display: "flex", gap: 6 }}>
                  {po.status === "draft" && (
                    <button className="btn btn-sm" onClick={() => setStatus(po.id, "submitted")}>Submit</button>
                  )}
                  {po.status === "submitted" && (
                    <button className="btn btn-sm" onClick={() => setStatus(po.id, "approved")}>Approve</button>
                  )}
                  {po.status === "approved" && (
                    <button className="btn btn-sm" onClick={() => setStatus(po.id, "received")}>Mark received</button>
                  )}
                  {po.status === "draft" && (
                    <button className="btn btn-sm btn-secondary" onClick={() => openEdit(po)}>Edit</button>
                  )}
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(po.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pos.length === 0 && <div className="empty-state">No purchase orders yet.</div>}
        {pos.length > 0 && sorted.length === 0 && <div className="empty-state">No purchase orders match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit purchase order" : "Add purchase order"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>PO number</label>
                <input value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Vendor</label>
                <SuggestInput field="vendor_name" value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Amount</label>
                <DecimalInput value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Order date</label>
                <input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Expected delivery</label>
                <input type="date" value={form.expected_delivery_date} onChange={(e) => setForm({ ...form, expected_delivery_date: e.target.value })} />
              </div>
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
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create purchase order"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
