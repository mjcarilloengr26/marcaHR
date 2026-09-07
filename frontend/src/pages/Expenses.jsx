import { Fragment, useEffect, useRef, useState } from "react";
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
// What the Balance column says, which depends on how the claim was funded.
//
// Out of pocket: the report itself creates the debt and the company owes it.
//
// Funded by an advance: the cash left the company when the advance was
// released, so this report settles nothing on its own — the position is on the
// advance, and it is the same figure for every report drawing on it. Showing
// "advance minus this report" instead made three of Laiza's claims against one
// 2,000 advance read as 4,102 owed.
function balanceLabel(report, money) {
  if (!report.advance_reference) {
    if (report.balance > 0) return `${money(report.balance)} due to company`;
    if (report.balance < 0) return `${money(-report.balance)} due to employee`;
    return money(0);
  }
  const left = Number(report.advance_outstanding) || 0;
  if (left > 0) return `${money(left)} unspent on ${report.advance_reference}`;
  if (left < 0) return `${money(-left)} over ${report.advance_reference} — due to employee`;
  return `${report.advance_reference} fully liquidated`;
}

// One dialog creates the report and its lines together.
//
// It used to take two: a first modal made an empty draft, then the report had
// to be opened and a second modal filled in line by line. That left a report
// in the database before it had anything on it, which is where the phantom
// drafts came from — and the running total against the advance could not be
// shown while filling it in, because the lines were added after the fact.
const blankLine = () => ({
  key: Math.random().toString(36).slice(2),
  expense_date: new Date().toISOString().slice(0, 10),
  category: "",
  category_other: "",
  description: "",
  amount: "",
  receipt: null,
  // Receipt metadata: who was paid, where, and their TIN. Optional, but it has
  // to be enterable — a printed receipt is the only evidence behind the claim,
  // and its supplier details are what makes the claim auditable.
  receipt_ref: "",
  supplier_name: "",
  supplier_address: "",
  supplier_tin: "",
  showDetails: false,
});

const EMPTY_FORM = { expense_type: "", cash_advance_amount: "", cost_center: "", notes: "", cash_advance_id: "" };
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
  const [lines, setLines] = useState([blankLine()]);
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  // Never removes the last one: a report with no lines is the empty draft this
  // dialog exists to stop creating.
  const dropLine = (key) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  // Suppliers already used, with the address and TIN last recorded for each.
  // Picking a known name fills the rest of the line in, which is the point: the
  // live data already held one company under two spellings with its TIN retyped
  // by hand each time.
  const [suppliers, setSuppliers] = useState([]);
  useEffect(() => {
    let alive = true;
    api
      .get("/suggestions/suppliers")
      .then((rows) => { if (alive) setSuppliers(rows || []); })
      // The form works perfectly without them; a failed lookup must never stop
      // somebody entering a receipt by hand.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Fills address and TIN from a known supplier, but only where the field is
  // empty or still holds what a previous auto-fill put there — silently
  // overwriting an address someone had corrected would be worse than not
  // filling it at all.
  const setLineSupplier = (key, name) => {
    const match = suppliers.find((sup) => (sup.name || "").trim().toLowerCase() === name.trim().toLowerCase());
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, supplier_name: name };
        if (!match) return next;
        if (!l.supplier_address.trim() || l.supplier_address === l._filledAddress) {
          next.supplier_address = match.address || "";
        }
        if (!l.supplier_tin.trim() || l.supplier_tin === l._filledTin) {
          next.supplier_tin = match.tin || "";
        }
        next._filledAddress = next.supplier_address;
        next._filledTin = next.supplier_tin;
        return next;
      })
    );
  };

  const attachToLine = async (key, file) => {
    if (!file) return;
    try {
      const data = file.type.startsWith("image/") ? await compressImageFile(file, 1400, 0.8) : await readFileAsDataUrl(file);
      setLine(key, { receipt: { name: file.name, type: file.type, data } });
    } catch (err) {
      setError(err.message);
    }
  };
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [search, setSearch] = useState("");

  const [options, setOptions] = useState({ types: [], titles: [], categories: [] });
  // Cost centres are a managed list an admin maintains — staff pick from it and
  // cannot invent one, so the same spend cannot arrive under three spellings
  // and slip past whichever budget was meant to catch it.
  const [costCenters, setCostCenters] = useState([]);
  useEffect(() => {
    api.get("/expenses/options").then(setOptions).catch(() => {});
    api.get("/cost-centers/options").then(setCostCenters).catch(() => {});
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

  const lineTotal = lines.reduce((n, l) => n + (Number(l.amount) || 0), 0);
  const selectedAdvance = openAdvances.find((a) => String(a.id) === String(form.cash_advance_id)) || null;
  // dueToCompany is what the employee still holds — the advance less everything
  // already liquidated against it — which is the figure the dropdown shows as
  // "left" and the only one this report can be measured against.
  const advanceLeft = selectedAdvance ? Number(selectedAdvance.dueToCompany) || 0 : 0;

  const openForm = () => {
    setForm(EMPTY_FORM);
    setLines([blankLine()]);
    setError("");
    setShowForm(true);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const report = await api.post("/expenses", {
        expense_type: form.expense_type,
        cash_advance_amount: form.cash_advance_amount ? Number(form.cash_advance_amount) : 0,
        cost_center: form.cost_center,
        notes: form.notes,
        cash_advance_id: form.cash_advance_id ? Number(form.cash_advance_id) : null,
        // The report's title is derived from these categories server-side, so
        // it is not sent — asking for it here is what made the form put the
        // same question twice.
        items: lines.map((l) => ({
          expense_date: l.expense_date,
          category: l.category,
          category_other: l.category_other,
          description: l.description,
          amount: Number(l.amount) || 0,
          receipt_name: l.receipt?.name,
          receipt_type: l.receipt?.type,
          receipt_data: l.receipt?.data,
          receipt_ref: l.receipt_ref,
          supplier_name: l.supplier_name,
          supplier_address: l.supplier_address,
          supplier_tin: l.supplier_tin,
        })),
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      setLines([blankLine()]);
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
        <button className="btn" onClick={openForm}>
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
                  single value to sort a row by. th-plain keeps it the same
                  colour as the sortable headings either way. */}
              <th className="th-plain">Category</th>
              <th className="th-plain">Cost center</th>
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
                  {balanceLabel(r, money)}
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
          <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
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
            {/* Two kinds of claim. Liquidating accounts for money already
                handed over; a reimbursement is out of pocket and needs no
                advance — requiring one would mean nobody could claim back a
                taxi fare without asking for cash first. Either way there is no
                amount to type here: it comes from the advance, or from the
                receipts. */}
            <div className="grid grid-2">
              <div className="form-row">
                <label>Cash advance being liquidated</label>
                <select
                  value={form.cash_advance_id}
                  // Deliberately does not touch the cost centre: one advance can
                  // fund several projects, so carrying its cost centre across
                  // would quietly file work against the wrong one.
                  onChange={(e) => setForm({ ...form, cash_advance_id: e.target.value, cash_advance_amount: "" })}
                >
                  <option value="">None — reimbursement, paid out of pocket</option>
                  {openAdvances.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.reference} — {a.employee_name}
                      {a.purpose ? ` · ${a.purpose}` : ""} · {money(a.dueToCompany)} left
                    </option>
                  ))}
                </select>
                <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                  {openAdvances.length === 0
                    ? "No approved advance available — this will be filed as a reimbursement."
                    : "Leave as None to claim money back rather than account for an advance."}
                </div>
              </div>
              <div className="form-row">
                <label>Cost center</label>
                {/* Mandatory: every cost breakdown on the dashboard groups by
                    cost centre, and a blank becomes an "Unspecified" slice
                    that nobody can act on. Disabled placeholder rather than a
                    "None" option, so the form cannot be submitted without a
                    choice but also never silently picks the first one. */}
                <select
                  value={form.cost_center}
                  onChange={(e) => setForm({ ...form, cost_center: e.target.value })}
                  required
                >
                  <option value="" disabled>Select cost center…</option>
                  {costCenters.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}{c.code ? ` · ${c.code}` : ""}
                    </option>
                  ))}
                </select>
                <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                  {costCenters.length === 0
                    ? "No cost centers set up yet — an admin adds them under Administration."
                    : "Required. Set up by an admin — ask for a new one rather than filing under the nearest match."}
                </div>
              </div>
            </div>
            <h2 style={{ fontSize: 15, marginTop: 18, marginBottom: 2 }}>Expenses</h2>
            <p className="subtitle" style={{ margin: "0 0 10px" }}>
              At least one line. The report's title comes from these categories, so it is never asked for twice.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="th-plain" style={{ minWidth: 140 }}>Date</th>
                    <th className="th-plain" style={{ minWidth: 170 }}>Category</th>
                    <th className="th-plain" style={{ minWidth: 160 }}>Description</th>
                    <th className="th-plain" style={{ minWidth: 120 }}>Amount</th>
                    <th className="th-plain" style={{ minWidth: 130 }}>Receipt</th>
                    <th style={{ width: 44 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <Fragment key={l.key}>
                    <tr>
                      <td>
                        <input
                          type="date"
                          value={l.expense_date}
                          onChange={(e) => setLine(l.key, { expense_date: e.target.value })}
                          required
                        />
                      </td>
                      <td>
                        <select
                          value={l.category}
                          onChange={(e) =>
                            setLine(l.key, {
                              category: e.target.value,
                              category_other: e.target.value === "Others" ? l.category_other : "",
                            })
                          }
                          required
                          autoFocus={i === 0}
                        >
                          <option value="" disabled>Select category…</option>
                          {options.categories.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {l.category === "Others" && (
                          <input
                            value={l.category_other}
                            onChange={(e) => setLine(l.key, { category_other: e.target.value })}
                            placeholder="Say what it was"
                            required
                            style={{ marginTop: 6 }}
                          />
                        )}
                      </td>
                      <td>
                        <input
                          value={l.description}
                          onChange={(e) => setLine(l.key, { description: e.target.value })}
                          placeholder="What it was for"
                        />
                      </td>
                      <td>
                        <DecimalInput
                          value={l.amount}
                          onChange={(e) => setLine(l.key, { amount: e.target.value })}
                          placeholder="0.00"
                          required
                        />
                      </td>
                      <td>
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          style={{ display: "none" }}
                          id={`line-receipt-${l.key}`}
                          onChange={(e) => attachToLine(l.key, e.target.files?.[0])}
                        />
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <label
                            htmlFor={`line-receipt-${l.key}`}
                            className={`btn btn-sm ${l.receipt ? "" : "btn-secondary"}`}
                            style={{ cursor: "pointer", display: "inline-block" }}
                            title={l.receipt?.name || "Attach a photo or PDF"}
                          >
                            {l.receipt ? "Attached" : "Attach"}
                          </label>
                          {/* Marked when anything is filled in, so a collapsed
                              row still says whether it carries receipt details. */}
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => setLine(l.key, { showDetails: !l.showDetails })}
                            title="Receipt number, supplier, address and TIN"
                          >
                            {l.supplier_name || l.supplier_tin || l.receipt_ref ? "Details ✓" : "Details"}
                          </button>
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => dropLine(l.key)}
                          disabled={lines.length === 1}
                          title={lines.length === 1 ? "A report needs at least one line" : "Remove this line"}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                    {l.showDetails && (
                      <tr key={`${l.key}-details`}>
                        {/* Receipt metadata lives under its own line rather than
                            in four more columns: the table already carries six
                            and a receipt's supplier is not something you scan
                            across rows, it is something you fill in once for
                            the line you are looking at. Optional — a great many
                            legitimate expenses have no official receipt. */}
                        <td colSpan={6} style={{ paddingTop: 0 }}>
                          <div className="grid grid-2" style={{ gap: 10, padding: "2px 0 10px" }}>
                            <div className="form-row">
                              <label>Receipt #</label>
                              <input
                                value={l.receipt_ref}
                                onChange={(e) => setLine(l.key, { receipt_ref: e.target.value })}
                                placeholder="As printed on the receipt"
                              />
                            </div>
                            <div className="form-row">
                              <label>Supplier / company</label>
                              <SuggestInput
                                field="supplier_name"
                                options={suppliers.map((sup) => sup.name)}
                                value={l.supplier_name}
                                onChange={(e) => setLineSupplier(l.key, e.target.value)}
                                placeholder="Who was paid"
                              />
                            </div>
                            <div className="form-row">
                              <label>Supplier address</label>
                              <SuggestInput
                                field="supplier_address"
                                value={l.supplier_address}
                                onChange={(e) => setLine(l.key, { supplier_address: e.target.value })}
                              />
                            </div>
                            <div className="form-row">
                              <label>Supplier TIN</label>
                              <SuggestInput
                                field="supplier_tin"
                                value={l.supplier_tin}
                                onChange={(e) => setLine(l.key, { supplier_tin: e.target.value })}
                                placeholder="000-000-000-000"
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addLine}>
                + Add line
              </button>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{money(lineTotal)}</div>
                {/* The reckoning shown while it is still being typed, which the
                    two-modal flow could not do: the lines did not exist yet. */}
                <div className="subtitle" style={{ margin: 0, fontSize: 12 }}>
                  {lines.length} line{lines.length === 1 ? "" : "s"}
                  {/* Measured against what is *left* on the advance, not its
                      original amount. Other reports may already have drawn on
                      it, and comparing to the gross figure told somebody they
                      were inside an advance that had nothing left in it. */}
                  {selectedAdvance
                    ? lineTotal <= advanceLeft
                      ? ` · ${money(advanceLeft - lineTotal)} would remain unspent on ${selectedAdvance.reference}`
                      : ` · ${money(lineTotal - advanceLeft)} more than is left on ${selectedAdvance.reference}, due back to you`
                    : " · claimed back from the company"}
                </div>
              </div>
            </div>
            <div className="form-row" style={{ marginTop: 14 }}>
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Saving…" : `Create report · ${money(lineTotal)}`}
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
  const { user } = useAuth();
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

  // The one form does both jobs. A separate inline row editor would mean two
  // copies of every field and two places for the category rules to drift.
  const [editingItemId, setEditingItemId] = useState(null);

  const startEditItem = (it) => {
    setError("");
    setEditingItemId(it.id);
    setItemForm({
      expense_date: it.expense_date || "",
      // A stored value that is no longer on the list — an older free-text
      // category — would leave the select blank and silently change on save.
      // Route it through "Others" with the original text kept instead.
      category: options.categories.includes(it.category) ? it.category : it.category ? "Others" : "",
      category_other: options.categories.includes(it.category) ? "" : it.category || "",
      description: it.description || "",
      amount: it.amount == null ? "" : String(it.amount),
      receipt_ref: it.receipt_ref || "",
      supplier_name: it.supplier_name || "",
      supplier_address: it.supplier_address || "",
      supplier_tin: it.supplier_tin || "",
    });
    // Leaving the picker empty keeps whatever is already attached; picking a
    // file replaces it.
    setReceipt(null);
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
    setItemForm(EMPTY_ITEM_FORM);
    setReceipt(null);
  };

  const addItem = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      // "Others" is a prompt for the real name, not a category to store — a
      // column full of "Others" would be the free-text problem again wearing
      // a different label. category_other never reaches the server.
      const payload = {
        ...itemForm,
        amount: Number(itemForm.amount),
        receipt_name: receipt?.name,
        receipt_type: receipt?.type,
        receipt_data: receipt?.data,
      };
      if (editingItemId) await api.put(`/expenses/items/${editingItemId}`, payload);
      else await api.post(`/expenses/${id}/items`, payload);
      setEditingItemId(null);
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

  // Owner or HR, and only from rejected — matching what the server allows, so
  // the button is never offered where it would be refused.
  const canReopen = report && report.status === "rejected" && (isHr || report.employee_id === user?.employee_id);
  const [reopening, setReopening] = useState(false);

  const reopenReport = async () => {
    setReopening(true);
    setError("");
    try {
      await api.put(`/expenses/${id}/reopen`, {});
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setReopening(false);
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
                  {balanceLabel(report, money)}
                </div>
              </div>
              {report.notes && <div><strong>Notes</strong><div>{report.notes}</div></div>}
            </div>

            {report.review_note && report.status === "rejected" && (
              <div className="error-banner" style={{ marginTop: 4 }}>
                <strong>Sent back:</strong> {report.review_note}
              </div>
            )}
            {report.review_note && report.status !== "rejected" && (
              <div className="subtitle" style={{ margin: "0 0 12px" }}>
                Reviewer's note: {report.review_note}
              </div>
            )}

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
                        <div className="col-actions">
                          <button className="link-btn" onClick={() => startEditItem(it)}>
                            {editingItemId === it.id ? "Editing…" : "Edit"}
                          </button>
                          <button className="link-btn" onClick={() => removeItem(it.id)}>
                            Remove
                          </button>
                        </div>
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
                  {saving ? (editingItemId ? "Saving…" : "Adding…") : editingItemId ? "Save changes" : "+ Add item"}
                </button>
                {editingItemId && (
                  <button type="button" className="link-btn" onClick={cancelEditItem} style={{ marginLeft: 10 }}>
                    Cancel
                  </button>
                )}
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
                {/* A rejection used to be terminal: the report froze and the
                    only way to claim the money was to type it all again.
                    Reopening returns it to draft, where the existing edit and
                    submit flow already works. */}
                {canReopen && (
                  <button className="btn" disabled={reopening} onClick={reopenReport}>
                    {reopening ? "Reopening…" : "Edit & resubmit"}
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
