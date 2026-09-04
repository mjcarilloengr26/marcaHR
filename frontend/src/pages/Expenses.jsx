import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import SuggestInput from "../components/SuggestInput";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import { compressImageFile, readFileAsDataUrl } from "../utils/image";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

// The vocabularies come from the server (GET /expenses/options), which is also
// what enforces them on write. Holding a second copy here is how the list on
// screen drifts from the list that is actually accepted, so there isn't one.
const EMPTY_FORM = { title: "", title_other: "", expense_type: "", cash_advance_amount: "", cost_center: "", notes: "", cash_advance_id: "" };
const EMPTY_ITEM_FORM = {
  expense_date: "",
  category: "",
  category_other: "",
  description: "",
  amount: "",
  receipt_ref: "",
  supplier_name: "",
  supplier_address: "",
  supplier_tin: "",
};

export default function Expenses() {
  const { user } = useAuth();
  // Expense figures keep two decimals — they're reconciled to the centavo.
  const { moneyPrecise: money } = useAppSettings();
  const isHr = user.role === "admin" || user.role === "hr";
  const [reports, setReports] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [search, setSearch] = useState("");

  const [options, setOptions] = useState({ types: [], titles: [], categories: [] });
  useEffect(() => {
    api.get("/expenses/options").then(setOptions).catch(() => {});
  }, []);

  const load = () => api.get("/expenses").then(setReports).catch((err) => setError(err.message));

  // Open advances this person can liquidate. An employee gets their own; HR
  // gets everyone's, filtered client-side once a report's owner is known.
  const [openAdvances, setOpenAdvances] = useState([]);
  useEffect(() => {
    api
      .get("/cash-advances?status=open")
      .then(setOpenAdvances)
      .catch(() => {});
  }, []);

  // Deleting from the list is an HR/admin tool. The server would also accept an
  // employee removing their own draft, but employee-facing access is deliberately
  // left as it was — clearing out abandoned reports is an administrative job.
  const canDelete = () => isHr;

  const [deletingId, setDeletingId] = useState(null);

  const deleteReport = async (r) => {
    if (
      !confirm(
        `Delete "${r.title}"?

` +
          "Its expense items and any attached receipts go with it. This cannot be undone."
      )
    ) {
      return;
    }
    setDeletingId(r.id);
    setError("");
    try {
      await api.del(`/expenses/${r.id}`);
      if (openId === r.id) setOpenId(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // Ids ticked for bulk removal. Only rows canDelete() allows ever enter this
  // set, so the bulk action can never ask for something the server refuses.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const deleteSelected = async () => {
    const targets = reports.filter((r) => selected.has(r.id) && canDelete(r));
    if (targets.length === 0) return;
    if (
      !confirm(
        `Delete ${targets.length} report${targets.length === 1 ? "" : "s"}?

` +
          "Their expense items and any attached receipts go with them. This cannot be undone."
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setError("");
    // One at a time rather than in parallel: a partial failure then leaves a
    // clear picture of what went, and the list is small enough that the wait
    // is not worth the risk of a burst of concurrent deletes.
    const failed = [];
    for (const r of targets) {
      try {
        await api.del(`/expenses/${r.id}`);
        if (openId === r.id) setOpenId(null);
      } catch (err) {
        failed.push(`${r.title}: ${err.message}`);
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    if (failed.length) {
      setError(`${failed.length} of ${targets.length} could not be deleted — ${failed.join("; ")}`);
    }
    load();
  };

  useEffect(() => {
    load();
  }, []);

  // Reports deleted here or elsewhere must not linger as phantom ticks that
  // inflate the selected count.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(reports.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [reports]);

  const filteredReports = reports.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    // Category is searchable too, so "transport" finds the reports containing
    // transport lines rather than only ones titled that.
    const categories = (r.categories || []).map((c) => c.category).join(" ");
    return [r.employee_name, r.title, r.expense_type, r.cost_center, r.status, categories]
      .some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredReports, "created_at", "desc");

  // Select-all covers what is on screen, not what the search has hidden.
  const selectableVisible = sorted.filter(canDelete);
  const selectedVisible = selectableVisible.filter((r) => selected.has(r.id));
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisible.length === selectableVisible.length;

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) selectableVisible.forEach((r) => next.delete(r.id));
      else selectableVisible.forEach((r) => next.add(r.id));
      return next;
    });

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const report = await api.post("/expenses", {
        title: form.title,
        title_other: form.title_other,
        expense_type: form.expense_type,
        cash_advance_amount: form.cash_advance_amount ? Number(form.cash_advance_amount) : 0,
        cost_center: form.cost_center,
        notes: form.notes,
        cash_advance_id: form.cash_advance_id ? Number(form.cash_advance_id) : null,
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
      setOpenId(report.id);
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
          <h1>Liquidation &amp; Expense Reports</h1>
          <p className="subtitle">{isHr ? "Review cash advance liquidations and expense claims" : "Liquidate cash advances and submit expense claims"}</p>
        </div>
        <button className="btn" onClick={() => setShowForm(true)}>
          + New report
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by employee, title, cost center, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Only appears once something is ticked, so a destructive control isn't
          sitting armed on the page during ordinary browsing. */}
      {selected.size > 0 && (
        <div
          className="card"
          style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}
        >
          <strong>{selected.size} selected</strong>
          <button type="button" className="link-btn" disabled={bulkDeleting} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={deleteSelected}
            disabled={bulkDeleting}
          >
            {bulkDeleting ? "Deleting…" : `Delete ${selected.size} selected`}
          </button>
        </div>
      )}

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all reports shown"
                    disabled={selectableVisible.length === 0}
                    checked={allVisibleSelected}
                    ref={(el) => {
                      // Part-selected reads as a dash, so "select all" is never
                      // mistaken for "everything is already ticked".
                      if (el) el.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                  />
                </th>
              )}
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Type" sortKey="expense_type" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Title" sortKey="title" toggleSort={toggleSort} arrow={arrow} />
              {/* Not sortable: a report has several categories, so there is no
                  single value to sort a row by. */}
              <th>Category</th>
              <th>Cost center</th>
              <SortTh label="Cash advance" sortKey="cash_advance_amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Expenses" sortKey="total_expenses" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Balance" sortKey="balance" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Date created" sortKey="created_at" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? "row-selected" : undefined}>
                {isHr && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.title}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                    />
                  </td>
                )}
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.expense_type || "—"}</td>
                <td>{r.title}</td>
                {/* What the report was actually spent on, biggest first. A
                    report is 1.7 categories on average and four at most in the
                    live data, so the whole split fits without truncation. */}
                <td>
                  {(r.categories || []).length === 0 ? (
                    <span className="subtitle">—</span>
                  ) : (
                    <div className="cat-breakdown">
                      {r.categories.map((c) => (
                        <div key={c.category} className="cat-breakdown-row">
                          <span className="cat-breakdown-name" title={`${c.items} item${c.items === 1 ? "" : "s"}`}>
                            {c.category}
                          </span>
                          <span className="cat-breakdown-amount">{money(c.total)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{r.cost_center || "—"}</td>
                <td>
                  {r.advance_reference ? (
                    <>
                      {money(r.advance_amount)}
                      <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>from {r.advance_reference}</div>
                    </>
                  ) : (
                    money(r.cash_advance_amount)
                  )}
                </td>
                <td>{money(r.total_expenses)}</td>
                <td>
                  {r.balance > 0 ? `${money(r.balance)} due to company` : r.balance < 0 ? `${money(-r.balance)} due to employee` : money(0)}
                </td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                {/* Stored as UTC "YYYY-MM-DD HH:MM:SS"; only the day is useful
                    in a list this wide, and the full stamp is on hover. */}
                <td title={r.created_at || ""} style={{ whiteSpace: "nowrap" }}>
                  {r.created_at ? r.created_at.slice(0, 10) : "—"}
                </td>
                <td>
                  <div className="col-actions">
                    <button className="link-btn" onClick={() => setOpenId(r.id)}>
                      Open →
                    </button>
                    {canDelete(r) && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deletingId === r.id}
                        onClick={() => deleteReport(r)}
                      >
                        {deletingId === r.id ? "Deleting…" : "Delete"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reports.length === 0 && <div className="empty-state">No expense reports yet.</div>}
        {reports.length > 0 && sorted.length === 0 && <div className="empty-state">No reports match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h2>New liquidation / expense report</h2>
            <div className="form-row">
              <label>Expenses type</label>
              <select
                value={form.expense_type}
                onChange={(e) => setForm({ ...form, expense_type: e.target.value })}
                required
                autoFocus
              >
                <option value="" disabled>Select type</option>
                {options.types.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Title / purpose</label>
              <select
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value, title_other: e.target.value === "Others" ? form.title_other : "" })}
                required
              >
                <option value="" disabled>Select purpose</option>
                {options.titles.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            {form.title === "Others" && (
              <div className="form-row">
                <label>Please specify</label>
                <SuggestInput
                  field="expense_title"
                  value={form.title_other}
                  onChange={(e) => setForm({ ...form, title_other: e.target.value })}
                  placeholder="Describe the purpose"
                  required
                />
              </div>
            )}
            {/* Either this report liquidates money already released, or it
                carries its own advance. Both at once would count the same
                money twice, so choosing an advance hides the amount field. */}
            {openAdvances.length > 0 && (
              <div className="form-row">
                <label>Liquidating a cash advance?</label>
                <select
                  value={form.cash_advance_id}
                  onChange={(e) => setForm({ ...form, cash_advance_id: e.target.value, cash_advance_amount: "" })}
                >
                  <option value="">No — this report has its own advance</option>
                  {openAdvances.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.reference} — {a.employee_name}
                      {a.purpose ? ` · ${a.purpose}` : ""} · {money(a.dueToCompany)} left
                    </option>
                  ))}
                </select>
              </div>
            )}
            {!form.cash_advance_id && (
              <div className="form-row">
                <label>Cash advance amount</label>
                <DecimalInput
                  value={form.cash_advance_amount}
                  onChange={(e) => setForm({ ...form, cash_advance_amount: e.target.value })}
                  placeholder="0.00"
                />
              </div>
            )}
            <div className="form-row">
              <label>Cost center</label>
              <SuggestInput
                field="cost_center"
                value={form.cost_center}
                onChange={(e) => setForm({ ...form, cost_center: e.target.value })}
                placeholder="e.g. Sales, Engineering, CC-100"
              />
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Creating…" : "Create report"}
              </button>
            </div>
          </form>
        </div>
      )}

      {openId && (
        <ReportDetail
          id={openId}
          isHr={isHr}
          // Passed down rather than fetched again: the item form needs the
          // same category list the report form uses, and it lives here.
          options={options}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// options defaults rather than being assumed present: this component renders
// in a modal off a parent's state, and reading a list off undefined took the
// whole page blank once already.
function ReportDetail({ id, isHr, options = { types: [], titles: [], categories: [] }, onClose, onChanged }) {
  // Its own hook call — this is a separate component from Expenses above, so
  // it can't see that one's formatter.
  const { moneyPrecise: money } = useAppSettings();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM);
  // Suppliers already used, each with the address and TIN last recorded for
  // it. Picking a name fills the rest of the row in, which is the whole point:
  // the live data already holds one company under two spellings with the TIN
  // typed out by hand each time.
  const [suppliers, setSuppliers] = useState([]);
  useEffect(() => {
    let alive = true;
    api
      .get("/suggestions/suppliers")
      .then((rows) => { if (alive) setSuppliers(rows || []); })
      // The form is perfectly usable without the profiles; failing to load
      // them must not stop anyone entering a receipt by hand.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // What the last auto-fill wrote. Switching supplier replaces its own values,
  // but anything typed by hand is left exactly as it was — silently discarding
  // an address someone corrected would be worse than not filling at all.
  const autoFilled = useRef({ address: "", tin: "" });

  const setSupplierName = (name) => {
    const match = suppliers.find(
      (sup) => (sup.name || "").trim().toLowerCase() === name.trim().toLowerCase()
    );
    setItemForm((prev) => {
      const next = { ...prev, supplier_name: name };
      if (!match) return next;
      if (!prev.supplier_address.trim() || prev.supplier_address === autoFilled.current.address) {
        next.supplier_address = match.address || "";
      }
      if (!prev.supplier_tin.trim() || prev.supplier_tin === autoFilled.current.tin) {
        next.supplier_tin = match.tin || "";
      }
      autoFilled.current = { address: next.supplier_address, tin: next.supplier_tin };
      return next;
    });
  };

  const [receipt, setReceipt] = useState(null); // { name, type, data }
  const [attaching, setAttaching] = useState(false);
  // Item id whose receipt is being fetched, and the ones already fetched.
  const [fetchingReceipt, setFetchingReceipt] = useState(null);
  const receiptCache = useRef({});
  const [reviewNote, setReviewNote] = useState("");

  const load = () =>
    api
      .get(`/expenses/${id}`)
      .then(setReport)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const isOwnerEditable = report && report.status === "draft";
  const canEdit = report && (isHr || isOwnerEditable);

  const handleReceiptPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setAttaching(true);
    try {
      const data = file.type.startsWith("image/") ? await compressImageFile(file, 1400, 0.8) : await readFileAsDataUrl(file);
      setReceipt({ name: file.name, type: file.type, data });
    } catch (err) {
      setError(err.message);
    } finally {
      setAttaching(false);
    }
  };

  // The report no longer carries receipt bytes, so a receipt is fetched the
  // moment someone asks for it and then kept — reopening the same one in a
  // sitting shouldn't go back to the server.
  const openReceipt = async (item) => {
    setError("");
    let file = receiptCache.current[item.id];
    if (!file) {
      setFetchingReceipt(item.id);
      try {
        file = await api.get(`/expenses/${id}/items/${item.id}/receipt`);
        receiptCache.current[item.id] = file;
      } catch (err) {
        setError(err.message);
        return;
      } finally {
        setFetchingReceipt(null);
      }
    }
    // A data: URL can't be given to window.open in Chrome or Edge — they block
    // top-level navigation to data URLs. A synthesised anchor still works, and
    // keeps the original filename on the saved file.
    const a = document.createElement("a");
    a.href = file.receipt_data;
    a.download = file.receipt_name || "receipt";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const addItem = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      // "Others" is a prompt for the real name, not a category to store — a
      // column full of "Others" would be the free-text problem again wearing
      // a different label. category_other never reaches the server.
      await api.post(`/expenses/${id}/items`, {
        ...itemForm,
        amount: Number(itemForm.amount),
        receipt_name: receipt?.name,
        receipt_type: receipt?.type,
        receipt_data: receipt?.data,
      });
      setItemForm(EMPTY_ITEM_FORM);
      autoFilled.current = { address: "", tin: "" };
      setReceipt(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (itemId) => {
    try {
      await api.del(`/expenses/items/${itemId}`);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitReport = async () => {
    try {
      await api.put(`/expenses/${id}/submit`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  const setStatus = async (status) => {
    try {
      await api.put(`/expenses/${id}/status`, { status, review_note: reviewNote || undefined });
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteReport = async () => {
    if (!confirm("Delete this report?")) return;
    try {
      await api.del(`/expenses/${id}`);
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        {!report ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <>
            <div className="page-header" style={{ marginBottom: 12 }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>{report.title}</h2>
                <p className="subtitle" style={{ margin: 0 }}>
                  {report.employee?.first_name} {report.employee?.last_name}
                </p>
              </div>
              <span className={`badge badge-${report.status}`}>{report.status}</span>
            </div>

            {error && <div className="error-banner">{error}</div>}

            <div className="grid grid-2" style={{ marginBottom: 16 }}>
              <div><strong>Cash advance</strong><div>{money(report.cash_advance_amount)}</div></div>
              <div><strong>Total expenses</strong><div>{money(report.total_expenses)}</div></div>
              <div><strong>Expenses type</strong><div>{report.expense_type || "—"}</div></div>
              <div><strong>Cost center</strong><div>{report.cost_center || "—"}</div></div>
              <div>
                <strong>Balance</strong>
                <div>
                  {report.balance > 0
                    ? `${money(report.balance)} due to company`
                    : report.balance < 0
                    ? `${money(-report.balance)} due to employee`
                    : money(0)}
                </div>
              </div>
              {report.notes && <div><strong>Notes</strong><div>{report.notes}</div></div>}
            </div>

            <h2>Expense items</h2>
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Supplier</th>
                  <th>Receipt</th>
                  <th>Amount</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {report.items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.expense_date}</td>
                    <td>{it.category || "—"}</td>
                    {/* Address and TIN are on hover rather than in their own
                        columns — they matter at audit time, not at a glance. */}
                    <td>{it.description || "—"}</td>
                    <td title={[it.supplier_address, it.supplier_tin && `TIN ${it.supplier_tin}`].filter(Boolean).join(" · ")}>
                      {it.supplier_name || "—"}
                      {it.supplier_tin && (
                        <div className="subtitle" style={{ fontSize: 11 }}>TIN {it.supplier_tin}</div>
                      )}
                    </td>
                    <td>
                      {it.receipt_ref || ""}
                      {it.has_receipt && (
                        <button
                          type="button"
                          // link-btn supplies the button reset; location-link
                          // keeps the size and nowrap the anchor had.
                          className="link-btn location-link"
                          style={{ marginLeft: it.receipt_ref ? 6 : 0 }}
                          disabled={fetchingReceipt === it.id}
                          onClick={() => openReceipt(it)}
                        >
                          📎 {fetchingReceipt === it.id ? "Opening…" : it.receipt_name || "receipt"}
                        </button>
                      )}
                      {!it.receipt_ref && !it.has_receipt && "—"}
                    </td>
                    <td>{money(it.amount)}</td>
                    {canEdit && (
                      <td>
                        <button className="link-btn" onClick={() => removeItem(it.id)}>
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {report.items.length === 0 && <div className="empty-state">No items yet.</div>}

            {canEdit && (
              <form className="form-inline card" onSubmit={addItem} style={{ marginBottom: 16 }}>
                <div className="form-row">
                  <label>Date</label>
                  <input type="date" value={itemForm.expense_date} onChange={(e) => setItemForm({ ...itemForm, expense_date: e.target.value })} required />
                </div>
                <div className="form-row">
                  <label>Category</label>
                  <select
                    value={itemForm.category}
                    onChange={(e) =>
                      setItemForm({
                        ...itemForm,
                        category: e.target.value,
                        // Drop a typed-in value the moment the choice moves
                        // off "Others", so a stale one cannot be submitted.
                        category_other: e.target.value === "Others" ? itemForm.category_other : "",
                      })
                    }
                    required
                  >
                    <option value="" disabled>Select category…</option>
                    {options.categories.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
                {itemForm.category === "Others" && (
                  <div className="form-row">
                    <label>Which category?</label>
                    <input
                      value={itemForm.category_other}
                      onChange={(e) => setItemForm({ ...itemForm, category_other: e.target.value })}
                      placeholder="Only if none of the above fits"
                      required
                    />
                  </div>
                )}
                <div className="form-row" style={{ flex: 1 }}>
                  <label>Description</label>
                  <SuggestInput
                    field="expense_description"
                    value={itemForm.description}
                    onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Receipt #</label>
                  <input value={itemForm.receipt_ref} onChange={(e) => setItemForm({ ...itemForm, receipt_ref: e.target.value })} />
                </div>
                <div className="form-row">
                  <label>Supplier / company</label>
                  <SuggestInput
                    field="supplier_name"
                    options={suppliers.map((sup) => sup.name)}
                    value={itemForm.supplier_name}
                    onChange={(e) => setSupplierName(e.target.value)}
                    placeholder="Who was paid"
                  />
                </div>
                <div className="form-row">
                  <label>Supplier address</label>
                  <SuggestInput
                    field="supplier_address"
                    value={itemForm.supplier_address}
                    onChange={(e) => setItemForm({ ...itemForm, supplier_address: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Supplier TIN</label>
                  <SuggestInput
                    field="supplier_tin"
                    value={itemForm.supplier_tin}
                    onChange={(e) => setItemForm({ ...itemForm, supplier_tin: e.target.value })}
                    placeholder="000-000-000-000"
                  />
                </div>
                <div className="form-row">
                  <label>Amount</label>
                  <DecimalInput value={itemForm.amount} onChange={(e) => setItemForm({ ...itemForm, amount: e.target.value })} required />
                </div>
                <div className="form-row">
                  <label>Proof of receipt</label>
                  {receipt ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="subtitle" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        📎 {receipt.name}
                      </span>
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setReceipt(null)}>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <input type="file" accept="image/*,.pdf,.doc,.docx" onChange={handleReceiptPick} disabled={attaching} />
                  )}
                </div>
                <button type="submit" className="btn btn-sm" disabled={saving || attaching}>
                  {saving ? "Adding…" : "+ Add item"}
                </button>
              </form>
            )}

            {isHr && report.status === "submitted" && (
              <div className="form-row">
                <label>Review note (optional)</label>
                <textarea rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
              </div>
            )}

            <div className="modal-actions" style={{ justifyContent: "space-between" }}>
              <div>
                {isOwnerEditable && (
                  <button className="btn btn-danger btn-sm" onClick={deleteReport}>
                    Delete
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {isOwnerEditable && (
                  <button className="btn" onClick={submitReport}>
                    Submit for approval
                  </button>
                )}
                {isHr && report.status === "submitted" && (
                  <>
                    <button className="btn btn-danger" onClick={() => setStatus("rejected")}>
                      Reject
                    </button>
                    <button className="btn" onClick={() => setStatus("approved")}>
                      Approve
                    </button>
                  </>
                )}
                {isHr && report.status === "approved" && (
                  <button className="btn" onClick={() => setStatus("reimbursed")}>
                    Mark reimbursed
                  </button>
                )}
                <button className="btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
