import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { compressImageFile, readFileAsDataUrl } from "../utils/image";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EXPENSE_TYPE_OPTIONS = ["Operating Expenses", "Project Expenses"];
const EXPENSE_TITLE_OPTIONS = [
  "Fuel", "Parking", "Toll Fees", "Meals", "Maintenance", "Allowance",
  "Supplies", "Materials", "Labor", "Airfare", "Hotel", "Foods",
  "Equipment Rental", "Vehicle Rental", "Others",
];
const EMPTY_FORM = { title: "", title_other: "", expense_type: "", cash_advance_amount: "", cost_center: "", notes: "" };

export default function Expenses() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [reports, setReports] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [search, setSearch] = useState("");

  const load = () => api.get("/expenses").then(setReports).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const filteredReports = reports.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.employee_name, r.title, r.expense_type, r.cost_center, r.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredReports, "created_at", "desc");

  const handleCreate = async (e) => {
    e.preventDefault();
    const resolvedTitle = form.title === "Others" ? form.title_other.trim() : form.title;
    if (!resolvedTitle) {
      setError("Please specify a title / purpose");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const report = await api.post("/expenses", {
        title: resolvedTitle,
        expense_type: form.expense_type,
        cash_advance_amount: form.cash_advance_amount ? Number(form.cash_advance_amount) : 0,
        cost_center: form.cost_center,
        notes: form.notes,
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

      <div className="card">
        <table>
          <thead>
            <tr>
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Title" sortKey="title" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Type" sortKey="expense_type" toggleSort={toggleSort} arrow={arrow} />
              <th>Cost center</th>
              <SortTh label="Cash advance" sortKey="cash_advance_amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Expenses" sortKey="total_expenses" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Balance" sortKey="balance" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                {isHr && <td>{r.employee_name}</td>}
                <td>{r.title}</td>
                <td>{r.expense_type || "—"}</td>
                <td>{r.cost_center || "—"}</td>
                <td>{money(r.cash_advance_amount)}</td>
                <td>{money(r.total_expenses)}</td>
                <td>
                  {r.balance > 0 ? `${money(r.balance)} due to company` : r.balance < 0 ? `${money(-r.balance)} due to employee` : money(0)}
                </td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>
                  <button className="link-btn" onClick={() => setOpenId(r.id)}>
                    Open →
                  </button>
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
                {EXPENSE_TYPE_OPTIONS.map((opt) => (
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
                {EXPENSE_TITLE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            {form.title === "Others" && (
              <div className="form-row">
                <label>Please specify</label>
                <input
                  value={form.title_other}
                  onChange={(e) => setForm({ ...form, title_other: e.target.value })}
                  placeholder="Describe the purpose"
                  required
                />
              </div>
            )}
            <div className="form-row">
              <label>Cash advance amount</label>
              <input
                type="number"
                step="0.01"
                value={form.cash_advance_amount}
                onChange={(e) => setForm({ ...form, cash_advance_amount: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div className="form-row">
              <label>Cost center</label>
              <input
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
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function ReportDetail({ id, isHr, onClose, onChanged }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemForm, setItemForm] = useState({ expense_date: "", category: "", description: "", amount: "", receipt_ref: "" });
  const [receipt, setReceipt] = useState(null); // { name, type, data }
  const [attaching, setAttaching] = useState(false);
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

  const addItem = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post(`/expenses/${id}/items`, {
        ...itemForm,
        amount: Number(itemForm.amount),
        receipt_name: receipt?.name,
        receipt_type: receipt?.type,
        receipt_data: receipt?.data,
      });
      setItemForm({ expense_date: "", category: "", description: "", amount: "", receipt_ref: "" });
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
                    <td>{it.description || "—"}</td>
                    <td>
                      {it.receipt_ref || ""}
                      {it.receipt_data && (
                        <a
                          href={it.receipt_data}
                          download={it.receipt_name || "receipt"}
                          target="_blank"
                          rel="noreferrer"
                          className="location-link"
                          style={{ marginLeft: it.receipt_ref ? 6 : 0 }}
                        >
                          📎 {it.receipt_name || "receipt"}
                        </a>
                      )}
                      {!it.receipt_ref && !it.receipt_data && "—"}
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
                  <input value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })} placeholder="Meals, transport…" />
                </div>
                <div className="form-row" style={{ flex: 1 }}>
                  <label>Description</label>
                  <input value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} />
                </div>
                <div className="form-row">
                  <label>Receipt #</label>
                  <input value={itemForm.receipt_ref} onChange={(e) => setItemForm({ ...itemForm, receipt_ref: e.target.value })} />
                </div>
                <div className="form-row">
                  <label>Amount</label>
                  <input type="number" step="0.01" value={itemForm.amount} onChange={(e) => setItemForm({ ...itemForm, amount: e.target.value })} required />
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
