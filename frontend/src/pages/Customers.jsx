import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";

const emptyForm = {
  name: "",
  email: "",
  contact_person: "",
  phone: "",
  billing_address: "",
  tin: "",
  payment_terms_days: 30,
  status: "active",
  notes: "",
  cc_emails: [],
};

export default function Customers() {
  const { money } = useAppSettings();
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [sheetBusy, setSheetBusy] = useState(false);

  const load = () =>
    api
      .get("/customers")
      .then(setCustomers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError("");
    setShowForm(true);
  };

  const openEdit = (c) => {
    setEditingId(c.id);
    setForm({
      name: c.name || "",
      email: c.email || "",
      contact_person: c.contact_person || "",
      phone: c.phone || "",
      billing_address: c.billing_address || "",
      tin: c.tin || "",
      cc_emails: c.cc_emails || [],
      payment_terms_days: c.payment_terms_days ?? 30,
      status: c.status || "active",
      notes: c.notes || "",
    });
    setError("");
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editingId) await api.put(`/customers/${editingId}`, form);
      else await api.post("/customers", form);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openSheet = async (c) => {
    setSheetBusy(true);
    setSheet({ id: c.id, name: c.name });
    try {
      setSheet(await api.get(`/customers/${c.id}`));
    } catch (err) {
      setError(err.message);
      setSheet(null);
    } finally {
      setSheetBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (!showInactive && c.status !== "active") return false;
      if (!q) return true;
      return [c.name, c.email, c.contact_person, c.tin].some((v) => (v || "").toLowerCase().includes(q));
    });
  }, [customers, search, showInactive]);

  const { sorted, toggleSort, arrow } = useSort(visible, "name", "asc");

  // An invoice cannot be emailed to a customer with no address, so the gap is
  // shown up front rather than discovered when someone tries to send one.
  const missingEmail = customers.filter((c) => c.status === "active" && !c.email).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Customers</h1>
          <p className="subtitle">Contact and billing details used across orders, projects and invoices</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add customer</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {missingEmail > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>{missingEmail}</strong> active {missingEmail === 1 ? "customer has" : "customers have"} no email
          address yet. Invoices cannot be sent to them until one is added.
        </div>
      )}

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search by name, email, contact, TIN…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              <SortTh label="Customer" sortKey="name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Contact" sortKey="contact_person" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Email" sortKey="email" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Terms" sortKey="payment_terms_days" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Invoices" sortKey="invoice_count" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Billed" sortKey="total_billed" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Outstanding" sortKey="outstanding" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id}>
                <td>
                  <button className="link-btn" onClick={() => openSheet(c)}>
                    {c.name}
                  </button>
                  {c.status !== "active" && <span className="badge badge-inactive">inactive</span>}
                </td>
                <td>{c.contact_person || "—"}</td>
                <td>
                  {c.email || <span className="badge badge-pending">no email</span>}
                  {c.cc_emails?.length > 0 && <span className="subtitle"> +{c.cc_emails.length}</span>}
                </td>
                <td>{c.payment_terms_days} days</td>
                <td>{c.invoice_count}</td>
                <td>{money(c.total_billed)}</td>
                <td>{Number(c.outstanding) > 0 ? <strong>{money(c.outstanding)}</strong> : "—"}</td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(c)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="empty-state">Loading customers…</div>}
        {!loading && sorted.length === 0 && <div className="empty-state">No customers match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? "Edit customer" : "Add customer"}</h2>
            <form onSubmit={save}>
              <div className="form-row">
                <label>
                  Customer name
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
                </label>
                <label>
                  Contact person
                  <input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
                </label>
              </div>

              <div className="form-row">
                <label>
                  Email
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="billing@customer.com"
                  />
                </label>
                <label>
                  Phone
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </label>
              </div>

              <div className="form-row">
                <label>Also copy to</label>
                {(form.cc_emails || []).map((addr, i) => (
                  <span key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    <input
                      type="email"
                      value={addr}
                      placeholder="accounts@customer.com"
                      style={{ flex: 1 }}
                      onChange={(e) => {
                        const next = [...(form.cc_emails || [])];
                        next[i] = e.target.value;
                        setForm({ ...form, cc_emails: next });
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => setForm({ ...form, cc_emails: (form.cc_emails || []).filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setForm({ ...form, cc_emails: [...(form.cc_emails || []), ""] })}
                >
                  + Add another recipient
                </button>
              </div>

              <div className="form-row">
                <label>
                  TIN
                  <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
                </label>
                <label>
                  Payment terms (days)
                  <input
                    type="number"
                    min="0"
                    max="365"
                    value={form.payment_terms_days}
                    onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value })}
                  />
                </label>
              </div>

              <div className="form-row">
                <label>Billing address</label>
                <textarea rows={2} value={form.billing_address} onChange={(e) => setForm({ ...form, billing_address: e.target.value })} />
              </div>

              <div className="form-row">
                <label>
                  Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              </div>

              <div className="form-row">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {sheet && (
        <div className="modal-backdrop" onClick={() => setSheet(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{sheet.name}</h2>
            {sheetBusy && <div className="empty-state">Loading…</div>}
            {!sheetBusy && (
              <>
                <div className="grid grid-2">
                  <p><strong>Contact</strong><br />{sheet.contact_person || "—"}</p>
                  <p>
                    <strong>Email</strong>
                    <br />
                    {sheet.email || "—"}
                    {sheet.cc_emails?.length > 0 && (
                      <>
                        <br />
                        <span className="subtitle">copy to {sheet.cc_emails.join(", ")}</span>
                      </>
                    )}
                  </p>
                  <p><strong>Phone</strong><br />{sheet.phone || "—"}</p>
                  <p><strong>TIN</strong><br />{sheet.tin || "—"}</p>
                  <p><strong>Payment terms</strong><br />{sheet.payment_terms_days} days</p>
                  <p><strong>Outstanding</strong><br />{money(sheet.outstanding || 0)}</p>
                </div>

                {sheet.billing_address && (
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    <strong>Billing address</strong>
                    <br />
                    {sheet.billing_address}
                  </p>
                )}

                <h3>Invoices ({sheet.invoices?.length || 0})</h3>
                {sheet.invoices?.length ? (
                  <table className="sticky-head">
                    <thead>
                      <tr><th>Number</th><th>Issued</th><th>Amount</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {sheet.invoices.map((i) => (
                        <tr key={i.id}>
                          <td>{i.invoice_number}</td>
                          <td>{i.issue_date}</td>
                          <td>{money(i.amount)}</td>
                          <td><span className={`badge badge-${i.status}`}>{i.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>None yet.</p>
                )}

                <h3>Projects ({sheet.projects?.length || 0})</h3>
                {sheet.projects?.length ? (
                  <table className="sticky-head">
                    <thead>
                      <tr><th>Code</th><th>Name</th><th>Contract</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {sheet.projects.map((p) => (
                        <tr key={p.id}>
                          <td>{p.code}</td>
                          <td>{p.name}</td>
                          <td>{money(p.contract_value)}</td>
                          <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>None yet.</p>
                )}

                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSheet(null)}>Close</button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      const c = customers.find((x) => x.id === sheet.id);
                      setSheet(null);
                      if (c) openEdit(c);
                    }}
                  >
                    Edit
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
