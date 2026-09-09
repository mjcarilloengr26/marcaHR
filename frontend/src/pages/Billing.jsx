import { useEffect, useState } from "react";
import { api, downloadFile, getToken } from "../api/client";
import SuggestInput from "../components/SuggestInput";
import { useAppSettings } from "../context/AppSettingsContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

const emptyForm = { invoice_number: "", order_id: "", customer_name: "", amount: "", status: "draft", issue_date: "", due_date: "", notes: "", project_id: "" };
const STATUSES = ["draft", "approved", "sent", "paid", "overdue", "cancelled"];

export default function Billing() {
  const { money } = useAppSettings();
  const [invoices, setInvoices] = useState([]);
  const [orders, setOrders] = useState([]);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState(null);
  const [linesBusy, setLinesBusy] = useState(false);
  const [linesError, setLinesError] = useState("");
  const [notice, setNotice] = useState("");
  const [autoDrafts, setAutoDrafts] = useState([]);
  const [preview, setPreview] = useState(null);
  const [sendFor, setSendFor] = useState(null);
  const [sendBusy, setSendBusy] = useState(false);

  const load = () => {
    api.get("/invoices").then(setInvoices).catch((err) => setError(err.message));
    // Statements the app raised on its own. They have had no human eyes on
    // them yet, so they get their own section rather than being mixed into the
    // list where they would be indistinguishable from a reviewed draft.
    api.get("/invoices/pending-review").then(setAutoDrafts).catch(() => {});
  };

  useEffect(() => {
    load();
    api.get("/orders").then(setOrders).catch(() => {});
    api.get("/projects/options").then(setProjects).catch(() => {});
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const approve = async (inv) => {
    setError("");
    try {
      await api.post(`/invoices/${inv.id}/approve`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const unapprove = async (inv) => {
    setError("");
    try {
      await api.post(`/invoices/${inv.id}/unapprove`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // Asks the server what would happen before offering the button, so the
  // dialog can say who it is about to email rather than finding out on failure.
  const openSend = async (inv) => {
    setError("");
    setSendFor({ invoice: inv, check: null });
    try {
      setSendFor({ invoice: inv, check: await api.get(`/invoices/${inv.id}/send-check`) });
    } catch (err) {
      setError(err.message);
      setSendFor(null);
    }
  };

  const confirmSend = async () => {
    setSendBusy(true);
    setError("");
    try {
      const sent = await api.post(`/invoices/${sendFor.invoice.id}/send`);
      setSendFor(null);
      setNotice(
        `${sent.invoice_number} ${sent.resent ? "re-sent" : "sent"} to ${sent.sent_to_list.join(", ")}.`
      );
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSendBusy(false);
    }
  };

  const openPreview = async (inv) => {
    setError("");
    try {
      const res = await fetch(`/api/invoices/${inv.id}/pdf`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`Could not build the PDF (${res.status})`);
      // Wrapped in a File rather than used as a bare Blob: the object URL is
      // otherwise a bare UUID, and that is the name the browser's own PDF
      // viewer offers when someone saves from it.
      const file = new File([await res.blob()], `${inv.invoice_number}.pdf`, { type: "application/pdf" });
      setPreview({ invoice: inv, url: URL.createObjectURL(file) });
    } catch (err) {
      setError(err.message);
    }
  };

  const closePreview = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const openLines = async (inv) => {
    setLinesError("");
    setLinesBusy(true);
    setLines({ invoice: inv, rows: [] });
    try {
      const full = await api.get(`/invoices/${inv.id}`);
      setLines({ invoice: full, rows: full.items || [] });
    } catch (err) {
      setLinesError(err.message);
    } finally {
      setLinesBusy(false);
    }
  };

  const lineTotal = (r) => (Number(r.quantity) || 0) * (Number(r.unit_price) || 0);

  const inCurrency = (n, currency) =>
    `${currency || "PHP"} ` +
    (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const saveLines = async () => {
    setLinesBusy(true);
    setLinesError("");
    try {
      const saved = await api.put(`/invoices/${lines.invoice.id}/items`, {
        vat_rate: lines.invoice.vat_rate,
        currency: lines.invoice.currency,
        items: lines.rows.map((r) => ({
          description: r.description,
          quantity: r.quantity,
          unit: r.unit,
          unit_price: r.unit_price,
        })),
      });
      setLines({ invoice: saved, rows: saved.items || [] });
      load();
    } catch (err) {
      setLinesError(err.message);
    } finally {
      setLinesBusy(false);
    }
  };

  const openEdit = (inv) => {
    setEditingId(inv.id);
    setForm({
      invoice_number: inv.invoice_number,
      order_id: inv.order_id || "",
      project_id: inv.project_id || "",
      customer_name: inv.customer_name,
      amount: inv.amount,
      status: inv.status,
      issue_date: inv.issue_date || "",
      due_date: inv.due_date || "",
      notes: inv.notes || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        order_id: form.order_id || null,
        project_id: form.project_id || null,
        amount: Number(form.amount) || 0,
      };
      if (editingId) {
        await api.put(`/invoices/${editingId}`, payload);
      } else {
        await api.post("/invoices", payload);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Pre-fills the invoice form from an order's remaining balance rather than
  // creating the invoice outright, so the amount (and everything else) is
  // editable before it's saved — billing the full remainder isn't always what's
  // wanted (e.g. a further partial payment, a discount, a different due date).
  const openBillOrder = (order) => {
    const priorCount = invoices.filter((inv) => inv.order_id === order.id).length;
    const suggestedNumber = priorCount === 0 ? `INV-${order.order_number}` : `INV-${order.order_number}-${priorCount + 1}`;
    setEditingId(null);
    setForm({
      invoice_number: suggestedNumber,
      order_id: order.id,
      customer_name: order.customer_name,
      amount: order.remaining,
      status: "draft",
      issue_date: "",
      due_date: "",
      notes: "",
    });
    setShowForm(true);
  };

  const quickSetStatus = async (id, status) => {
    try {
      await api.put(`/invoices/${id}`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this invoice?")) return;
    try {
      await api.del(`/invoices/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // An order can carry more than one invoice (e.g. a partial invoice now, another
  // for the remainder later), so "not yet billed" must compare the order's amount
  // against the sum of its non-cancelled invoices, not just whether any invoice
  // exists — otherwise a partially-billed order (billed for less than its full
  // amount) would vanish from this list entirely, leaving its remaining balance
  // untracked and unbillable.
  const billedByOrder = invoices.reduce((acc, inv) => {
    if (inv.status === "cancelled" || !inv.order_id) return acc;
    acc[inv.order_id] = (acc[inv.order_id] || 0) + Number(inv.amount || 0);
    return acc;
  }, {});
  const unbilledOrders = orders
    .map((o) => ({ ...o, billed: billedByOrder[o.id] || 0, remaining: Math.max(o.amount - (billedByOrder[o.id] || 0), 0) }))
    .filter((o) => o.remaining > 0);

  // The cap for whatever order is currently selected in the form — mirrors the
  // backend's own check (server-side is what actually enforces the limit; this
  // is just so the field gives immediate feedback instead of a round-trip).
  // Excludes the invoice being edited from "already billed" so editing an
  // invoice's own amount doesn't count it against itself.
  const formOrderRemaining = (() => {
    if (!form.order_id) return null;
    const order = orders.find((o) => o.id === Number(form.order_id));
    if (!order) return null;
    const billedByOthers = invoices
      .filter((inv) => inv.order_id === Number(form.order_id) && inv.status !== "cancelled" && inv.id !== editingId)
      .reduce((sum, inv) => sum + Number(inv.amount || 0), 0);
    return Math.max(order.amount - billedByOthers, 0);
  })();

  const filteredInvoices = invoices.filter((inv) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [inv.invoice_number, inv.order_number, inv.customer_name, inv.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredInvoices, "issue_date", "desc");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Billing</h1>
          <p className="subtitle">Customer invoices, linked to orders</p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add invoice</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="card" style={{ marginBottom: 16 }}>
          {notice}{" "}
          <button className="btn btn-sm btn-secondary" onClick={() => setNotice("")}>Dismiss</button>
        </div>
      )}

      {unbilledOrders.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Orders not yet fully billed</h2>
          <table className="sticky-head">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Order amount</th>
                <th>Billed so far</th>
                <th>Remaining</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unbilledOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_number}</td>
                  <td>{o.customer_name}</td>
                  <td>{money(o.amount)}</td>
                  <td>{o.billed > 0 ? money(o.billed) : "—"}</td>
                  <td>{money(o.remaining)}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => openBillOrder(o)}>
                      {o.billed > 0 ? `+ Bill remaining ${money(o.remaining)}` : "+ Bill this order"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}


      {autoDrafts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>
            Raised automatically — {autoDrafts.length} awaiting review
          </h2>
          <p className="subtitle">
            The app created these from something that happened: an order delivered, a job completed, a milestone
            reached, or a recurring schedule falling due. Nothing has been sent. Check the amount and the lines, then
            approve.
          </p>
          <table className="sticky-head">
            <thead>
              <tr>
                <th>Statement #</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Raised by</th>
                <th>Reference</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {autoDrafts.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.invoice_number}</td>
                  <td>{inv.customer_name}</td>
                  <td>
                    {Number(inv.amount) > 0 ? (
                      inCurrency(inv.amount, inv.currency)
                    ) : (
                      <span className="badge badge-pending">needs pricing</span>
                    )}
                  </td>
                  <td>{inv.auto_source}</td>
                  <td className="subtitle" style={{ margin: 0 }}>{inv.auto_source_ref || "—"}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => openLines(inv)}>Lines</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => openPreview(inv)}>PDF</button>
                    <button
                      className="btn btn-sm"
                      disabled={Number(inv.amount) <= 0}
                      title={Number(inv.amount) <= 0 ? "Add an amount before approving" : ""}
                      onClick={() => approve(inv)}
                    >
                      Approve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by invoice #, order #, customer, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              <SortTh label="Invoice #" sortKey="invoice_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Order" sortKey="order_number" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Customer" sortKey="customer_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Amount" sortKey="amount" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Issue date" sortKey="issue_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Due date" sortKey="due_date" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Raised by" sortKey="created_by_name" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Last updated by" sortKey="status_changed_by_name" toggleSort={toggleSort} arrow={arrow} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.invoice_number}</td>
                <td>{inv.order_number || "—"}</td>
                <td>{inv.customer_name}</td>
                <td>{inv.currency && inv.currency !== "PHP" ? inCurrency(inv.amount, inv.currency) : money(inv.amount)}</td>
                <td>{inv.issue_date}</td>
                <td>{inv.due_date || "—"}</td>
                <td>
                  <select value={inv.status} onChange={(e) => quickSetStatus(inv.id, e.target.value)} style={{ width: "auto" }}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>{inv.created_by_name || "—"}</td>
                <td>
                  {inv.status_changed_by_name ? (
                    <>
                      {inv.status_changed_by_name}
                      {inv.status_changed_at && (
                        <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                          {inv.status_changed_at.slice(0, 10)} · {inv.status}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="subtitle" style={{ margin: 0 }}>—</span>
                  )}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openPreview(inv)}>PDF</button>
                  {inv.status === "draft" && (
                    <button className="btn btn-sm" onClick={() => approve(inv)}>Approve</button>
                  )}
                  {inv.status === "approved" && (
                    <>
                      <button className="btn btn-sm" onClick={() => openSend(inv)}>Send</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => unapprove(inv)}>Unapprove</button>
                    </>
                  )}
                  {["sent", "overdue"].includes(inv.status) && (
                    <button className="btn btn-sm btn-secondary" onClick={() => openSend(inv)}>Resend</button>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={() => openLines(inv)}>Lines</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(inv)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(inv.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invoices.length === 0 && <div className="empty-state">No invoices yet.</div>}
        {invoices.length > 0 && sorted.length === 0 && <div className="empty-state">No invoices match your search.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editingId ? "Edit invoice" : "Add invoice"}</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Invoice number</label>
                <input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Customer</label>
                <SuggestInput field="customer_name" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
              </div>
              <div className="form-row">
                <label>Related order</label>
                <select value={form.order_id} onChange={(e) => setForm({ ...form, order_id: e.target.value })}>
                  <option value="">—</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>{o.order_number} — {o.customer_name}</option>
                  ))}
                </select>
              </div>
              {projects.length > 0 && (
                <div className="form-row">
                  <label>Project</label>
                  <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                    <option value="">Not project work</option>
                    {projects.map((pr) => (
                      <option key={pr.id} value={pr.id}>{pr.code} — {pr.name}</option>
                    ))}
                  </select>
                  <span className="subtitle" style={{ fontSize: 12 }}>
                    Which job this belongs to. Leave blank for work that belongs to none.
                  </span>
                </div>
              )}
              <div className="form-row">
                <label>Amount{formOrderRemaining !== null && ` (up to ${money(formOrderRemaining)} remaining on this order)`}</label>
                <DecimalInput
                  value={form.amount}
                  max={formOrderRemaining !== null ? formOrderRemaining : undefined}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Issue date</label>
                <input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Due date</label>
                <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create invoice"}</button>
            </div>
          </form>
        </div>
      )}

      {lines && (
        <div className="modal-backdrop" onClick={() => setLines(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Lines — {lines.invoice.invoice_number}</h2>
            <p className="subtitle">{lines.invoice.customer_name}</p>

            {linesError && <div className="error-banner">{linesError}</div>}

            {lines.invoice.status !== "draft" && (
              <div className="card" style={{ marginBottom: 12 }}>
                This invoice is <strong>{lines.invoice.status}</strong>, so its lines are fixed. Cancel it and raise a
                new one if the charges need to change.
              </div>
            )}

            <table className="sticky-head">
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Description</th>
                  <th style={{ width: 90 }}>Qty</th>
                  <th style={{ width: 80 }}>Unit</th>
                  <th style={{ width: 130 }}>Unit price</th>
                  <th style={{ width: 120 }}>Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={r.description || ""}
                        placeholder="What is being charged for"
                        disabled={lines.invoice.status !== "draft"}
                        onChange={(e) => {
                          const rows = [...lines.rows];
                          rows[i] = { ...rows[i], description: e.target.value };
                          setLines({ ...lines, rows });
                        }}
                      />
                    </td>
                    <td>
                      <DecimalInput
                        value={r.quantity ?? 1}
                        disabled={lines.invoice.status !== "draft"}
                        onChange={(e) => {
                          const rows = [...lines.rows];
                          rows[i] = { ...rows[i], quantity: e.target.value };
                          setLines({ ...lines, rows });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        value={r.unit || ""}
                        placeholder="lot"
                        disabled={lines.invoice.status !== "draft"}
                        onChange={(e) => {
                          const rows = [...lines.rows];
                          rows[i] = { ...rows[i], unit: e.target.value };
                          setLines({ ...lines, rows });
                        }}
                      />
                    </td>
                    <td>
                      <DecimalInput
                        value={r.unit_price ?? 0}
                        disabled={lines.invoice.status !== "draft"}
                        onChange={(e) => {
                          const rows = [...lines.rows];
                          rows[i] = { ...rows[i], unit_price: e.target.value };
                          setLines({ ...lines, rows });
                        }}
                      />
                    </td>
                    <td>{inCurrency(lineTotal(r), lines.invoice.currency)}</td>
                    <td>
                      {lines.invoice.status === "draft" && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => setLines({ ...lines, rows: lines.rows.filter((_, j) => j !== i) })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(() => {
                  // Amounts are VAT-inclusive, so the gross is what the lines
                  // already come to and VAT is taken back out of it — never
                  // added on top, which would overstate what is owed.
                  const gross =
                    lines.rows.length > 0
                      ? lines.rows.reduce((n, r) => n + lineTotal(r), 0)
                      : Number(lines.invoice.amount) || 0;
                  const rate = Number(lines.invoice.vat_rate ?? 12);
                  const vatable = rate > 0 ? Math.round((gross / (1 + rate / 100)) * 100) / 100 : gross;
                  const vat = Math.round((gross - vatable) * 100) / 100;
                  return (
                    <>
                      <tr>
                        <td colSpan={4} style={{ textAlign: "right" }}>
                          Currency
                          <select
                            value={lines.invoice.currency || "PHP"}
                            disabled={lines.invoice.status !== "draft"}
                            style={{ width: 90, marginLeft: 8 }}
                            onChange={(e) =>
                              setLines({ ...lines, invoice: { ...lines.invoice, currency: e.target.value } })
                            }
                          >
                            <option value="PHP">PHP</option>
                            <option value="USD">USD</option>
                          </select>
                        </td>
                        <td></td>
                        <td></td>
                      </tr>
                      <tr>
                        <td colSpan={4} style={{ textAlign: "right" }}>VATable sales</td>
                        <td>{inCurrency(vatable, lines.invoice.currency)}</td>
                        <td></td>
                      </tr>
                      <tr>
                        <td colSpan={4} style={{ textAlign: "right" }}>
                          VAT
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={lines.invoice.vat_rate ?? 12}
                            disabled={lines.invoice.status !== "draft"}
                            style={{ width: 70, marginLeft: 8, marginRight: 4 }}
                            onChange={(e) =>
                              setLines({ ...lines, invoice: { ...lines.invoice, vat_rate: e.target.value } })
                            }
                          />
                          %
                        </td>
                        <td>{inCurrency(vat, lines.invoice.currency)}</td>
                        <td></td>
                      </tr>
                      <tr>
                        <td colSpan={4} style={{ textAlign: "right" }}><strong>Total amount due</strong></td>
                        <td><strong>{inCurrency(gross, lines.invoice.currency)}</strong></td>
                        <td></td>
                      </tr>
                    </>
                  );
                })()}
              </tbody>
            </table>

            {lines.rows.length === 0 && !linesBusy && (
              <div className="empty-state">
                No breakdown yet. This invoice is billed as a single amount of {money(lines.invoice.amount)}.
              </div>
            )}
            {linesBusy && <div className="empty-state">Working…</div>}

            {lines.invoice.status === "draft" && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() =>
                  setLines({ ...lines, rows: [...lines.rows, { description: "", quantity: 1, unit: "", unit_price: 0 }] })
                }
              >
                + Add line
              </button>
            )}

            <p className="subtitle" style={{ marginTop: 10 }}>
              Prices are VAT-inclusive, so VAT is taken out of the total rather than added on top. Set the rate to 0 for
              a zero-rated or exempt sale. The PDF prints the{" "}
              {(lines.invoice.currency || "PHP") === "USD" ? "US dollar account and SWIFT code" : "peso account"} to
              match this currency.
            </p>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <strong style={{ fontSize: 12 }}>References printed under the lines</strong>
              {lines.invoice.order_notes ? (
                <p style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{lines.invoice.order_notes}</p>
              ) : (
                <p className="subtitle" style={{ marginTop: 6 }}>
                  {lines.invoice.order_number
                    ? `Nothing yet. Add the PO number, quotation number and any other references to the Notes on order ${lines.invoice.order_number} and they will print here.`
                    : "This invoice is not linked to an order, so there are no references to print."}
                </p>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setLines(null)}>Close</button>
              {lines.invoice.status === "draft" && (
                <button type="button" className="btn" disabled={linesBusy} onClick={saveLines}>
                  {linesBusy ? "Saving…" : "Save lines"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={closePreview}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>{preview.invoice.invoice_number}</h2>
            <p className="subtitle">{preview.invoice.customer_name}</p>

            <iframe
              title={`Invoice ${preview.invoice.invoice_number}`}
              src={preview.url}
              style={{ width: "100%", height: "65vh", border: "1px solid var(--border)", borderRadius: 6 }}
            />

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={closePreview}>Close</button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  // Goes through downloadFile rather than the preview blob: it
                  // reads the filename off the response so the saved file is
                  // named for the invoice, not a random blob id.
                  downloadFile(`/invoices/${preview.invoice.id}/pdf`, `${preview.invoice.invoice_number}.pdf`).catch((err) =>
                    setError(err.message)
                  )
                }
              >
                Download PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {sendFor && (
        <div className="modal-backdrop" onClick={() => setSendFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Send {sendFor.invoice.invoice_number}</h2>
            {!sendFor.check && <div className="empty-state">Checking…</div>}

            {sendFor.check && !sendFor.check.ready && (
              <>
                <div className="error-banner">{sendFor.check.reason}</div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSendFor(null)}>Close</button>
                </div>
              </>
            )}

            {sendFor.check?.ready && (
              <>
                <p>
                  This will email the Statement of Account as a PDF attachment to{" "}
                  <strong>{sendFor.check.to}</strong>
                  {sendFor.check.cc.length > 0 && (
                    <>
                      , copying <strong>{sendFor.check.cc.join(", ")}</strong>
                    </>
                  )}
                  .
                </p>
                <p className="subtitle">
                  {["sent", "overdue"].includes(sendFor.invoice.status)
                    ? "This has already been sent — this sends another copy."
                    : "Nothing has been emailed to this customer yet."}
                </p>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSendFor(null)}>Cancel</button>
                  <button type="button" className="btn" disabled={sendBusy} onClick={confirmSend}>
                    {sendBusy ? "Sending…" : "Send to customer"}
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
