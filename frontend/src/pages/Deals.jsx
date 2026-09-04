import { useEffect, useState } from "react";
import { api } from "../api/client";
import SuggestInput from "../components/SuggestInput";
import { useAppSettings } from "../context/AppSettingsContext";
import { useAuth } from "../context/AuthContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

const emptyForm = { title: "", customer_name: "", value: "", stage: "lead", owner_id: "", expected_close_date: "", notes: "", competitor: "" };
const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

// Days in the current stage is the number a pipeline review acts on; total age
// is context, so it sits underneath in small type rather than competing.
// Won and lost deals are finished, so they show nothing at all.
function AgingCell({ deal, staleAfter }) {
  if (["won", "lost"].includes(deal.stage)) return <span>—</span>;

  const stalled = deal.days_in_stage >= staleAfter;
  const pastClose = deal.days_past_close !== null && deal.days_past_close > 0;
  const colour = stalled || pastClose ? "var(--danger)" : undefined;

  return (
    <div style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: colour, fontWeight: stalled || pastClose ? 600 : 400 }}>
        {deal.days_in_stage}d in {deal.stage}
      </span>
      <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
        {deal.age_days}d old
        {pastClose && <span style={{ color: "var(--danger)" }}> · {deal.days_past_close}d past close</span>}
        {!pastClose && deal.days_past_close === null && " · no close date"}
      </div>
    </div>
  );
}

export default function Deals() {
  const { money } = useAppSettings();
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [deals, setDeals] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  // The staleness threshold is set on the Sales Dashboard; the list reads it so
  // both pages agree on what counts as stalled.
  const [staleAfter, setStaleAfter] = useState(30);

  const load = () => api.get("/deals").then(setDeals).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    api
      .get("/deals/aging/summary")
      .then((d) => setStaleAfter(d.thresholdDays))
      .catch(() => {});
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (deal) => {
    setEditingId(deal.id);
    setForm({
      title: deal.title,
      customer_name: deal.customer_name,
      competitor: deal.competitor || "",
      value: deal.value,
      stage: deal.stage,
      owner_id: deal.owner_id || "",
      expected_close_date: deal.expected_close_date || "",
      notes: deal.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, value: Number(form.value) || 0, owner_id: form.owner_id || null };
      if (editingId) {
        const updated = await api.put(`/deals/${editingId}`, payload);
        announceAutoOrder(updated);
      } else {
        const created = await api.post("/deals", payload);
        announceAutoOrder(created);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const announceAutoOrder = (updated) => {
    if (updated.autoCreatedOrder) {
      setNotice(`Won! Order ${updated.autoCreatedOrder.order_number} was created automatically and is now in fulfillment.`);
    }
  };

  const quickSetStage = async (id, stage) => {
    setNotice("");
    try {
      const updated = await api.put(`/deals/${id}`, { stage });
      announceAutoOrder(updated);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this opportunity?")) return;
    try {
      await api.del(`/deals/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredDeals = deals.filter((d) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [d.title, d.customer_name, d.competitor, d.owner_name, d.stage, d.linked_order_number].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredDeals, "created_at", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sales Opportunities</h1>
          <p className="subtitle">
            {isHr
              ? "Pipeline — track opportunities from lead to close. Winning one auto-creates an order."
              : "Your pipeline — track your opportunities from lead to close. Winning one auto-creates an order."}
          </p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add opportunity</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success)", color: "var(--success)" }}>
          ✓ {notice}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by title, customer, owner, stage…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              <SortTh label="Title" sortKey="title" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Competitor" sortKey="competitor" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Value" sortKey="value" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Owner" sortKey="owner_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh
                label="Expected close"
                sortKey="expected_close_date"
                toggleSort={toggleSort}
                arrow={arrow}
                className="col-nowrap"
              />
              {/* Named for what it sorts by and for the figure in large type.
                  "Aging" read as total age, which is the small grey number
                  underneath — so sorting by it appeared to put the oldest
                  opportunity last. "Aging" still belongs to the Pipeline aging
                  card on the Sales Dashboard, where it means a bucketed
                  report. */}
              <SortTh
                label="Days in stage"
                sortKey="days_in_stage"
                toggleSort={toggleSort}
                arrow={arrow}
                className="col-nowrap"
              />
              {/* "Linked order", not "Order": the value is an order number
                  formatted ORD-OPP-<opportunity id>, which reads like an
                  opportunity reference at a glance. */}
              <th className="col-nowrap">Linked order</th>
              <SortTh label="Stage" sortKey="stage" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.customer_name}</td>
                <td>{d.competitor || "—"}</td>
                <td>{money(d.value)}</td>
                <td>{d.owner_name || "—"}</td>
                {/* This cell was missing entirely: the header row had ten
                    columns and the body nine, so everything from here right
                    sat one column left of its own heading — days-in-stage
                    under "Expected close", the order number under "Aging",
                    the stage dropdown under the order column. */}
                <td className="col-nowrap">{d.expected_close_date || "—"}</td>
                <td><AgingCell deal={d} staleAfter={staleAfter} /></td>
                <td className="col-nowrap">{d.linked_order_number || "—"}</td>
                <td>
                  <select value={d.stage} onChange={(e) => quickSetStage(d.id, e.target.value)} style={{ width: "auto" }}>
                    {STAGES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(d)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {deals.length === 0 && <div className="empty-state">No sales opportunities yet.</div>}
        {deals.length > 0 && sorted.length === 0 && <div className="empty-state">No opportunities match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit opportunity" : "Add opportunity"}</h2>
            <div className="form-row">
              <label>Title</label>
              <SuggestInput field="project_title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Customer</label>
                <SuggestInput field="customer_name" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Competitor</label>
                <SuggestInput
                  field="competitor"
                  value={form.competitor}
                  onChange={(e) => setForm({ ...form, competitor: e.target.value })}
                  placeholder="Who else is bidding"
                />
              </div>
              <div className="form-row">
                <label>Value</label>
                <DecimalInput value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              </div>
              {isHr && (
                <div className="form-row">
                  <label>Owner</label>
                  <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
                    <option value="">—</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-row">
                <label>Stage</label>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Expected close date</label>
                <input type="date" value={form.expected_close_date} onChange={(e) => setForm({ ...form, expected_close_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create opportunity"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
