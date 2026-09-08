import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import DecimalInput from "../components/DecimalInput";

// The project register, and the only place the company can see what a job cost
// against what it was sold for.
//
// Before this existed, project work was one line in the Cost Centers screen —
// enough to say what all projects cost together, never enough to say which one
// lost money. Every figure here is rolled up from records that already exist:
// expense reports, purchase orders and invoices filed against the project. None
// of it is typed twice, so none of it can disagree with the ledger it came from.

const EMPTY = {
  code: "",
  name: "",
  client_name: "",
  description: "",
  status: "planned",
  start_date: "",
  target_end_date: "",
  actual_end_date: "",
  contract_value: "",
  owner_id: "",
  cost_center_id: "",
  notes: "",
  // The order the project was raised from. Not a project column — it is written
  // to the order's own project_id when the project is created.
  from_order_id: "",
};

const STATUS_LABEL = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

// The status word an existing badge class already paints the right colour, so
// project states inherit the palette the rest of the app uses rather than
// introducing a sixth vocabulary of colours.
const STATUS_BADGE = {
  planned: "open",
  active: "active",
  on_hold: "pending",
  completed: "completed",
  cancelled: "cancelled",
};

const TONE = { good: "var(--success)", warn: "var(--warning)", bad: "var(--danger)", muted: "var(--text-muted)" };

export default function Projects() {
  const { user } = useAuth();
  const { money, moneyWhole } = useAppSettings();
  const isHr = user.role === "admin" || user.role === "hr";

  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const [orders, setOrders] = useState([]);

  const load = () =>
    api
      .get("/projects")
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    if (isHr) {
      api.get("/employees").then(setEmployees).catch(() => {});
      api.get("/cost-centers/options").then(setCostCenters).catch(() => {});
      // Silent on failure: the shortcut simply does not appear, and the form
      // still works the way it always has.
      api.get("/orders").then(setOrders).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setForm(EMPTY);
    setPrefilled({});
    setEditingId(null);
    setError("");
    setShowForm(true);
  };

  // Orders not yet booked to a project. A cancelled one cannot start a job,
  // and one already attached belongs to a project that exists — offering either
  // would only produce a link the server refuses.
  const availableOrders = orders.filter((o) => !o.project_id && o.status !== "cancelled");

  // What the last chosen order put into the form. Changing your mind about the
  // order has to move the three fields with it: filling only blanks meant
  // switching from one order to another kept the first order's name and value
  // while linking the second — a project labelled and priced from one job and
  // booked to a different one, with nothing on screen to show it.
  //
  // Anything typed by hand is still safe. A field is only replaced when it is
  // empty or still holds exactly what the previous order wrote there.
  const [prefilled, setPrefilled] = useState({});

  const pickOrder = (id) => {
    const o = orders.find((x) => String(x.id) === String(id));
    // The order number is the fallback name — an order raised without an
    // opportunity behind it has no title of its own.
    const next = o
      ? { name: o.deal_title || o.order_number, client_name: o.customer_name || "", contract_value: o.amount ? String(o.amount) : "" }
      : { name: "", client_name: "", contract_value: "" };

    setForm((f) => {
      const keep = (field) => (f[field] && f[field] !== prefilled[field] ? f[field] : next[field]);
      return {
        ...f,
        from_order_id: o ? String(o.id) : "",
        name: keep("name"),
        client_name: keep("client_name"),
        contract_value: keep("contract_value"),
      };
    });
    setPrefilled(next);
  };

  const openEdit = (p) => {
    setForm({
      code: p.code || "",
      name: p.name || "",
      client_name: p.client_name || "",
      description: p.description || "",
      status: p.status,
      start_date: p.start_date || "",
      target_end_date: p.target_end_date || "",
      actual_end_date: p.actual_end_date || "",
      contract_value: p.contract_value ? String(p.contract_value) : "",
      owner_id: p.owner_id || "",
      cost_center_id: p.cost_center_id || "",
      notes: p.notes || "",
    });
    setEditingId(p.id);
    setError("");
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = { ...form, contract_value: Number(form.contract_value || 0) };
      let created = null;
      if (editingId) await api.put(`/projects/${editingId}`, body);
      else created = await api.post("/projects", body);
      setShowForm(false);
      setNotice(
        editingId
          ? `${form.code} updated.`
          : created?.linkedOrder
            ? `${form.code} added, with ${created.linkedOrder} booked to it — billing that order now lands on this project.`
            : `${form.code} added — expenses, purchase orders and invoices can now be filed against it.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p) => {
    if (!confirm(`Delete "${p.code} — ${p.name}"? Only possible while nothing is booked to it.`)) return;
    setBusyId(p.id);
    setError("");
    try {
      await api.del(`/projects/${p.id}`);
      setNotice(`${p.code} deleted.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!data) return <div className="error-banner">{error || "No data"}</div>;

  const closed = data.projects.filter((p) => p.status === "completed" || p.status === "cancelled");
  const shown = showClosed ? data.projects : data.projects.filter((p) => !closed.includes(p));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">
            What each job was sold for and what it has actually cost. Spend is every expense report and
            purchase order filed against the project; billed is every invoice raised against it. Nothing
            here is typed in — it is the same records the rest of the app already holds.
          </p>
        </div>
        {isHr && <button className="btn" onClick={openNew}>+ New project</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(data.totals.contractValue)}</div>
          <div className="stat-label">Contract value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(data.totals.spent)}</div>
          <div className="stat-label">Spent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(data.totals.invoiced)}</div>
          <div className="stat-label">Billed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: data.totals.margin < 0 ? "var(--danger)" : "var(--success)" }}>
            {moneyWhole(data.totals.margin)}
          </div>
          <div className="stat-label">Margin</div>
        </div>
      </div>

      <div className="card">
        {data.projects.length === 0 ? (
          <div className="empty-state">
            No projects yet. Add one, and it becomes selectable on expense reports, purchase orders,
            invoices and work orders — which is what makes a project P&amp;L possible.
          </div>
        ) : (
          <>
            {closed.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showClosed}
                    onChange={(e) => setShowClosed(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  Show {closed.length} completed / cancelled
                </label>
              </div>
            )}
            <div className="table-scroll">
              <table className="sticky-head">
                <thead>
                  <tr>
                    {/* The code is an identifier and must not be hyphenated
                        across three lines when the table is squeezed. */}
                    <th className="th-plain" style={{ minWidth: 180 }}>Project</th>
                    <th className="th-plain" style={{ minWidth: 130 }}>Client</th>
                    <th className="th-plain">Status</th>
                    <th className="th-plain">Dates</th>
                    <th className="th-plain">Contract</th>
                    <th className="th-plain">Spent</th>
                    <th className="th-plain">Margin</th>
                    <th className="th-plain">Billed</th>
                    <th className="th-plain">Progress</th>
                    <th className="th-plain">Schedule</th>
                    {isHr && <th className="col-actions-sticky"></th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} className={p.overSpend ? "row-selected" : undefined}>
                      <td>
                        <strong className="col-nowrap">{p.code}</strong>
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{p.name}</div>
                      </td>
                      <td>{p.client_name || "—"}</td>
                      <td>
                        <span className={`badge badge-${STATUS_BADGE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                      </td>
                      <td className="col-nowrap">
                        {p.start_date || "—"}
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                          to {p.actual_end_date || p.target_end_date || "—"}
                          {p.actual_end_date && p.target_end_date && p.actual_end_date > p.target_end_date
                            ? ` (target ${p.target_end_date})`
                            : ""}
                        </div>
                      </td>
                      <td className="col-nowrap">
                        {p.contract_value > 0 ? money(p.contract_value) : "—"}
                        {/* A signed contract is not always the sum of the order
                            records — a variation raised as its own order is the
                            usual reason — so the two are shown side by side
                            rather than reconciled. A gap nobody can see is one
                            that quietly makes the margin wrong. */}
                        {p.orders.count > 0 && (
                          <div
                            className="subtitle"
                            style={{ fontSize: 12, margin: 0, color: p.orders.differsFromContract ? "var(--warning)" : undefined }}
                          >
                            {money(p.orders.value)} ordered · {p.orders.count} order{p.orders.count === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      <td className="col-nowrap">
                        {money(p.spend.total)}
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                          {money(p.spend.expenses)} expenses · {money(p.spend.procurement)} purchasing
                        </div>
                      </td>
                      <td className="col-nowrap" style={{ color: p.margin < 0 ? "var(--danger)" : undefined }}>
                        {/* Nothing sold means no margin to report — not a zero
                            one, which reads as break-even. */}
                        {p.contract_value > 0 ? money(p.margin) : "—"}
                        {p.marginPercent !== null && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{p.marginPercent}%</div>
                        )}
                      </td>
                      <td className="col-nowrap">
                        {money(p.billing.invoiced)}
                        {p.billing.draftInvoices > 0 && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0, color: "var(--danger)" }}>
                            {p.billing.draftInvoices} never sent
                          </div>
                        )}
                      </td>
                      <td className="col-nowrap">
                        {p.progressPercent === null ? (
                          <span className="subtitle">no tasks</span>
                        ) : (
                          <>
                            {p.progressPercent}%
                            <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                              {p.tasks.done}/{p.tasks.total} tasks
                            </div>
                          </>
                        )}
                      </td>
                      <td style={{ color: TONE[p.schedule.tone] }}>
                        {p.schedule.label}
                        {p.planOverrunsTarget && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0, color: "var(--warning)" }}>
                            plan runs past target
                          </div>
                        )}
                      </td>
                      {isHr && (
                        <td className="col-actions-sticky">
                          <div className="col-actions">
                            <button className="btn btn-sm btn-secondary" onClick={() => openEdit(p)}>Edit</button>
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={busyId === p.id}
                              onClick={() => remove(p)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? "Edit project" : "New project"}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              The code is how spend is filed against the job, so it is worth choosing one people will
              recognise on an expense form.
            </p>
            {!editingId && availableOrders.length > 0 && (
              <div className="card" style={{ padding: 12, marginBottom: 14 }}>
                <div className="form-row" style={{ margin: 0 }}>
                  <label>Start from an order (optional)</label>
                  <select value={form.from_order_id} onChange={(e) => pickOrder(e.target.value)}>
                    <option value="">Not from an order — enter the details below</option>
                    {availableOrders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.order_number} — {o.customer_name} — {money(o.amount)}
                      </option>
                    ))}
                  </select>
                  <span className="subtitle" style={{ fontSize: 12 }}>
                    Fills the name, client and contract value, and books that order to the project so
                    billing it lands here. Anything you have already typed is left alone.
                  </span>
                </div>
              </div>
            )}
            <form onSubmit={save}>
              <div className="grid grid-3">
                <div className="form-row">
                  <label>Code</label>
                  <input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="e.g. PRJ-2026-001"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Name</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="What the job is"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Client</label>
                  <input
                    value={form.client_name}
                    onChange={(e) => setForm({ ...form, client_name: e.target.value })}
                    placeholder="Who it is for"
                  />
                </div>
              </div>

              <div className="grid grid-3">
                <div className="form-row">
                  <label>Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Contract value</label>
                  <DecimalInput
                    value={form.contract_value}
                    onChange={(e) => setForm({ ...form, contract_value: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
                <div className="form-row">
                  <label>Project manager</label>
                  <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
                    <option value="">Unassigned</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-3">
                <div className="form-row">
                  <label>Start date</label>
                  <input
                    type="date"
                    value={form.start_date}
                    onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Target end date</label>
                  <input
                    type="date"
                    value={form.target_end_date}
                    onChange={(e) => setForm({ ...form, target_end_date: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Actual end date</label>
                  <input
                    type="date"
                    value={form.actual_end_date}
                    onChange={(e) => setForm({ ...form, actual_end_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-2">
                <div className="form-row">
                  <label>Cost center (optional)</label>
                  <select
                    value={form.cost_center_id}
                    onChange={(e) => setForm({ ...form, cost_center_id: e.target.value })}
                  >
                    <option value="">None</option>
                    {costCenters.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Description</label>
                  <input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Scope in one line"
                  />
                </div>
              </div>

              <div className="form-row">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
