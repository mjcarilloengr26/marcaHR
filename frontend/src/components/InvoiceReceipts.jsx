import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
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
const KINDS = {
  payment: { label: "Payment received", badge: "badge-approved" },
  withholding: { label: "Tax withheld (2307)", badge: "badge-pending" },
  adjustment: { label: "Discount / retention / write-off", badge: "badge-draft" },
};

// The expanded withholding rates a customer is most likely to apply to MARCA:
// 1% on goods, 2% on services. Anything else — professional fees, a rate a
// particular customer insists on — goes in Other.
const RATES = [
  { value: "0", label: "None" },
  { value: "1", label: "With 2307 — 1% (goods)" },
  { value: "2", label: "With 2307 — 2% (services)" },
  { value: "other", label: "With 2307 — other rate" },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export default function InvoiceReceipts({ invoice, onSettled }) {
  const { moneyPrecise: money } = useAppSettings();
  const { user } = useAuth();
  // Correcting a date moves money between months on every report that reads
  // collections by date, so — like removing a payment — it is admin's to do.
  const isAdmin = user?.role === "admin";
  const [editingDate, setEditingDate] = useState(null); // { id, value }
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  // The payment being recorded. The two amounts start as null, meaning "use
  // the worked-out figure"; typing in either replaces it with what was typed.
  const [receivedOn, setReceivedOn] = useState(today);
  const [rateChoice, setRateChoice] = useState("0");
  const [otherRate, setOtherRate] = useState("");
  const [withheldTyped, setWithheldTyped] = useState(null);
  const [cashTyped, setCashTyped] = useState(null);
  const [reference, setReference] = useState("");
  const [ref2307, setRef2307] = useState("");

  // The rarer case — a discount, a retention, a write-off — on its own small
  // form, so the common one is not cluttered with a choice almost nobody needs.
  const [adjusting, setAdjusting] = useState(false);
  const [adj, setAdj] = useState({ amount: "", note: "" });

  const load = () =>
    api
      .get(`/invoices/${invoice.id}/receipts`)
      .then(setData)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  const remove = async (r) => {
    const kind = KINDS[r.kind];
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

  const saveDate = async (r) => {
    if (!editingDate || editingDate.value === r.received_on) {
      setEditingDate(null);
      return;
    }
    setBusyId(r.id);
    setError("");
    try {
      await api.patch(`/invoices/${invoice.id}/receipts/${r.id}`, { received_on: editingDate.value });
      setEditingDate(null);
      await load();
      onSettled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!data) return <div className="page-loading">Loading…</div>;

  const outstanding = round2(data.outstanding);
  const settledInFull = data.settlementStatus === "settled";

  // ── The arithmetic ──────────────────────────────────────────────────────
  //
  // Withholding is charged on the amount before VAT. The statement total
  // includes VAT, so the base is the total with the VAT taken back out — on
  // what is still outstanding, since that is what this payment settles. A
  // zero-rated or exempt statement carries no VAT, so its base is the total.
  //
  //   base     = outstanding ÷ (1 + VAT rate)
  //   withheld = base × withholding rate
  //   cash     = outstanding − withheld
  //
  // Both results are filled in rather than locked, because a 2307 is a
  // document the customer issued and its figure is what it says — usually a
  // centavo either side of the formula — and because customers do pay short.
  const vatPct = invoice.vat_treatment && invoice.vat_treatment !== "standard" ? 0 : Number(invoice.vat_rate) || 0;
  const rate = rateChoice === "other" ? Number(otherRate) || 0 : Number(rateChoice);
  const base = round2(outstanding / (1 + vatPct / 100));
  const autoWithheld = rate > 0 ? round2((base * rate) / 100) : 0;
  const withheld = withheldTyped === null ? autoWithheld : round2(withheldTyped);
  const autoCash = round2(Math.max(outstanding - withheld, 0));
  const cash = cashTyped === null ? autoCash : round2(cashTyped);
  const settles = round2(cash + withheld);
  const leftAfter = round2(outstanding - settles);
  const tooMuch = settles > outstanding + 0.004;

  const pickRate = (value) => {
    setRateChoice(value);
    // A new rate means a new withheld figure, and the cash follows it unless
    // somebody has already typed the amount that actually arrived.
    setWithheldTyped(null);
  };

  const recordPayment = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post(`/invoices/${invoice.id}/payments`, {
        received_on: receivedOn,
        cash,
        withheld,
        withholding_rate: withheld > 0 ? rate : 0,
        reference,
        form2307_ref: ref2307,
      });
      setRateChoice("0");
      setOtherRate("");
      setWithheldTyped(null);
      setCashTyped(null);
      setReference("");
      setRef2307("");
      await load();
      onSettled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const recordAdjustment = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post(`/invoices/${invoice.id}/receipts`, {
        kind: "adjustment",
        amount: Number(adj.amount),
        received_on: receivedOn,
        note: adj.note,
      });
      setAdj({ amount: "", note: "" });
      setAdjusting(false);
      await load();
      onSettled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

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
                const kind = KINDS[r.kind];
                return (
                  <tr key={r.id}>
                    <td className="col-nowrap">
                      {editingDate?.id === r.id ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <input
                            type="date"
                            value={editingDate.value}
                            min={invoice.issue_date || undefined}
                            max={today()}
                            onChange={(e) => setEditingDate({ id: r.id, value: e.target.value })}
                            aria-label="Date the payment was received"
                            autoFocus
                          />
                          <button type="button" className="btn btn-sm" disabled={busyId === r.id} onClick={() => saveDate(r)}>
                            Save
                          </button>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditingDate(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <>
                          {r.received_on}
                          {isAdmin && (
                            <button
                              type="button"
                              className="link-button"
                              style={{ marginLeft: 8, fontSize: 12 }}
                              onClick={() => setEditingDate({ id: r.id, value: r.received_on })}
                              title="Correct the date this payment was received"
                            >
                              Edit date
                            </button>
                          )}
                        </>
                      )}
                    </td>
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

      {settledInFull && (
        <div className="success-banner">
          Settled in full{data.lastReceivedOn ? ` on ${data.lastReceivedOn}` : ""}
          {data.withheld > 0 ? ` — ${money(data.paidCash)} banked and ${money(data.withheld)} withheld against a 2307.` : "."}
        </div>
      )}

      {!settledInFull && !adjusting && (
        <form onSubmit={recordPayment} className="payment-form">
          <h3 style={{ margin: "0 0 10px" }}>Record a payment</h3>

          <div className="form-inline" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <div className="form-row">
              <label>Date received</label>
              <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} required />
            </div>
            <div className="form-row" style={{ minWidth: 220 }}>
              <label>Tax withheld</label>
              <select value={rateChoice} onChange={(e) => pickRate(e.target.value)} aria-label="Was tax withheld (2307)?">
                {RATES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {rateChoice === "other" && (
              <div className="form-row" style={{ width: 110 }}>
                <label>Rate %</label>
                <input
                  type="number"
                  min="0.01"
                  max="99"
                  step="0.01"
                  value={otherRate}
                  onChange={(e) => {
                    setOtherRate(e.target.value);
                    setWithheldTyped(null);
                  }}
                  placeholder="e.g. 5"
                  required
                />
              </div>
            )}
          </div>

          {rate > 0 && (
            <p className="subtitle" style={{ margin: "8px 0 0", fontSize: 12 }}>
              {money(outstanding)} outstanding
              {vatPct > 0 ? ` ÷ ${1 + vatPct / 100} (less ${vatPct}% VAT) = ${money(base)} tax base` : " (no VAT on this statement) is the tax base"}
              {" "}× {rate}% = <strong>{money(autoWithheld)}</strong> withheld
            </p>
          )}

          <div className="form-inline" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            {rate > 0 && (
              <div className="form-row">
                <label>2307 amount</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={withheldTyped === null ? autoWithheld : withheldTyped}
                  onChange={(e) => setWithheldTyped(e.target.value)}
                />
              </div>
            )}
            <div className="form-row">
              <label>Cash received</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashTyped === null ? autoCash : cashTyped}
                onChange={(e) => setCashTyped(e.target.value)}
                required
              />
            </div>
            <div className="form-row" style={{ flex: 1, minWidth: 180 }}>
              <label>Deposit slip / cheque no.</label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
            </div>
            {rate > 0 && (
              <div className="form-row" style={{ flex: 1, minWidth: 150 }}>
                <label>2307 serial</label>
                <input value={ref2307} onChange={(e) => setRef2307(e.target.value)} placeholder="Optional — or add it later" />
              </div>
            )}
          </div>

          {/* What this will do, said before it is done. A short payment is not
              an error — the rest simply stays outstanding — but it should never
              be a surprise. */}
          <p style={{ margin: "10px 0", fontSize: 13 }}>
            {tooMuch ? (
              <span style={{ color: "var(--danger)" }}>
                That is {money(settles)} — more than the {money(outstanding)} outstanding.
              </span>
            ) : settles <= 0 ? (
              <span className="subtitle">Enter what was received.</span>
            ) : leftAfter <= 0.004 ? (
              <span style={{ color: "var(--success)" }}>
                Settles it in full — {money(cash)} cash{withheld > 0 ? ` + ${money(withheld)} withheld (2307)` : ""}.
              </span>
            ) : (
              <span style={{ color: "var(--warning)" }}>
                Settles {money(settles)}. <strong>{money(leftAfter)}</strong> will still be outstanding.
              </span>
            )}
          </p>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" disabled={saving || tooMuch || settles <= 0}>
              {saving ? "Recording…" : "Record payment"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdjusting(true)}>
              Discount, retention or write-off instead
            </button>
          </div>
          {/* The statement passed in is the one that was clicked, so its status
              is what it was then. The first payment moves a draft to sent, so
              once any exist this note is no longer true. */}
          {invoice.status === "draft" && data.receipts.length === 0 && (
            <p className="subtitle" style={{ fontSize: 12, margin: "8px 0 0" }}>
              This statement is still a draft. Recording a payment moves it to sent — money arriving means it was billed.
            </p>
          )}
        </form>
      )}

      {!settledInFull && adjusting && (
        <form onSubmit={recordAdjustment} className="form-inline" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div className="form-row">
            <label>Amount agreed off</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={outstanding}
              value={adj.amount}
              onChange={(e) => setAdj({ ...adj, amount: e.target.value })}
              required
            />
          </div>
          <div className="form-row" style={{ flex: 1, minWidth: 220 }}>
            <label>What was agreed, and with whom</label>
            <input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} required />
          </div>
          <button className="btn" disabled={saving || !adj.amount}>{saving ? "Recording…" : "Record"}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setAdjusting(false)}>Back to payment</button>
        </form>
      )}
    </div>
  );
}
