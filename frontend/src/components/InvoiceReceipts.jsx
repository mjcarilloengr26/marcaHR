import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

// What actually settled a statement, and what is still owed.
//
// Before this a statement was paid or not paid, and a customer who paid less
// than the face value had nowhere to go. Marking it paid overstated what was
// collected; leaving it sent understated it; and editing the amount down was
// worse than either, because what is left to bill on an order is the order
// less the invoices raised against it — so reducing an invoice silently made
// the shortfall billable all over again.
//
// Three kinds settle a receivable and only one of them is money. Keeping them
// apart is the whole point: a customer who withheld tax owes nothing, and
// chasing them for it is chasing somebody who has already paid.
const KINDS = [
  {
    value: "payment",
    label: "Payment received",
    hint: "Cash actually banked. The deposit slip or cheque number goes in the reference.",
    badge: "badge-approved",
  },
  {
    value: "withholding",
    label: "Tax withheld (2307)",
    hint: "Creditable tax the customer remitted to the BIR for you. It settles the statement but never reaches the bank — put the 2307 serial in the reference.",
    badge: "badge-pending",
  },
  {
    value: "adjustment",
    label: "Discount / retention / write-off",
    hint: "Agreed and will never be paid. Say what was agreed, and with whom, in the note.",
    badge: "badge-draft",
  },
];

const EMPTY = { kind: "payment", amount: "", received_on: new Date().toISOString().slice(0, 10), reference: "", note: "" };

export default function InvoiceReceipts({ invoice, onSettled }) {
  const { moneyPrecise: money } = useAppSettings();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .get(`/invoices/${invoice.id}/receipts`)
      .then(setData)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  const add = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post(`/invoices/${invoice.id}/receipts`, { ...form, amount: Number(form.amount) });
      setForm({ ...EMPTY, received_on: form.received_on });
      await load();
      onSettled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r) => {
    const kind = KINDS.find((k) => k.value === r.kind);
    if (!confirm(`Remove this ${kind ? kind.label.toLowerCase() : r.kind} of ${money(r.amount)}?\n\nIf it settled the statement, it goes back to unpaid.`)) {
      return;
    }
    setBusyId(r.id);
    setError("");
    try {
      await api.del(`/invoices/${invoice.id}/receipts/${r.id}`);
      await load();
      onSettled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!data) return <div className="page-loading">Loading…</div>;

  const settled = data.settlementStatus === "settled";
  const open = ["sent", "overdue"].includes(invoice.status) || data.receipts.length > 0;

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="stat-card">
          <div className="stat-value">{money(invoice.amount)}</div>
          <div className="stat-label">Statement total</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: data.outstanding > 0 ? "var(--warning)" : undefined }}>
            {money(data.outstanding)}
          </div>
          <div className="stat-label">{data.overpaid ? "Overpaid" : "Still outstanding"}</div>
        </div>
        {/* Cash and withheld tax are shown apart because they answer different
            questions: what reached the bank, and what 2307s are owed to us at
            filing time. Added together they answer neither. */}
        <div className="stat-card">
          <div className="stat-value">{money(data.paidCash)}</div>
          <div className="stat-label">Cash received</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(data.withheld)}</div>
          <div className="stat-label">Tax withheld · 2307</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data.receipts.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Reference</th>
                <th>Note</th>
                <th>Recorded by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.receipts.map((r) => {
                const kind = KINDS.find((k) => k.value === r.kind);
                return (
                  <tr key={r.id}>
                    <td className="col-nowrap">{r.received_on}</td>
                    <td className="col-nowrap">
                      <span className={`badge ${kind ? kind.badge : "badge-draft"}`}>{kind ? kind.label : r.kind}</span>
                    </td>
                    <td className="col-nowrap">{money(r.amount)}</td>
                    <td>{r.reference || "—"}</td>
                    <td>{r.note || "—"}</td>
                    <td className="col-nowrap subtitle" style={{ margin: 0 }}>{r.recorded_by_name || "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busyId === r.id}
                        onClick={() => remove(r)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {settled && (
        <div className="success-banner">
          Settled in full{data.lastReceivedOn ? ` on ${data.lastReceivedOn}` : ""}
          {data.withheld > 0 ? ` — ${money(data.paidCash)} banked and ${money(data.withheld)} withheld against a 2307.` : "."}
        </div>
      )}

      {/* A draft has not been sent, so there is nothing for a customer to have
          settled. The server refuses it either way; not offering the form is
          so nobody fills one in to be told no. */}
      {!open ? (
        <p className="subtitle">
          Receipts can be recorded once the statement has been sent. This one is <strong>{invoice.status}</strong>.
        </p>
      ) : settled ? null : (
        <form className="form-inline" onSubmit={add} style={{ alignItems: "flex-end", gap: 10 }}>
          <div className="form-row">
            <label>What settled it</label>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Amount</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={data.outstanding}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder={String(data.outstanding)}
              required
            />
          </div>
          <div className="form-row">
            <label>Date</label>
            <input
              type="date"
              value={form.received_on}
              onChange={(e) => setForm({ ...form, received_on: e.target.value })}
              required
            />
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label>Reference</label>
            <input
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
              placeholder={form.kind === "withholding" ? "2307 serial" : form.kind === "payment" ? "Deposit slip / cheque no." : "What was agreed"}
            />
          </div>
          <button className="btn" disabled={saving || !form.amount}>
            {saving ? "Recording…" : "Record"}
          </button>
        </form>
      )}

      {open && !settled && (
        <p className="subtitle" style={{ fontSize: 12, marginTop: 6 }}>
          {KINDS.find((k) => k.value === form.kind)?.hint}
        </p>
      )}
    </div>
  );
}
