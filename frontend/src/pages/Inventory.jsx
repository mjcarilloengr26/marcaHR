import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import SuggestInput from "../components/SuggestInput";
import { useAppSettings } from "../context/AppSettingsContext";
import { readFileAsDataUrl } from "../utils/image";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const DEFAULT_MARGIN = 50;

// Margin is taken on the selling price, not on the cost: it is the share of
// each peso of revenue left after paying for the goods. So the price is the
// cost grossed up, price = cost / (1 - margin/100), and 50% doubles the cost.
// Margin itself is not stored — it is recovered from cost and price whenever
// the form opens, so those two remain the single source of truth and no
// migration is needed to support this.
const priceFromMargin = (cost, margin, current) => {
  const m = Number(margin);
  // A half-typed or cleared box should not rewrite the other fields — leave
  // the price where it is until there is a real number to work from.
  if (cost === "" || margin === "" || !Number.isFinite(m)) return current;
  // At 100% the price would be infinite, and beyond it negative: no selling
  // price can leave more margin than the whole of itself. Hold steady instead
  // of showing a nonsense figure while the box is being typed into.
  if (m >= 100) return current;
  return Math.round(((Number(cost) || 0) / (1 - m / 100)) * 100) / 100;
};
const marginFromPrice = (cost, price, current) => {
  const c = Number(cost) || 0;
  if (price === "") return current;
  const pr = Number(price) || 0;
  if (pr <= 0) return ""; // a share of a zero price is undefined
  return Math.round(((pr - c) / pr) * 1000) / 10;
};

const emptyForm = { sku: "", name: "", category: "", unit: "pcs", quantity_on_hand: "", reorder_level: "", unit_cost: "", unit_price: "", margin: DEFAULT_MARGIN, location_id: "", notes: "" };

export default function Inventory() {
  const { money, moneyPrecise, moneyWhole, currencySymbol } = useAppSettings();
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
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const importInputRef = useRef(null);

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
      quantity_on_hand: item.quantity_on_hand,
      reorder_level: item.reorder_level,
      unit_cost: item.unit_cost,
      unit_price: item.unit_price,
      margin: item.unit_price > 0 ? marginFromPrice(item.unit_cost, item.unit_price) : DEFAULT_MARGIN,
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
        quantity_on_hand: Number(form.quantity_on_hand) || 0,
        reorder_level: Number(form.reorder_level) || 0,
        unit_cost: Number(form.unit_cost) || 0,
        unit_price: Number(form.unit_price) || 0,
        location_id: form.location_id || null,
      };
      delete payload.margin;
      // Create records it as an opening balance; update records the difference
      // as an adjustment. Either way the change lands in the item's History.
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
    if (!confirm("Delete this inventory item? This also removes its stock movement history, and cannot be undone.")) return;
    try {
      await api.del(`/inventory/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // Names both consequences before deleting: how many items, and that their
  // movement history goes with them. Lists the item names when the selection
  // is small enough to read, so a mis-tick is caught before it's irreversible.
  const handleBulkDelete = async () => {
    const chosen = items.filter((i) => selectedIds.includes(i.id));
    if (chosen.length === 0) return;
    const names =
      chosen.length <= 8
        ? `\n\n${chosen.map((i) => `• ${i.sku} — ${i.name}`).join("\n")}`
        : `\n\n(${chosen.length} items)`;
    if (
      !confirm(
        `Delete ${chosen.length} inventory item${chosen.length > 1 ? "s" : ""}?${names}\n\n` +
          "Their stock movement history will be removed too. This cannot be undone."
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setError("");
    try {
      const res = await api.post("/inventory/bulk-delete", { ids: selectedIds });
      setSelectedIds([]);
      load();
      if (res?.missing > 0) {
        setError(`${res.deleted} deleted. ${res.missing} were already gone.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkDeleting(false);
    }
  };

  // Import matches on SKU: known SKUs are updated, new ones created. That makes
  // a re-import of the same file safe, so a partly-rejected import can simply
  // be fixed and run again rather than needing the good rows stripped out.
  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (
      !confirm(
        `Import "${file.name}"?\n\n` +
          "Rows whose SKU already exists will be updated; new SKUs will be added. " +
          "Nothing is deleted. Quantity changes are recorded in each item's History."
      )
    ) {
      return;
    }
    setImporting(true);
    setError("");
    setImportResult(null);
    try {
      const dataUrl = await readFileAsDataUrl(file, 8_000_000);
      const res = await api.post("/inventory/import", { file_data: dataUrl });
      setImportResult(res);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
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
  // Defaults to SKU ascending so the list opens in catalogue order rather than
  // whatever order the query happened to return. The comparison is numeric-
  // aware (see useSort), so INV-999 sorts before INV-1054 rather than after it
  // as a plain text sort would put it.
  const { sorted, sortKey, sortDir, toggleSort, setSort, arrow } = useSort(items, "sku", "asc");

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
          <button className="btn btn-secondary" onClick={() => importInputRef.current?.click()} disabled={importing}>
            {importing ? "Importing…" : "Import from Excel"}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleImport}
            style={{ display: "none" }}
          />
          <button className="btn" onClick={openAdd}>+ Add item</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Reports what the import did per outcome, and lists any rows it
          refused with the spreadsheet row number, so a rejected row can be
          found and corrected in the file itself. */}
      {importResult && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <strong>Import finished</strong>
            <span className="badge badge-approved">{importResult.created} added</span>
            <span className="badge badge-active">{importResult.updated} updated</span>
            {importResult.quantity_adjustments > 0 && (
              <span className="badge badge-pending">{importResult.quantity_adjustments} quantity changes</span>
            )}
            {importResult.skipped > 0 && (
              <span className="badge badge-inactive">{importResult.skipped} skipped</span>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" className="link-btn" onClick={() => setImportResult(null)}>Dismiss</button>
          </div>
          {importResult.errors?.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 20, fontSize: 13, color: "var(--text-muted)" }}>
              {importResult.errors.slice(0, 15).map((er, i) => (
                <li key={i}>
                  Row {er.row}{er.sku ? ` (${er.sku})` : ""} — {er.message}
                </li>
              ))}
              {importResult.errors.length > 15 && <li>…and {importResult.errors.length - 15} more</li>}
            </ul>
          )}
        </div>
      )}

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
        {/* Column headers stay clickable for every field; this is here because
            SKU order is the one people look for by name, and a header click
            isn't discoverable. "Custom" appears only when another column is
            driving the sort, so the control never misreports the order. */}
        <div className="form-row">
          <label>Sort by SKU</label>
          <select
            value={sortKey === "sku" ? sortDir : "other"}
            onChange={(e) => setSort("sku", e.target.value === "desc" ? "desc" : "asc")}
          >
            <option value="asc">SKU — ascending (1 → 9)</option>
            <option value="desc">SKU — descending (9 → 1)</option>
            {sortKey !== "sku" && <option value="other">Custom (sorted by another column)</option>}
          </select>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 20 }}>
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      {/* Only appears once something is ticked, so a destructive control isn't
          sitting armed on the page during ordinary browsing. */}
      {selectedIds.length > 0 && (
        <div
          className="card"
          style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}
        >
          <strong>{selectedIds.length} selected</strong>
          <button type="button" className="link-btn" onClick={() => setSelectedIds([])}>
            Clear selection
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
          >
            {bulkDeleting ? "Deleting…" : `Delete ${selectedIds.length} selected`}
          </button>
        </div>
      )}

      <div className="card card-wide">
        <table className="sticky-head">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  aria-label="Select all items shown"
                  // Ticks only what's currently listed, so it respects the
                  // search and low-stock filters rather than silently
                  // selecting rows that aren't on screen.
                  checked={sorted.length > 0 && sorted.every((i) => selectedIds.includes(i.id))}
                  ref={(el) => {
                    if (el) {
                      const n = sorted.filter((i) => selectedIds.includes(i.id)).length;
                      el.indeterminate = n > 0 && n < sorted.length;
                    }
                  }}
                  onChange={(e) =>
                    setSelectedIds(e.target.checked ? sorted.map((i) => i.id) : [])
                  }
                />
              </th>
              <SortTh label="SKU" sortKey="sku" toggleSort={toggleSort} arrow={arrow} className="col-sku" />
              <SortTh label="Name" sortKey="name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Category" sortKey="category" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="On hand" sortKey="quantity_on_hand" toggleSort={toggleSort} arrow={arrow} className="col-qty" />
              <SortTh label="Reorder level" sortKey="reorder_level" toggleSort={toggleSort} arrow={arrow} className="col-qty" />
              <SortTh label="Unit cost" sortKey="unit_cost" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Stock value" sortKey="total_value" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Location" sortKey="location_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="stock_status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) => (
              <tr key={i.id} className={selectedIds.includes(i.id) ? "row-selected" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${i.name}`}
                    checked={selectedIds.includes(i.id)}
                    onChange={(e) =>
                      setSelectedIds((prev) =>
                        e.target.checked ? [...prev, i.id] : prev.filter((id) => id !== i.id)
                      )
                    }
                  />
                </td>
                <td className="col-sku" title={i.sku}><span>{i.sku}</span></td>
                <td>{i.name}</td>
                <td>{i.category || "—"}</td>
                <td className="col-qty" title={`${i.quantity_on_hand} ${i.unit}`}><span>{i.quantity_on_hand} {i.unit}</span></td>
                <td className="col-qty" title={`${i.reorder_level} ${i.unit}`}><span>{i.reorder_level} {i.unit}</span></td>
                <td>{money(i.unit_cost)}</td>
                <td>{money(i.total_value)}</td>
                <td>{i.location_name || "—"}</td>
                <td>{statusBadge(i.stock_status)}</td>
                <td>
                  <div className="col-actions">
                  <button className="btn btn-sm" onClick={() => openStock(i, "in")}>Stock in</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openStock(i, "out")}>Stock out</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openStock(i, "adjust")}>Adjust</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openHistory(i)}>History</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(i)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(i.id)}>Delete</button>
                  </div>
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
                <SuggestInput field="item_category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Unit</label>
                <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pcs, box, kg…" />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  Just the unit of measure — put the quantity in the field beside it, not here.
                </p>
              </div>
              {/* Shown when creating and when editing. A correction here is
                  still written to the item's History as an adjustment rather
                  than overwriting the stock level, so the ledger continues to
                  explain every change — routine movements should still go
                  through Stock in / Stock out. */}
              <div className="form-row">
                <label>Quantity on hand</label>
                <input
                  type="number"
                  min="0"
                  value={form.quantity_on_hand}
                  onChange={(e) => setForm({ ...form, quantity_on_hand: e.target.value })}
                  placeholder="0"
                />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  {editingId
                    ? "Correcting this records an adjustment in the item's History. For routine stock movement use Stock in / Stock out."
                    : "How many you have right now. Recorded as an opening balance."}
                </p>
              </div>
              <div className="form-row">
                <label>Reorder level</label>
                <input type="number" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })} />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  Alerts you when stock falls this low. Leave at 0 for no alert.
                </p>
              </div>
              {/* Cost, margin and price are three views of the same pair of
                  numbers. Editing any one updates the others so the trio is
                  never left contradicting itself — margin and price follow the
                  cost, and typing a price over the top re-derives the margin. */}
              <div className="form-row">
                <label>Unit cost ({currencySymbol})</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.unit_cost}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, unit_cost: e.target.value, unit_price: priceFromMargin(e.target.value, f.margin, f.unit_price) }))
                  }
                />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  What you pay per {form.unit || "unit"}.
                </p>
              </div>
              <div className="form-row">
                <label>Margin % (of selling price)</label>
                <input
                  type="number"
                  step="0.1"
                  value={form.margin}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, margin: e.target.value, unit_price: priceFromMargin(f.unit_cost, e.target.value, f.unit_price) }))
                  }
                />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  The share of the selling price kept as gross profit. Must be under 100%.
                  Default {DEFAULT_MARGIN}%.
                </p>
              </div>
              <div className="form-row">
                <label>Unit price ({currencySymbol})</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.unit_price}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, unit_price: e.target.value, margin: marginFromPrice(f.unit_cost, e.target.value, f.margin) }))
                  }
                />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  {Number(form.unit_price) > 0
                    ? `${moneyPrecise(Number(form.unit_cost) || 0)} cost → ${moneyPrecise(Number(form.unit_price))} price, ` +
                      `${moneyPrecise(Number(form.unit_price) - (Number(form.unit_cost) || 0))} gross profit per ${form.unit || "unit"}`
                    : "Type a price directly, or enter a unit cost and margin to have it calculated."}
                </p>
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
