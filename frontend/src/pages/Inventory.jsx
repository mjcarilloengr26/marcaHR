import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = { sku: "", name: "", category: "", unit: "pcs", reorder_level: "", unit_cost: "", unit_price: "", location_id: "", notes: "" };
const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Inventory() {
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [stockModal, setStockModal] = useState(null); // { item, mode: "in" | "out" | "adjust" }
  const [stockForm, setStockForm] = useState({ quantity: "", reason: "" });
  const [historyItem, setHistoryItem] = useState(null);
  const [history, setHistory] = useState([]);
  const [alarmThreshold, setAlarmThreshold] = useState(null);
  const [showThresholdForm, setShowThresholdForm] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (lowStockOnly) params.set("low_stock", "true");
    const qs = params.toString();
    api.get(`/inventory${qs ? `?${qs}` : ""}`).then(setItems).catch((err) => setError(err.message));
    api.get("/inventory/summary").then(setSummary).catch(() => {});
  };

  const loadThreshold = () =>
    api.get("/inventory/settings").then((s) => setAlarmThreshold(s.alarm_threshold_percent)).catch(() => {});

  useEffect(() => {
    load();
    loadThreshold();
    api.get("/locations").then(setLocations).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, lowStockOnly]);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (item) => {
    setEditingId(item.id);
    setForm({
      sku: item.sku,
      name: item.name,
      category: item.category || "",
      unit: item.unit,
      reorder_level: item.reorder_level,
      unit_cost: item.unit_cost,
      unit_price: item.unit_price,
      location_id: item.location_id || "",
      notes: item.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        reorder_level: Number(form.reorder_level) || 0,
        unit_cost: Number(form.unit_cost) || 0,
        unit_price: Number(form.unit_price) || 0,
        location_id: form.location_id || null,
      };
      if (editingId) {
        await api.put(`/inventory/${editingId}`, payload);
      } else {
        await api.post("/inventory", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this inventory item? This cannot be undone.")) return;
    try {
      await api.del(`/inventory/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const openStock = (item, mode) => {
    setStockModal({ item, mode });
    setStockForm({ quantity: mode === "adjust" ? item.quantity_on_hand : "", reason: "" });
  };

  const submitStock = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const endpoint = stockModal.mode === "in" ? "stock-in" : stockModal.mode === "out" ? "stock-out" : "adjust";
      await api.post(`/inventory/${stockModal.item.id}/${endpoint}`, {
        quantity: Number(stockForm.quantity) || 0,
        reason: stockForm.reason || null,
      });
      setStockModal(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async (item) => {
    setHistoryItem(item);
    try {
      const rows = await api.get(`/inventory/${item.id}/transactions`);
      setHistory(rows);
    } catch (err) {
      setError(err.message);
    }
  };

  const openThresholdForm = () => {
    setThresholdInput(alarmThreshold ?? "");
    setShowThresholdForm(true);
  };

  const saveThreshold = async (e) => {
    e.preventDefault();
    setSavingThreshold(true);
    setError("");
    try {
      const updated = await api.put("/inventory/settings", { alarm_threshold_percent: Number(thresholdInput) });
      setAlarmThreshold(updated.alarm_threshold_percent);
      setShowThresholdForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingThreshold(false);
    }
  };

  const statusBadge = (status) => {
    const cls = status === "critical" ? "absent" : status === "low" ? "pending" : "active";
    const label = status === "critical" ? "alarm" : status === "low" ? "low stock" : "ok";
    return <span className={`badge badge-${cls}`}>{label}</span>;
  };

  const criticalItems = summary?.lowStockItems?.filter((i) => i.stock_status === "critical") || [];
  const { sorted, toggleSort, arrow } = useSort(items, null, "asc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Inventory</h1>
          <p className="subtitle">Stock levels, valuation, and movement history</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={openThresholdForm}>
            Alarm threshold: {alarmThreshold ?? "…"}%
          </button>
          <button className="btn" onClick={openAdd}>+ Add item</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {criticalItems.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--danger)", color: "var(--danger)" }}>
          ⚠ Low stock alarm — {criticalItems.length} item{criticalItems.length > 1 ? "s" : ""} at or below {alarmThreshold}% of reorder level:{" "}
          {criticalItems.map((i) => `${i.name} (${i.quantity_on_hand} ${i.unit})`).join(", ")}
        </div>
      )}

      {summary && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-value">{summary.totalItems}</div>
            <div className="stat-label">Items tracked</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{money(summary.totalValue)}</div>
            <div className="stat-label">Total stock value</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{summary.lowStockCount}</div>
            <div className="stat-label">Low stock items</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{summary.criticalCount}</div>
            <div className="stat-label">In alarm zone</div>
          </div>
        </div>
      )}

      <div className="card form-inline" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <label>Search</label>
          <input type="text" placeholder="Search by SKU or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 20 }}>
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <SortTh label="SKU" sortKey="sku" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Name" sortKey="name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Category" sortKey="category" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="On hand" sortKey="quantity_on_hand" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Reorder level" sortKey="reorder_level" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Unit cost" sortKey="unit_cost" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Stock value" sortKey="total_value" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Location" sortKey="location_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="stock_status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) => (
              <tr key={i.id}>
                <td>{i.sku}</td>
                <td>{i.name}</td>
                <td>{i.category || "—"}</td>
                <td>{i.quantity_on_hand} {i.unit}</td>
                <td>{i.reorder_level} {i.unit}</td>
                <td>{money(i.unit_cost)}</td>
                <td>{money(i.total_value)}</td>
                <td>{i.location_name || "—"}</td>
                <td>{statusBadge(i.stock_status)}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={() => openStock(i, "in")}>Stock in</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openStock(i, "out")}>Stock out</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openStock(i, "adjust")}>Adjust</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openHistory(i)}>History</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(i)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(i.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="empty-state">No inventory items found.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit item" : "Add inventory item"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>SKU</label>
                <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Category</label>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Unit</label>
                <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pcs, box, kg…" />
              </div>
              <div className="form-row">
                <label>Reorder level</label>
                <input type="number" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Unit cost</label>
                <input type="number" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Unit price</label>
                <input type="number" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Location</label>
                <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                  <option value="">—</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create item"}</button>
            </div>
          </form>
        </div>
      )}

      {stockModal && (
        <div className="modal-backdrop" onClick={() => setStockModal(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submitStock}>
            <h2>
              {stockModal.mode === "in" ? "Stock in" : stockModal.mode === "out" ? "Stock out" : "Adjust quantity"} — {stockModal.item.name}
            </h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              Currently {stockModal.item.quantity_on_hand} {stockModal.item.unit} on hand
            </p>
            <div className="form-row">
              <label>{stockModal.mode === "adjust" ? "New quantity" : "Quantity"}</label>
              <input
                type="number"
                min="0"
                value={stockForm.quantity}
                onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })}
                autoFocus
                required
              />
            </div>
            <div className="form-row">
              <label>Reason</label>
              <input
                value={stockForm.reason}
                onChange={(e) => setStockForm({ ...stockForm, reason: e.target.value })}
                placeholder={stockModal.mode === "adjust" ? "e.g. physical count correction" : "e.g. PO-3004 received"}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStockModal(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Confirm"}</button>
            </div>
          </form>
        </div>
      )}

      {showThresholdForm && (
        <div className="modal-backdrop" onClick={() => setShowThresholdForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveThreshold}>
            <h2>Low stock alarm threshold</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              An item enters the alarm zone (and HR/admin get emailed) once its quantity on hand falls to this
              percentage of its reorder level.
            </p>
            <div className="form-row">
              <label>Threshold (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowThresholdForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={savingThreshold}>{savingThreshold ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </div>
      )}

      {historyItem && (
        <div className="modal-backdrop" onClick={() => setHistoryItem(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Movement history — {historyItem.name}</h2>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Quantity</th>
                  <th>Reason</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => (
                  <tr key={t.id}>
                    <td>{t.created_at?.slice(0, 16).replace("T", " ")}</td>
                    <td><span className={`badge badge-${t.type === "in" ? "active" : t.type === "out" ? "absent" : "pending"}`}>{t.type}</span></td>
                    <td>{t.type === "adjustment" && t.quantity > 0 ? "+" : ""}{t.quantity}</td>
                    <td>{t.reason || "—"}</td>
                    <td>{t.created_by_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.length === 0 && <div className="empty-state">No movements recorded yet.</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setHistoryItem(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
