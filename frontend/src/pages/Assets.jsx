import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import SuggestInput from "../components/SuggestInput";

// Starting points only — the field stays free text, because the next thing a
// company hands someone is never on anybody's list.
const ASSET_TYPES = [
  "Laptop", "Desktop", "Monitor", "Mobile phone", "SIM card", "Tablet",
  "Vehicle", "Motorcycle", "Power tools", "Hand tools", "Safety equipment",
  "Uniform", "Access card", "Radio", "Camera", "Printer",
];

const STATUSES = ["active", "returned", "replaced"];

const EMPTY = {
  employee_id: "",
  asset_type: "",
  brand: "",
  model: "",
  serial_number: "",
  asset_tag: "",
  date_issued: "",
  date_returned: "",
  status: "active",
  condition_note: "",
  notes: "",
  market_value: "",
};

// 'active' is the only status that means the company's property is still out
// there, so it gets the badge that reads as "open" rather than "done".
const STATUS_BADGE = { active: "active", returned: "approved", replaced: "draft" };

// Requests waiting on somebody get the attention-seeking badge; settled ones
// read as done.
const REQUEST_BADGE = { pending: "pending", approved: "approved", rejected: "rejected", issued: "active" };

const EMPTY_REQUEST = { asset_type: "", quantity: 1, reason: "", needed_by: "" };

export default function Assets() {
  const { user } = useAuth();
  const { money } = useAppSettings();
  const isHr = user.role === "admin" || user.role === "hr";

  const [assets, setAssets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const [requests, setRequests] = useState([]);
  const [showRequest, setShowRequest] = useState(false);
  const [requestForm, setRequestForm] = useState(EMPTY_REQUEST);
  const [requestSaving, setRequestSaving] = useState(false);
  const [issuing, setIssuing] = useState(null); // the request being handed over
  const [busyRequestId, setBusyRequestId] = useState(null);

  const load = () =>
    api.get("/assets").then(setAssets).catch((err) => setError(err.message));

  const loadRequests = () =>
    api.get("/asset-requests").then(setRequests).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    loadRequests();
    // The employee picker is only ever shown to HR, so don't make every
    // employee fetch the whole staff list just to read their own two rows.
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
  }, [isHr]);

  const filtered = assets.filter((a) => {
    if (statusFilter && a.status !== statusFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [a.employee_name, a.asset_type, a.brand, a.model, a.serial_number, a.asset_tag, a.department_name]
      .some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filtered, "date_issued", "desc");

  const openNew = () => {
    setForm({ ...EMPTY, date_issued: new Date().toISOString().slice(0, 10) });
    setEditingId(null);
    setError("");
    setShowForm(true);
  };

  const openEdit = (a) => {
    setForm({
      employee_id: String(a.employee_id),
      asset_type: a.asset_type || "",
      brand: a.brand || "",
      model: a.model || "",
      serial_number: a.serial_number || "",
      asset_tag: a.asset_tag || "",
      date_issued: a.date_issued || "",
      date_returned: a.date_returned || "",
      status: a.status,
      condition_note: a.condition_note || "",
      notes: a.notes || "",
      market_value: a.market_value == null ? "" : String(a.market_value),
    });
    setEditingId(a.id);
    setError("");
    setShowForm(true);
  };

  // Returning an asset needs a date; defaulting it to today saves the extra
  // click, and clearing it on the way back to 'active' keeps the record honest
  // rather than leaving a return date on something still issued.
  const changeStatus = (status) =>
    setForm((prev) => ({
      ...prev,
      status,
      date_returned:
        status === "active" ? "" : prev.date_returned || new Date().toISOString().slice(0, 10),
    }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    const payload = { ...form, date_returned: form.status === "active" ? null : form.date_returned };
    try {
      if (editingId) await api.put(`/assets/${editingId}`, payload);
      else await api.post("/assets", payload);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a) => {
    if (
      !confirm(
        `Delete the ${a.asset_type} issued to ${a.employee_name}?\n\n` +
          "This removes it from the register entirely. To record that it came back, set its status to returned instead."
      )
    ) {
      return;
    }
    setDeletingId(a.id);
    setError("");
    try {
      await api.del(`/assets/${a.id}`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const submitRequest = async (e) => {
    e.preventDefault();
    setRequestSaving(true);
    setError("");
    try {
      await api.post("/asset-requests", requestForm);
      setShowRequest(false);
      setRequestForm(EMPTY_REQUEST);
      loadRequests();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequestSaving(false);
    }
  };

  const decide = async (r, decision) => {
    const note =
      decision === "rejected"
        ? prompt(`Why is ${r.employee_name}'s request for ${r.asset_type} being turned down?`) ?? null
        : prompt("Note for approval (optional)", "") ?? "";
    // A null note means the prompt was cancelled — treat that as "changed my
    // mind", not as an approval with no comment.
    if (decision === "rejected" && note === null) return;
    setBusyRequestId(r.id);
    setError("");
    try {
      await api.put(`/asset-requests/${r.id}/decision`, { decision, review_note: note });
      loadRequests();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyRequestId(null);
    }
  };

  const withdraw = async (r) => {
    if (!confirm(`Withdraw your request for ${r.asset_type}?`)) return;
    setBusyRequestId(r.id);
    setError("");
    try {
      await api.del(`/asset-requests/${r.id}`);
      loadRequests();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyRequestId(null);
    }
  };

  const openIssue = (r) =>
    setIssuing({
      request: r,
      form: {
        asset_type: r.asset_type,
        brand: "",
        model: "",
        serial_number: "",
        asset_tag: "",
        date_issued: new Date().toISOString().slice(0, 10),
        market_value: "",
        notes: "",
      },
    });

  const confirmIssue = async (e) => {
    e.preventDefault();
    setRequestSaving(true);
    setError("");
    try {
      await api.post(`/asset-requests/${issuing.request.id}/issue`, issuing.form);
      setIssuing(null);
      loadRequests();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequestSaving(false);
    }
  };

  const stillOut = assets.filter((a) => a.status === "active").length;
  const openRequests = requests.filter((r) => r.status === "pending").length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Company Assets</h1>
          <p className="subtitle">
            {isHr
              ? `Equipment issued to staff — ${stillOut} still out of ${assets.length} on record`
              : "Company equipment currently issued to you"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowRequest(true)}>
            Request an asset
          </button>
          {isHr && (
            <button className="btn" onClick={openNew}>
              + Issue asset
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {(requests.length > 0 || !isHr) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>
            Asset requests
            {isHr && openRequests > 0 && (
              <span className="badge badge-pending" style={{ marginLeft: 8, verticalAlign: "middle" }}>
                {openRequests} awaiting decision
              </span>
            )}
          </h2>
          {requests.length === 0 ? (
            <div className="empty-state">
              Nothing requested yet — use "Request an asset" for PPE, a hard hat, a vest or any other kit you need.
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {isHr && <th>Employee</th>}
                    <th>Asset</th>
                    <th>Qty</th>
                    <th>Reason</th>
                    <th>Needed by</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th>Decision note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      {isHr && (
                        <td>
                          {r.employee_name}
                          {r.department_name && (
                            <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{r.department_name}</div>
                          )}
                        </td>
                      )}
                      <td>{r.asset_type}</td>
                      <td>{r.quantity}</td>
                      <td>{r.reason || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.needed_by || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{(r.created_at || "").slice(0, 10)}</td>
                      <td>
                        <span className={`badge badge-${REQUEST_BADGE[r.status] || "neutral"}`}>{r.status}</span>
                        {r.status === "issued" && r.issued_serial && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{r.issued_serial}</div>
                        )}
                      </td>
                      <td>
                        {r.review_note || "—"}
                        {r.reviewed_by_name && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>by {r.reviewed_by_name}</div>
                        )}
                      </td>
                      <td>
                        <div className="col-actions">
                          {isHr && r.status === "pending" && (
                            <>
                              <button
                                className="btn btn-sm"
                                disabled={busyRequestId === r.id}
                                onClick={() => decide(r, "approved")}
                              >
                                Approve
                              </button>
                              <button
                                className="btn btn-sm btn-danger"
                                disabled={busyRequestId === r.id}
                                onClick={() => decide(r, "rejected")}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {isHr && r.status === "approved" && (
                            <button className="btn btn-sm" onClick={() => openIssue(r)}>
                              Issue now
                            </button>
                          )}
                          {!isHr && r.status === "pending" && (
                            <button
                              className="btn btn-sm btn-secondary"
                              disabled={busyRequestId === r.id}
                              onClick={() => withdraw(r)}
                            >
                              Withdraw
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-inline">
          <div className="form-row" style={{ flex: 1 }}>
            <input
              type="text"
              placeholder={isHr ? "Search by employee, type, brand, model, serial…" : "Search by type, brand, model, serial…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="form-row">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card card-wide">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Asset" sortKey="asset_type" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Brand" sortKey="brand" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Model" sortKey="model" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Serial number" sortKey="serial_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Asset tag" sortKey="asset_tag" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Issued" sortKey="date_issued" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Returned" sortKey="date_returned" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              {isHr && <SortTh label="Market value" sortKey="market_value" toggleSort={toggleSort} arrow={arrow} />}
              {isHr && <th></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                {isHr && (
                  <td>
                    {a.employee_name}
                    {a.department_name && (
                      <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{a.department_name}</div>
                    )}
                  </td>
                )}
                <td>{a.asset_type}</td>
                <td>{a.brand || "—"}</td>
                <td>{a.model || "—"}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.serial_number || "—"}</td>
                <td>{a.asset_tag || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{a.date_issued}</td>
                <td style={{ whiteSpace: "nowrap" }}>{a.date_returned || "—"}</td>
                <td>
                  <span className={`badge badge-${STATUS_BADGE[a.status] || "neutral"}`}>{a.status}</span>
                </td>
                {isHr && (
                  <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {a.market_value == null ? "—" : money(a.market_value)}
                  </td>
                )}
                {isHr && (
                  <td>
                    <div className="col-actions">
                      <button className="btn btn-sm btn-secondary" onClick={() => openEdit(a)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deletingId === a.id}
                        onClick={() => remove(a)}
                      >
                        {deletingId === a.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {assets.length === 0 && (
          <div className="empty-state">
            {isHr
              ? "Nothing issued yet — record the first company asset to start the register."
              : "You have no company assets on record."}
          </div>
        )}
        {assets.length > 0 && sorted.length === 0 && (
          <div className="empty-state">No assets match your search.</div>
        )}
      </div>

      {showRequest && (
        <div className="modal-backdrop" onClick={() => setShowRequest(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Request an asset</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Goes to admin/HR for approval. Nothing is issued until someone approves it.
            </p>
            <form onSubmit={submitRequest}>
              <div className="form-row">
                <label>What do you need?</label>
                <SuggestInput
                  field="asset_type"
                  options={ASSET_TYPES}
                  value={requestForm.asset_type}
                  onChange={(e) => setRequestForm({ ...requestForm, asset_type: e.target.value })}
                  placeholder="Hard hat, safety vest, gloves…"
                  required
                />
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Quantity</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={requestForm.quantity}
                    onChange={(e) => setRequestForm({ ...requestForm, quantity: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Needed by</label>
                  <input
                    type="date"
                    value={requestForm.needed_by}
                    onChange={(e) => setRequestForm({ ...requestForm, needed_by: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Reason</label>
                <textarea
                  rows={2}
                  value={requestForm.reason}
                  onChange={(e) => setRequestForm({ ...requestForm, reason: e.target.value })}
                  placeholder="Site work starting Monday, existing one is damaged…"
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRequest(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={requestSaving}>
                  {requestSaving ? "Sending…" : "Send request"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {issuing && (
        <div className="modal-backdrop" onClick={() => setIssuing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Issue to {issuing.request.employee_name}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Approved request #{issuing.request.id} — {issuing.request.quantity} × {issuing.request.asset_type}.
              Filling this in adds the item to the register and closes the request.
            </p>
            <form onSubmit={confirmIssue}>
              <div className="form-row">
                <label>Asset type</label>
                <SuggestInput
                  field="asset_type"
                  options={ASSET_TYPES}
                  value={issuing.form.asset_type}
                  onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, asset_type: e.target.value } })}
                  required
                />
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Brand</label>
                  <SuggestInput
                    field="asset_brand"
                    value={issuing.form.brand}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, brand: e.target.value } })}
                  />
                </div>
                <div className="form-row">
                  <label>Model</label>
                  <SuggestInput
                    field="asset_model"
                    value={issuing.form.model}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, model: e.target.value } })}
                  />
                </div>
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Serial number</label>
                  <input
                    value={issuing.form.serial_number}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, serial_number: e.target.value } })}
                  />
                </div>
                <div className="form-row">
                  <label>Asset tag</label>
                  <input
                    value={issuing.form.asset_tag}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, asset_tag: e.target.value } })}
                  />
                </div>
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Date issued</label>
                  <input
                    type="date"
                    value={issuing.form.date_issued}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, date_issued: e.target.value } })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Market value</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={issuing.form.market_value}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, market_value: e.target.value } })}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setIssuing(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={requestSaving}>
                  {requestSaving ? "Issuing…" : "Issue asset"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? "Edit asset" : "Issue an asset"}</h2>
            <form onSubmit={save}>
              <div className="form-row">
                <label>Issued to</label>
                <select
                  value={form.employee_id}
                  onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                  required
                >
                  <option value="" disabled>Select employee</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.first_name} {e.last_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Asset type</label>
                <SuggestInput
                  field="asset_type"
                  options={ASSET_TYPES}
                  value={form.asset_type}
                  onChange={(e) => setForm({ ...form, asset_type: e.target.value })}
                  placeholder="Laptop, vehicle, power tools…"
                  required
                />
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Brand</label>
                  <SuggestInput
                    field="asset_brand"
                    value={form.brand}
                    onChange={(e) => setForm({ ...form, brand: e.target.value })}
                    placeholder="Lenovo, Toyota…"
                  />
                </div>
                <div className="form-row">
                  <label>Model</label>
                  <SuggestInput
                    field="asset_model"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="ThinkPad T14, Hilux…"
                  />
                </div>
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Serial number</label>
                  <input
                    value={form.serial_number}
                    onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
                    placeholder="Chassis / IMEI / serial"
                  />
                </div>
                <div className="form-row">
                  <label>Asset tag</label>
                  <input
                    value={form.asset_tag}
                    onChange={(e) => setForm({ ...form, asset_tag: e.target.value })}
                    placeholder="Internal reference"
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Market value</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.market_value}
                  onChange={(e) => setForm({ ...form, market_value: e.target.value })}
                  placeholder="What the item is worth today"
                />
                <span className="subtitle" style={{ fontSize: 12 }}>
                  Visible to admin and HR only — never shown to the employee holding the asset.
                </span>
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Date issued</label>
                  <input
                    type="date"
                    value={form.date_issued}
                    onChange={(e) => setForm({ ...form, date_issued: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Status</label>
                  <select value={form.status} onChange={(e) => changeStatus(e.target.value)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {form.status !== "active" && (
                <div className="grid grid-2">
                  <div className="form-row">
                    <label>Date {form.status}</label>
                    <input
                      type="date"
                      value={form.date_returned}
                      onChange={(e) => setForm({ ...form, date_returned: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-row">
                    <label>Condition on return</label>
                    <input
                      value={form.condition_note}
                      onChange={(e) => setForm({ ...form, condition_note: e.target.value })}
                      placeholder="Good, screen cracked…"
                    />
                  </div>
                </div>
              )}
              <div className="form-row">
                <label>Notes</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Accessories included, replacement reason…"
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save changes" : "Issue asset"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
