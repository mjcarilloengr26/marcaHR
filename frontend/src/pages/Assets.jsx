import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import SuggestInput from "../components/SuggestInput";
import DecimalInput from "../components/DecimalInput";
import { compressImageFile } from "../utils/image";

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
  quantity: 1,
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

// A filed return is pending until someone accepts it; accepted means the item
// is genuinely back, rejected means it never left the employee's record.
const RETURN_BADGE = { pending: "pending", accepted: "approved", rejected: "rejected" };

const EMPTY_REQUEST = { asset_type: "", quantity: 1, reason: "", needed_by: "" };

// Only appears once something is ticked, so a destructive control is not
// sitting armed on the page during ordinary browsing.
function BulkBar({ selected, clear, onDelete, busy }) {
  if (selected.size === 0) return null;
  return (
    <div
      className="card"
      style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}
    >
      <strong>{selected.size} selected</strong>
      <button type="button" className="link-btn" disabled={busy} onClick={() => clear(new Set())}>
        Clear selection
      </button>
      <span style={{ flex: 1 }} />
      <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} disabled={busy}>
        {busy ? "Deleting…" : `Delete ${selected.size} selected`}
      </button>
    </div>
  );
}

export default function Assets() {
  const { user } = useAuth();
  const { money } = useAppSettings();
  // A temporary Page Access grant on this page is what lets a stand-in receive
  // returned kit and act on requests while someone is away. The server honours
  // the grant on every endpoint this page uses, so the UI has to offer the
  // controls too — otherwise the grant unlocks an API nobody can reach.
  const hasAssetGrant = (user.page_grants || []).includes("assets");
  const isHr = user.role === "admin" || user.role === "hr" || hasAssetGrant;

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

  // Tick-box selections, one set per table — the two lists are different things
  // and clearing one should not clear the other.
  const [selectedAssets, setSelectedAssets] = useState(() => new Set());
  const [selectedRequests, setSelectedRequests] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // The asset being handed back, and the details of its return. This is HR
  // recording an in-person handover directly — separate from the returns an
  // employee files below, which need accepting before anything changes.
  const [returning, setReturning] = useState(null);

  // Returns filed by employees, awaiting acceptance.
  const [returns, setReturns] = useState([]);
  const [filing, setFiling] = useState(null); // { asset, form } — employee filing a return
  const [filingSaving, setFilingSaving] = useState(false);
  const [accepting, setAccepting] = useState(null); // { ret, form } — HR accepting one
  const [busyReturnId, setBusyReturnId] = useState(null);

  const load = () =>
    api.get("/assets").then(setAssets).catch((err) => setError(err.message));

  const loadRequests = () =>
    api.get("/asset-requests").then(setRequests).catch((err) => setError(err.message));

  const loadReturns = () =>
    api.get("/asset-returns").then(setReturns).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    loadRequests();
    loadReturns();
    // The employee picker is only ever shown to HR, so don't make every
    // employee fetch the whole staff list just to read their own two rows.
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
  }, [isHr]);

  useEffect(() => {
    setSelectedAssets((prev) => {
      const live = new Set(assets.map((a) => a.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [assets]);

  useEffect(() => {
    setSelectedRequests((prev) => {
      const live = new Set(requests.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [requests]);

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
      quantity: a.quantity ?? 1,
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
        // Carried from the request so the count is not quietly lost at the
        // point of issue, which is exactly what used to happen.
        quantity: r.quantity ?? 1,
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

  const toggleIn = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAsset = toggleIn(setSelectedAssets);
  const toggleRequest = toggleIn(setSelectedRequests);

  // One at a time rather than in parallel: a partial failure then names exactly
  // what survived, and these lists are short.
  const bulkDelete = async ({ ids, rows, endpoint, describe, after }) => {
    const targets = rows.filter((r) => ids.has(r.id));
    if (targets.length === 0) return;
    if (!confirm(describe(targets))) return;
    setBulkBusy(true);
    setError("");
    const failed = [];
    for (const r of targets) {
      try {
        await api.del(`${endpoint}/${r.id}`);
      } catch (err) {
        failed.push(`${r.asset_type}: ${err.message}`);
      }
    }
    setBulkBusy(false);
    if (failed.length) setError(`${failed.length} of ${targets.length} could not be deleted — ${failed.join("; ")}`);
    after();
  };

  const deleteSelectedAssets = () =>
    bulkDelete({
      ids: selectedAssets,
      rows: assets,
      endpoint: "/assets",
      describe: (t) =>
        `Delete ${t.length} asset${t.length === 1 ? "" : "s"} from the register?\n\n` +
        "This removes the record entirely. To record that something came back, use Return instead.",
      after: () => {
        setSelectedAssets(new Set());
        load();
      },
    });

  const deleteSelectedRequests = () =>
    bulkDelete({
      ids: selectedRequests,
      rows: requests,
      endpoint: "/asset-requests",
      describe: (t) => `Delete ${t.length} request${t.length === 1 ? "" : "s"}? This cannot be undone.`,
      after: () => {
        setSelectedRequests(new Set());
        loadRequests();
      },
    });

  const deleteRequest = async (r) => {
    if (!confirm(`Delete ${r.employee_name}'s request for ${r.asset_type}?`)) return;
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

  // Handing an item back is its own action rather than an edit: the register
  // needs the date and the condition it came back in, and burying that in the
  // full edit form is how those two fields end up empty.
  const openReturn = (a) =>
    setReturning({
      asset: a,
      form: {
        status: "returned",
        date_returned: new Date().toISOString().slice(0, 10),
        condition_note: "",
        notes: a.notes || "",
      },
    });

  // --- Returns filed by an employee ---------------------------------------
  // Filing one does not return the asset. It sits pending until HR accepts it,
  // and only acceptance moves the asset off the employee's record.

  const openFiling = (asset) => {
    setError("");
    setFiling({
      asset,
      form: {
        return_date: new Date().toISOString().slice(0, 10),
        employee_note: "",
        photo_name: "",
        photo_type: "",
        photo_data: "",
      },
      attaching: false,
    });
  };

  const attachReturnPhoto = async (file) => {
    if (!file) return;
    setError("");
    setFiling((f) => ({ ...f, attaching: true }));
    try {
      const data = await compressImageFile(file, 1200, 0.75);
      setFiling((f) => ({
        ...f,
        attaching: false,
        form: { ...f.form, photo_name: file.name, photo_type: "image/jpeg", photo_data: data },
      }));
    } catch (err) {
      setError(err.message);
      setFiling((f) => ({ ...f, attaching: false }));
    }
  };

  const submitFiling = async (e) => {
    e.preventDefault();
    setFilingSaving(true);
    setError("");
    try {
      await api.post("/asset-returns", { asset_id: filing.asset.id, ...filing.form });
      setFiling(null);
      await Promise.all([load(), loadReturns()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setFilingSaving(false);
    }
  };

  const withdrawReturn = async (ret) => {
    if (!confirm("Withdraw this return? The asset stays on the record and you can file again later.")) return;
    setBusyReturnId(ret.id);
    setError("");
    try {
      await api.del(`/asset-returns/${ret.id}`);
      await Promise.all([load(), loadReturns()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyReturnId(null);
    }
  };

  const rejectReturn = async (ret) => {
    const note = prompt("Why is this return not being accepted?\n\nThe item stays on the employee's record.");
    if (note === null) return;
    setBusyReturnId(ret.id);
    setError("");
    try {
      await api.put(`/asset-returns/${ret.id}`, { status: "rejected", review_note: note.trim() || null });
      await Promise.all([load(), loadReturns()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyReturnId(null);
    }
  };

  // Accepting is a statement about condition, so it goes through a form rather
  // than a single click.
  const openAccept = (ret) => {
    setError("");
    setAccepting({ ret, form: { asset_condition: "good", review_note: "" } });
  };

  const confirmAccept = async (e) => {
    e.preventDefault();
    setBusyReturnId(accepting.ret.id);
    setError("");
    try {
      await api.put(`/asset-returns/${accepting.ret.id}`, { status: "accepted", ...accepting.form });
      setAccepting(null);
      await Promise.all([load(), loadReturns()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyReturnId(null);
    }
  };

  const viewReturnPhoto = async (ret) => {
    setError("");
    try {
      const p = await api.get(`/asset-returns/${ret.id}/photo`);
      // Chrome and Edge block top-level navigation to a data: URL, so the
      // photo is opened through a synthesised anchor rather than window.open.
      const a = document.createElement("a");
      a.href = p.photo_data;
      a.download = p.photo_name || "returned-item.jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err.message);
    }
  };

  // An asset with a return already awaiting a decision must not offer the
  // button again.
  const pendingReturnFor = (assetId) =>
    returns.find((r) => r.asset_id === assetId && r.status === "pending");

  const confirmReturn = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.put(`/assets/${returning.asset.id}`, returning.form);
      setReturning(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const stillOut = assets.filter((a) => a.status === "active").length;
  const openRequests = requests.filter((r) => r.status === "pending").length;
  const openReturns = returns.filter((r) => r.status === "pending").length;

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
          {/* Issuing needs the staff list to pick a recipient, and a Page
              Access grantee is still an employee as far as /employees is
              concerned — so they get an empty picker. Better to not offer the
              button than to offer one that cannot be completed. Receiving
              returns, which is what the grant is for, works either way. */}
          {isHr && employees.length > 0 && (
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
                    {isHr && (
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all requests shown"
                          disabled={requests.length === 0}
                          checked={requests.length > 0 && selectedRequests.size === requests.length}
                          ref={(el) => {
                            if (el) el.indeterminate = selectedRequests.size > 0 && selectedRequests.size < requests.length;
                          }}
                          onChange={() =>
                            setSelectedRequests((prev) =>
                              prev.size === requests.length ? new Set() : new Set(requests.map((r) => r.id))
                            )
                          }
                        />
                      </th>
                    )}
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
                    <tr key={r.id} className={selectedRequests.has(r.id) ? "row-selected" : undefined}>
                      {isHr && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.asset_type}`}
                            checked={selectedRequests.has(r.id)}
                            onChange={() => toggleRequest(r.id)}
                          />
                        </td>
                      )}
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
                          {isHr && (
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={busyRequestId === r.id}
                              onClick={() => deleteRequest(r)}
                            >
                              {busyRequestId === r.id ? "Deleting…" : "Delete"}
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

      <BulkBar
        selected={selectedRequests}
        clear={setSelectedRequests}
        onDelete={deleteSelectedRequests}
        busy={bulkBusy}
      />

      {returns.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>
            Asset returns
            {openReturns > 0 && (
              <span className="badge badge-pending" style={{ marginLeft: 8 }}>
                {openReturns} awaiting acceptance
              </span>
            )}
          </h2>
          <p className="subtitle" style={{ margin: "0 0 10px" }}>
            {isHr
              ? "An item stays on the employee's record until the return is accepted. Accepting is also where its condition is recorded."
              : "Your item stays on your record until someone accepts the return."}
          </p>
          <div className="table-scroll">
            <table className="sticky-head">
              <thead>
                <tr>
                  {isHr && <th>Employee</th>}
                  <th>Asset</th>
                  <th>Serial number</th>
                  <th>Return date</th>
                  <th>Their note</th>
                  <th>Photo</th>
                  <th>Status</th>
                  <th>Condition</th>
                  <th>Decision note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    {isHr && (
                      <td>
                        {r.employee_name}
                        {r.department_name && (
                          <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{r.department_name}</div>
                        )}
                      </td>
                    )}
                    <td>
                      {r.asset_type}
                      {(r.brand || r.model) && (
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                          {[r.brand, r.model].filter(Boolean).join(" ")}
                        </div>
                      )}
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.serial_number || "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.return_date}</td>
                    <td>{r.employee_note || "—"}</td>
                    <td>
                      {r.has_photo ? (
                        <button type="button" className="link-btn location-link" onClick={() => viewReturnPhoto(r)}>
                          📷 view
                        </button>
                      ) : (
                        <span className="subtitle">none</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-${RETURN_BADGE[r.status] || "neutral"}`}>{r.status}</span>
                    </td>
                    <td>{r.asset_condition || "—"}</td>
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
                              disabled={busyReturnId === r.id}
                              onClick={() => openAccept(r)}
                            >
                              Accept
                            </button>
                            <button
                              className="btn btn-sm btn-secondary"
                              disabled={busyReturnId === r.id}
                              onClick={() => rejectReturn(r)}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {!isHr && r.status === "pending" && (
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={busyReturnId === r.id}
                            onClick={() => withdrawReturn(r)}
                          >
                            Withdraw
                          </button>
                        )}
                        {isHr && r.status !== "pending" && (
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={busyReturnId === r.id}
                            onClick={() => withdrawReturn(r)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      <BulkBar
        selected={selectedAssets}
        clear={setSelectedAssets}
        onDelete={deleteSelectedAssets}
        busy={bulkBusy}
      />

      <div className="card card-wide">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all assets shown"
                    disabled={sorted.length === 0}
                    checked={sorted.length > 0 && sorted.every((a) => selectedAssets.has(a.id))}
                    ref={(el) => {
                      if (el) {
                        const n = sorted.filter((a) => selectedAssets.has(a.id)).length;
                        el.indeterminate = n > 0 && n < sorted.length;
                      }
                    }}
                    onChange={(e) =>
                      setSelectedAssets(e.target.checked ? new Set(sorted.map((a) => a.id)) : new Set())
                    }
                  />
                </th>
              )}
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Asset" sortKey="asset_type" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Brand" sortKey="brand" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Model" sortKey="model" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Serial number" sortKey="serial_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Asset tag" sortKey="asset_tag" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Qty" sortKey="quantity" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Issued" sortKey="date_issued" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Returned" sortKey="date_returned" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              {isHr && <SortTh label="Market value" sortKey="market_value" toggleSort={toggleSort} arrow={arrow} />}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id} className={selectedAssets.has(a.id) ? "row-selected" : undefined}>
                {isHr && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${a.asset_type}`}
                      checked={selectedAssets.has(a.id)}
                      onChange={() => toggleAsset(a.id)}
                    />
                  </td>
                )}
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
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.quantity ?? 1}</td>
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
                <td>
                  <div className="col-actions">
                    {/* HR's "Return" records a handover that already happened.
                        An employee's "Return" files one for acceptance — the
                        asset does not move until someone accepts it. */}
                    {a.status === "active" &&
                      (pendingReturnFor(a.id) ? (
                        <span className="badge badge-pending">return pending</span>
                      ) : isHr ? (
                        <button className="btn btn-sm" onClick={() => openReturn(a)}>
                          Return
                        </button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => openFiling(a)}>
                          Return
                        </button>
                      ))}
                    {isHr && (
                      <>
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
                      </>
                    )}
                  </div>
                </td>
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
                <div className="form-row">
                  <label>Quantity</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={issuing.form.quantity}
                    onChange={(e) => setIssuing({ ...issuing, form: { ...issuing.form, quantity: e.target.value } })}
                  />
                  <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                    Prefilled from the request. Change it if a different number was actually handed over.
                  </div>
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
                  <DecimalInput
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

      {/* An employee filing a return. Nothing about the asset changes here —
          the wording says so, because a form that looks like it hands the item
          back and then does not is how people end up thinking they are clear. */}
      {filing && (
        <div className="modal-backdrop" onClick={() => setFiling(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Return {filing.asset.asset_type}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {[filing.asset.brand, filing.asset.model].filter(Boolean).join(" ")}
              {filing.asset.serial_number ? ` (${filing.asset.serial_number})` : ""}, issued to you on{" "}
              {filing.asset.date_issued}. This goes to admin/HR — the item stays on your record until
              they accept it and confirm its condition.
            </p>
            <form onSubmit={submitFiling}>
              <div className="form-row">
                <label>Date returned</label>
                <input
                  type="date"
                  value={filing.form.return_date}
                  max={new Date().toISOString().slice(0, 10)}
                  min={filing.asset.date_issued || undefined}
                  onChange={(e) =>
                    setFiling({ ...filing, form: { ...filing.form, return_date: e.target.value } })
                  }
                  required
                />
              </div>
              <div className="form-row">
                <label>Anything they should know? (optional)</label>
                <textarea
                  rows={3}
                  placeholder="e.g. the charger is included, there is a scratch on the lid"
                  value={filing.form.employee_note}
                  onChange={(e) =>
                    setFiling({ ...filing, form: { ...filing.form, employee_note: e.target.value } })
                  }
                />
              </div>
              <div className="form-row">
                <label>Photo of the item</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  disabled={filing.attaching}
                  onChange={(e) => attachReturnPhoto(e.target.files?.[0])}
                />
                <div className="subtitle" style={{ fontSize: 12, marginTop: 4 }}>
                  {filing.attaching
                    ? "Preparing the photo…"
                    : filing.form.photo_data
                      ? `Attached: ${filing.form.photo_name}`
                      : "Shows the condition it was handed back in. Strongly recommended — it is the only evidence if the condition is later disputed."}
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setFiling(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={filingSaving || filing.attaching}>
                  {filingSaving ? "Filing…" : "File return"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Accepting a return is the moment the asset actually comes back, and
          it is also the condition assessment — so the two are one form. */}
      {accepting && (
        <div className="modal-backdrop" onClick={() => setAccepting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Accept return</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {accepting.ret.asset_type}
              {accepting.ret.brand ? ` — ${accepting.ret.brand}` : ""}
              {accepting.ret.model ? ` ${accepting.ret.model}` : ""}
              {accepting.ret.serial_number ? ` (${accepting.ret.serial_number})` : ""}, returned by{" "}
              {accepting.ret.employee_name} on {accepting.ret.return_date}. Accepting takes it off their
              record and marks the asset returned.
            </p>
            {accepting.ret.employee_note && (
              <p className="subtitle" style={{ margin: "0 0 12px" }}>
                Their note: {accepting.ret.employee_note}
              </p>
            )}
            {accepting.ret.has_photo && (
              <p style={{ margin: "0 0 12px" }}>
                <button
                  type="button"
                  className="link-btn location-link"
                  onClick={() => viewReturnPhoto(accepting.ret)}
                >
                  📷 View the photo they attached
                </button>
              </p>
            )}
            <form onSubmit={confirmAccept}>
              <div className="form-row">
                <label>Condition received</label>
                <select
                  value={accepting.form.asset_condition}
                  onChange={(e) =>
                    setAccepting({ ...accepting, form: { ...accepting.form, asset_condition: e.target.value } })
                  }
                >
                  <option value="good">Good — no issues</option>
                  <option value="damaged">Damaged</option>
                  <option value="incomplete">Incomplete — parts or accessories missing</option>
                </select>
              </div>
              <div className="form-row">
                <label>
                  Note {accepting.form.asset_condition === "good" ? "(optional)" : "— what is wrong?"}
                </label>
                <textarea
                  rows={3}
                  required={accepting.form.asset_condition !== "good"}
                  placeholder={
                    accepting.form.asset_condition === "good"
                      ? "Anything worth recording"
                      : "Describe the damage or what is missing — this goes onto the asset record"
                  }
                  value={accepting.form.review_note}
                  onChange={(e) =>
                    setAccepting({ ...accepting, form: { ...accepting.form, review_note: e.target.value } })
                  }
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setAccepting(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={busyReturnId === accepting.ret.id}>
                  {busyReturnId === accepting.ret.id ? "Accepting…" : "Accept return"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {returning && (
        <div className="modal-backdrop" onClick={() => setReturning(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Return asset</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {returning.asset.asset_type}
              {returning.asset.brand ? ` — ${returning.asset.brand}` : ""}
              {returning.asset.model ? ` ${returning.asset.model}` : ""}
              {returning.asset.serial_number ? ` (${returning.asset.serial_number})` : ""}, issued to{" "}
              {returning.asset.employee_name} on {returning.asset.date_issued}.
            </p>
            <form onSubmit={confirmReturn}>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Date returned</label>
                  <input
                    type="date"
                    value={returning.form.date_returned}
                    onChange={(e) =>
                      setReturning({ ...returning, form: { ...returning.form, date_returned: e.target.value } })
                    }
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Outcome</label>
                  <select
                    value={returning.form.status}
                    onChange={(e) =>
                      setReturning({ ...returning, form: { ...returning.form, status: e.target.value } })
                    }
                  >
                    <option value="returned">Returned — back with the company</option>
                    <option value="replaced">Replaced — a new one was issued</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <label>Condition it came back in</label>
                <input
                  value={returning.form.condition_note}
                  onChange={(e) =>
                    setReturning({ ...returning, form: { ...returning.form, condition_note: e.target.value } })
                  }
                  placeholder="Good, screen cracked, missing charger…"
                />
                <span className="subtitle" style={{ fontSize: 12 }}>
                  Worth a line even when nothing is wrong — it is the only record of what came back.
                </span>
              </div>
              <div className="form-row">
                <label>Notes</label>
                <textarea
                  rows={2}
                  value={returning.form.notes}
                  onChange={(e) =>
                    setReturning({ ...returning, form: { ...returning.form, notes: e.target.value } })
                  }
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setReturning(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : "Record return"}
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
                <div className="form-row">
                  <label>Quantity</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Market value</label>
                <DecimalInput
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
