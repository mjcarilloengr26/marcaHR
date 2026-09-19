import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import PastRecords from "../components/PastRecords";
import DecimalInput from "../components/DecimalInput";

const STATUS_BADGE = { pending: "pending", open: "active", rejected: "rejected", settled: "approved", cancelled: "cancelled" };

const EMPTY = { employee_id: "", amount: "", date_released: "", purpose: "", cost_center: "", notes: "" };

export default function CashAdvances() {
  const { user } = useAuth();
  const { moneyPrecise: money } = useAppSettings();
  const isHr = user.role === "admin" || user.role === "hr";
  // Destroying a record is an administrator's act — see the delete routes.
  const isAdmin = user?.role === "admin";

  const [advances, setAdvances] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
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
    // Everyone needs these: an employee requesting an advance picks a cost
    // centre from the same list HR does when releasing one.
    api.get("/cost-centers/options").then(setCostCenters).catch(() => {});
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

  // Settling is where an advance is squared off, so it asks for the money that
  // squares it rather than waving the imbalance through. Which way it runs
  // depends on who is out of pocket: the employee still holding cash hands it
  // back, and an employee who spent their own money gets paid.
  const openSettle = (a) => {
    setError("");
    if (a.outstanding === 0) {
      setStatus(a, "settled");
      return;
    }
    setReturning({
      advance: a,
      amount: String(a.dueToCompany > 0 ? a.dueToCompany : a.reimbursementDue),
      direction: a.dueToCompany > 0 ? "return" : "reimburse",
    });
  };

  // Whether handing back this much leaves nothing outstanding. Rounded to the
  // centavo before comparing, since a float subtraction of two exact amounts
  // can land a hair off zero and would then never count as closed.
  const closesOut = (advance, total, direction = "return") => {
    const returned = direction === "return" ? total : Number(advance.returned_amount || 0);
    const reimbursed = direction === "reimburse" ? total : Number(advance.reimbursed_amount || 0);
    const left =
      Math.round((Number(advance.amount) + reimbursed - returned - Number(advance.liquidated)) * 100) / 100;
    return left === 0;
  };

  const confirmReturn = async (e) => {
    e.preventDefault();
    setBusyId(returning.advance.id);
    setError("");
    try {
      const entered = Number(returning.amount || 0);
      const reimbursing = returning.direction === "reimburse";

      // Both fields are cumulative on the server, so what is sent is the
      // running total on that side, not just this instalment.
      const total = Number(
        (reimbursing ? returning.advance.reimbursed_amount : returning.advance.returned_amount) || 0
      ) + entered;

      // Squaring the balance is the end of the advance, so it closes here
      // rather than leaving an accounted record in the open list waiting for a
      // second click nobody knew to make.
      const settles = closesOut(returning.advance, total, returning.direction);

      const updated = await api.put(`/cash-advances/${returning.advance.id}`, {
        [reimbursing ? "reimbursed_amount" : "returned_amount"]: total,
        ...(settles ? { status: "settled" } : {}),
      });
      setReturning(null);
      setNotice(
        settles
          ? `${updated.reference} is fully accounted for and settled — nothing outstanding.`
          : reimbursing
            ? `Recorded. ${money(updated.reimbursementDue)} still owed back to ${updated.employee_name}.`
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

  // Money still in play, and money that is done with.
  //
  // A settled advance is square in both directions — nothing owed to the
  // company, nothing owed to the employee — and a cancelled or rejected one
  // never released any. None of them belong in the list somebody scans to see
  // what is still outstanding, and a settled row sitting among open ones is
  // how a balance gets recorded twice.
  const CLOSED = ["settled", "cancelled", "rejected"];
  const liveAdvances = sorted.filter((a) => !CLOSED.includes(a.status));
  const closedAdvances = sorted.filter((a) => CLOSED.includes(a.status));

  const openAdvances = advances.filter((a) => a.status === "open");
  const pending = advances.filter((a) => a.status === "pending");
  const totalOut = openAdvances.reduce((n, a) => n + a.dueToCompany, 0);
  const totalOwed = openAdvances.reduce((n, a) => n + a.reimbursementDue, 0);

  // One set of columns for both lists. The archive keeps the action column so
  // a settled advance can still be reopened or corrected — it is history, not
  // a locked record — but it is a click away rather than in the working list.
  const advanceTable = (rows) => (
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
                <th>Settled</th>
                <SortTh label="Balance" sortKey="outstanding" toggleSort={toggleSort} arrow={arrow} style={{ minWidth: 130 }} />
                <th>Status</th>
                {isHr && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
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
                  {/* Cash moved to square the advance, whichever way it went.
                      Without the reimbursement side an overspend that was
                      paid back read as "fully accounted" against a blank
                      column, with nothing on the row to say the money had
                      actually left. */}
                  <td className="col-nowrap">
                    {a.returned_amount > 0 || a.reimbursed_amount > 0 ? (
                      <>
                        {money(a.returned_amount > 0 ? a.returned_amount : a.reimbursed_amount)}
                        <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
                          {a.returned_amount > 0 ? "handed back" : "paid to employee"}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* One signed figure read two ways: cash the employee still
                      holds, or money the company owes them for overspending.
                      The figure sits on its own line with the direction as a
                      note beneath, the same shape the expense list uses — as
                      one run of text it wrapped in a narrow column and the
                      amount stopped being the thing you saw first. */}
                  <td>
                    {a.fullyAccounted ? (
                      <span className="subtitle">fully accounted</span>
                    ) : (
                      <>
                        <span
                          className="col-nowrap"
                          style={{ color: a.dueToCompany > 0 ? "var(--warning)" : "var(--danger)" }}
                        >
                          {money(a.dueToCompany > 0 ? a.dueToCompany : a.reimbursementDue)}
                        </span>
                        <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
                          {a.dueToCompany > 0 ? "due to company" : "due to employee"}
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`badge badge-${STATUS_BADGE[a.status] || "neutral"}`}>{a.status}</span>
                    {a.decision_note && (
                      <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>{a.decision_note}</div>
                    )}
                    {/* Who accounted for the money. A settled advance is a
                        balance somebody brought to zero, and the name is the
                        whole point of recording it — an advance that closed
                        itself is the thing this is meant to rule out.
                        Advances settled before this shipped have no name to
                        show, which is honest: nobody recorded one. */}
                    {a.settled_by_name && (
                      <div className="subtitle" style={{ fontSize: 11, margin: 0 }} title={a.settled_at || ""}>
                        {a.status === "settled" ? "settled by " : "last recorded by "}
                        {a.settled_by_name}
                      </div>
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
                        {a.status === "open" && (
                          <button className="btn btn-sm" disabled={busyId === a.id} onClick={() => openSettle(a)}>
                            Settle
                          </button>
                        )}
                        {a.status === "settled" && (
                          <button className="btn btn-sm btn-secondary" disabled={busyId === a.id} onClick={() => setStatus(a, "open")}>
                            Reopen
                          </button>
                        )}
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(a)}>Edit</button>
                        {isAdmin && a.report_count === 0 && (
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
  );

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
          advanceTable(liveAdvances)
        )}
        {advances.length > 0 && sorted.length === 0 && (
          <div className="empty-state">No advances match your search.</div>
        )}
        {advances.length > 0 && sorted.length > 0 && liveAdvances.length === 0 && (
          <div className="empty-state">
            Nothing outstanding — every matching advance is closed. They are listed below.
          </div>
        )}
      </div>

      <PastRecords
        title="Closed advances"
        count={closedAdvances.length}
        hint="Settled, cancelled and rejected advances. Nothing here is still owed either way."
      >
        {() => advanceTable(closedAdvances)}
      </PastRecords>

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
                  {/* The admin-managed list, not free text. An advance is where
                      the money is committed, so a typo here detaches the spend
                      from its allocation before a claim is even filed. */}
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
                      : "Required. Set up by an admin — the reports drawn against this advance each carry their own, so this is the advance's own centre."}
                  </div>
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
            <h2>{returning.direction === "reimburse" ? "Pay back the employee" : "Cash returned"}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {returning.advance.reference} — {money(returning.advance.amount)} released to{" "}
              {returning.advance.employee_name}, {money(returning.advance.liquidated)} liquidated so far.{" "}
              {returning.direction === "reimburse"
                ? `They spent ${money(returning.advance.reimbursementDue)} of their own money, so the company owes them that back.`
                : `Recording the ${money(returning.advance.dueToCompany)} unspent brings the balance to zero.`}
            </p>
            <form onSubmit={confirmReturn}>
              <div className="form-row">
                <label>{returning.direction === "reimburse" ? "Amount transferred to the employee" : "Amount handed back"}</label>
                <DecimalInput
                  value={returning.amount}
                  onChange={(e) => setReturning({ ...returning, amount: e.target.value })}
                  required
                />
                <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                  {closesOut(
                    returning.advance,
                    Number(
                      (returning.direction === "reimburse"
                        ? returning.advance.reimbursed_amount
                        : returning.advance.returned_amount) || 0
                    ) + Number(returning.amount || 0),
                    returning.direction
                  )
                    ? "This clears the balance, so the advance will be settled at the same time."
                    : "Enter less for a part payment — the advance stays open for the rest."}
                  {returning.direction === "reimburse"
                    ? returning.advance.reimbursed_amount > 0 &&
                      ` ${money(returning.advance.reimbursed_amount)} has already been paid back.`
                    : returning.advance.returned_amount > 0 &&
                      ` ${money(returning.advance.returned_amount)} has already been returned.`}
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setReturning(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={busyId === returning.advance.id}>
                  {busyId === returning.advance.id
                    ? "Recording…"
                    : closesOut(
                          returning.advance,
                          Number(
                            (returning.direction === "reimburse"
                              ? returning.advance.reimbursed_amount
                              : returning.advance.returned_amount) || 0
                          ) + Number(returning.amount || 0),
                          returning.direction
                        )
                      ? "Record and settle"
                      : "Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
