import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

const STATUS_BADGE = { pending: "pending", open: "active", rejected: "rejected", settled: "approved", cancelled: "cancelled" };

const EMPTY = { employee_id: "", amount: "", date_released: "", purpose: "", cost_center: "", notes: "" };

export default function CashAdvances() {
  const { user } = useAuth();
  const { moneyPrecise: money } = useAppSettings();
  const isHr = user.role === "admin" || user.role === "hr";

  const [advances, setAdvances] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  // The advance whose unspent cash is being handed back.
  const [returning, setReturning] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () =>
    api
      .get("/cash-advances")
      .then(setAdvances)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
  }, [isHr]);

  const openNew = () => {
    setForm({ ...EMPTY, date_released: new Date().toISOString().slice(0, 10) });
    setEditingId(null);
    setError("");
    setShowForm(true);
  };

  const openEdit = (a) => {
    setForm({
      employee_id: String(a.employee_id),
      amount: String(a.amount),
      date_released: a.date_released || "",
      purpose: a.purpose || "",
      cost_center: a.cost_center || "",
      notes: a.notes || "",
    });
    setEditingId(a.id);
    setError("");
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editingId) await api.put(`/cash-advances/${editingId}`, form);
      // An employee's request is always for themselves; the server enforces
      // that too, so the field is simply not sent.
      else await api.post("/cash-advances", isHr ? { ...form, employee_id: Number(form.employee_id) } : form);
      setShowForm(false);
      setNotice(
        editingId
          ? "Advance updated."
          : isHr
            ? "Advance released."
            : "Request sent — it will show as open once admin or HR approves it."
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Handing unspent cash back is what actually closes an advance out. Prefilled
  // with the whole outstanding amount, which is the common case — a partial
  // hand-back just means typing a smaller figure.
  const openReturn = (a) => {
    setError("");
    setReturning({ advance: a, amount: String(a.dueToCompany || 0) });
  };

  const confirmReturn = async (e) => {
    e.preventDefault();
    setBusyId(returning.advance.id);
    setError("");
    try {
      // Cumulative on the server, so what is sent is the running total handed
      // back, not just this instalment.
      const total = Number(returning.advance.returned_amount || 0) + Number(returning.amount || 0);
      const updated = await api.put(`/cash-advances/${returning.advance.id}`, { returned_amount: total });
      setReturning(null);
      setNotice(
        updated.outstanding === 0
          ? `${updated.reference} is now fully accounted for — nothing outstanding.`
          : `Recorded. ${money(updated.dueToCompany)} still due from ${updated.employee_name}.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (a, decision) => {
    const note =
      decision === "rejected"
        ? prompt(`Why is ${a.reference} being turned down?

${a.employee_name} will see this.`)
        : "";
    if (decision === "rejected" && note === null) return;
    setBusyId(a.id);
    setError("");
    try {
      const updated = await api.put(`/cash-advances/${a.id}/decision`, {
        decision,
        decision_note: (note || "").trim() || null,
      });
      setNotice(
        decision === "approved"
          ? `${updated.reference} approved — ${money(updated.amount)} released to ${updated.employee_name}.`
          : `${updated.reference} turned down.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = async (a, status) => {
    if (status === "settled" && a.outstanding !== 0) {
      const wording =
        a.dueToCompany > 0
          ? `${money(a.dueToCompany)} is still unaccounted for on ${a.reference}.`
          : `${money(a.reimbursementDue)} is still owed back to ${a.employee_name} on ${a.reference}.`;
      if (!confirm(`${wording}\n\nSettle it anyway?`)) return;
    }
    setBusyId(a.id);
    setError("");
    try {
      await api.put(`/cash-advances/${a.id}`, { status });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a) => {
    if (!confirm(`Delete ${a.reference}? This removes the record of ${money(a.amount)} released to ${a.employee_name}.`)) return;
    setBusyId(a.id);
    setError("");
    try {
      await api.del(`/cash-advances/${a.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const filtered = advances.filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [a.reference, a.employee_name, a.purpose, a.cost_center, a.status, a.department_name]
      .some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filtered, "date_released", "desc");

  const openAdvances = advances.filter((a) => a.status === "open");
  const pending = advances.filter((a) => a.status === "pending");
  const totalOut = openAdvances.reduce((n, a) => n + a.dueToCompany, 0);
  const totalOwed = openAdvances.reduce((n, a) => n + a.reimbursementDue, 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Cash Advances</h1>
          <p className="subtitle">
            {isHr
              ? "Money released to staff, and what is left to account for. Expense reports draw against an advance until it is settled."
              : "Cash released to you, and what is left to liquidate."}
          </p>
        </div>
        {/* Anyone can ask; only admin/HR release. The label says which is
            happening rather than pretending they are the same act. */}
        <button className="btn" onClick={openNew}>
          {isHr ? "+ New cash advance" : "+ Request cash advance"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      {!loading && advances.length > 0 && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-value" style={{ color: pending.length ? "var(--warning)" : undefined }}>
              {pending.length}
            </div>
            <div className="stat-label">Awaiting approval</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{openAdvances.length}</div>
            <div className="stat-label">Open advances</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: totalOut > 0 ? "var(--warning)" : undefined }}>
              {money(totalOut)}
            </div>
            <div className="stat-label">Still to account for</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: totalOwed > 0 ? "var(--danger)" : undefined }}>
              {money(totalOwed)}
            </div>
            <div className="stat-label">Owed back to staff — overspend</div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by reference, employee, purpose…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : advances.length === 0 ? (
          <div className="empty-state">
            {isHr
              ? "No cash advances yet. Release one and expense reports can draw against it."
              : "No cash has been released to you."}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="sticky-head">
              <thead>
                <tr>
                  <SortTh label="Reference" sortKey="reference" toggleSort={toggleSort} arrow={arrow} className="col-nowrap" />
                  {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
                  <SortTh label="Released" sortKey="date_released" toggleSort={toggleSort} arrow={arrow} className="col-nowrap" />
                  <th>Purpose</th>
                  <SortTh label="Amount" sortKey="amount" toggleSort={toggleSort} arrow={arrow} />
                  <SortTh label="Liquidated" sortKey="liquidated" toggleSort={toggleSort} arrow={arrow} />
                  <th>Returned</th>
                  <SortTh label="Balance" sortKey="outstanding" toggleSort={toggleSort} arrow={arrow} />
                  <th>Status</th>
                  {isHr && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr key={a.id}>
                    <td className="col-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {a.reference}
                      {a.report_count > 0 && (
                        <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
                          {a.report_count} report{a.report_count === 1 ? "" : "s"}
                        </div>
                      )}
                    </td>
                    {isHr && (
                      <td>
                        {a.employee_name}
                        {a.department_name && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{a.department_name}</div>
                        )}
                      </td>
                    )}
                    <td className="col-nowrap">{a.date_released}</td>
                    <td>
                      {a.purpose || "—"}
                      {a.cost_center && (
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{a.cost_center}</div>
                      )}
                    </td>
                    <td className="col-nowrap">{money(a.amount)}</td>
                    <td className="col-nowrap">{money(a.liquidated)}</td>
                    <td className="col-nowrap">{a.returned_amount > 0 ? money(a.returned_amount) : "—"}</td>
                    {/* One signed figure read two ways: cash the employee still
                        holds, or money the company owes them for overspending. */}
                    <td className="col-nowrap">
                      {a.fullyAccounted ? (
                        <span className="subtitle">fully accounted</span>
                      ) : a.dueToCompany > 0 ? (
                        <span style={{ color: "var(--warning)" }}>{money(a.dueToCompany)} due to company</span>
                      ) : (
                        <span style={{ color: "var(--danger)" }}>{money(a.reimbursementDue)} due to employee</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-${STATUS_BADGE[a.status] || "neutral"}`}>{a.status}</span>
                      {a.decision_note && (
                        <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>{a.decision_note}</div>
                      )}
                    </td>
                    {isHr && (
                      <td>
                        <div className="col-actions">
                          {isHr && a.status === "pending" && (
                            <>
                              <button className="btn btn-sm" disabled={busyId === a.id} onClick={() => decide(a, "approved")}>
                                Approve
                              </button>
                              <button className="btn btn-sm btn-secondary" disabled={busyId === a.id} onClick={() => decide(a, "rejected")}>
                                Reject
                              </button>
                            </>
                          )}
                          {a.status === "open" && a.dueToCompany > 0 && (
                            <button className="btn btn-sm" disabled={busyId === a.id} onClick={() => openReturn(a)}>
                              Cash returned
                            </button>
                          )}
                          {a.status === "open" && (
                            <button className="btn btn-sm btn-secondary" disabled={busyId === a.id} onClick={() => setStatus(a, "settled")}>
                              Settle
                            </button>
                          )}
                          {a.status === "settled" && (
                            <button className="btn btn-sm btn-secondary" disabled={busyId === a.id} onClick={() => setStatus(a, "open")}>
                              Reopen
                            </button>
                          )}
                          <button className="btn btn-sm btn-secondary" onClick={() => openEdit(a)}>Edit</button>
                          {a.report_count === 0 && (
                            <button className="btn btn-sm btn-danger" disabled={busyId === a.id} onClick={() => remove(a)}>
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {advances.length > 0 && sorted.length === 0 && (
          <div className="empty-state">No advances match your search.</div>
        )}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? "Edit cash advance" : isHr ? "Release a cash advance" : "Request a cash advance"}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {isHr
                ? "Released straight away. Expense reports then draw against it until it is settled."
                : "Goes to admin/HR for approval. Nothing is released, and no expenses can be claimed against it, until it is approved."}
            </p>
            <form onSubmit={save}>
              <div className="grid grid-2">
                {isHr ? (
                  <div className="form-row">
                    <label>Employee</label>
                    <select
                      value={form.employee_id}
                      onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                      required
                      disabled={!!editingId}
                    >
                      <option value="">Select employee…</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.first_name} {emp.last_name}
                        </option>
                      ))}
                    </select>
                    {editingId && (
                      <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                        Who an advance was released to cannot change — release a new one instead.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="form-row">
                    <label>For</label>
                    <input value="You" disabled />
                    <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                      A request is always for yourself.
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label>Amount released</label>
                  <DecimalInput
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Date released</label>
                  <input
                    type="date"
                    value={form.date_released}
                    onChange={(e) => setForm({ ...form, date_released: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Cost center</label>
                  <input
                    value={form.cost_center}
                    onChange={(e) => setForm({ ...form, cost_center: e.target.value })}
                    placeholder="e.g. Engineering"
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Purpose</label>
                <input
                  value={form.purpose}
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                  placeholder="What the money is for"
                />
              </div>
              <div className="form-row">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save changes" : isHr ? "Release advance" : "Send request"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {returning && (
        <div className="modal-backdrop" onClick={() => setReturning(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Cash returned</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {returning.advance.reference} — {money(returning.advance.amount)} released to{" "}
              {returning.advance.employee_name}, {money(returning.advance.liquidated)} liquidated so far.
              Recording the {money(returning.advance.dueToCompany)} unspent brings the balance to zero.
            </p>
            <form onSubmit={confirmReturn}>
              <div className="form-row">
                <label>Amount handed back</label>
                <DecimalInput
                  value={returning.amount}
                  onChange={(e) => setReturning({ ...returning, amount: e.target.value })}
                  required
                />
                <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                  Leave as is to close the advance out, or enter less for a partial hand-back.
                  {returning.advance.returned_amount > 0 &&
                    ` ${money(returning.advance.returned_amount)} has already been returned.`}
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setReturning(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={busyId === returning.advance.id}>
                  {busyId === returning.advance.id ? "Recording…" : "Record return"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
