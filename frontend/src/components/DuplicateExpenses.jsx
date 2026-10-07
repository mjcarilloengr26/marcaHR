import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

// Expense lines that look like one receipt claimed twice, put in front of the
// person who can tell.
//
// Deliberately a section on the page Finance already works in rather than a
// screen of its own: a separate page is a page nobody opens, and a check
// nobody runs is not a control. Closed by default, with the count and the
// money at stake on the header, so it announces itself without being in the
// way on the days there is nothing to do.
//
// Nothing here rejects anything. The check finds candidates; it cannot know
// whether two identical tricycle fares on one day were two rides or one
// receipt keyed twice. A verdict is recorded against the cluster — who, when
// and why — and rejecting the report itself stays the ordinary, deliberate
// act it already was.

const TONE = {
  certain: { cls: "badge-rejected", word: "Certain" },
  strong: { cls: "badge-pending", word: "Strong" },
  "worth a look": { cls: "badge-draft", word: "Worth a look" },
};

export default function DuplicateExpenses({ onChanged }) {
  const { moneyPrecise: money } = useAppSettings();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [showReviewed, setShowReviewed] = useState(false);

  const load = () =>
    api
      .get("/expenses/duplicates")
      .then(setData)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const decide = async (cluster, verdict) => {
    const prompts = {
      cleared: `Why are these not duplicates?\n\nRecorded against ${cluster.items.length} lines, for whoever looks at this later.`,
      confirmed: `What did you find?\n\nThis records the finding. It does not reject the reports — do that on the reports themselves.`,
    };
    const note = prompt(prompts[verdict], "");
    if (note === null) return;
    setBusy(cluster.key);
    setError("");
    try {
      setData(await api.put(`/expenses/duplicates/${encodeURIComponent(cluster.key)}/review`, { verdict, note }));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // Asking is a step before deciding, not a decision. The cluster stays open
  // and simply says who it is waiting on.
  const ask = async (cluster) => {
    const names = [...new Set(cluster.items.map((i) => i.employee_name))];
    if (
      !confirm(
        `Email ${names.join(" and ")} to ask about ${cluster.items.length} lines?\n\n` +
          "They are shown only their own lines, told that nothing has been rejected, and asked to reply."
      )
    ) {
      return;
    }
    setBusy(cluster.key);
    setError("");
    try {
      const res = await api.post(`/expenses/duplicates/${encodeURIComponent(cluster.key)}/ask`, {});
      setData(res);
      if (res.failed?.length) setError(`Some messages did not send — ${res.failed.join("; ")}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const reopen = async (cluster) => {
    setBusy(cluster.key);
    setError("");
    try {
      setData(await api.del(`/expenses/duplicates/${encodeURIComponent(cluster.key)}/review`));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // Nothing found and nothing ever judged: no card at all. An empty control is
  // noise on every other day of the year.
  if (!data || data.clusters.length === 0) return null;

  const waiting = data.clusters.filter((c) => !c.review && c.asked).length;
  // A cluster somebody has ruled on is out of the worklist. It is kept, behind
  // its own fold — the judgement and the reason for it are the audit trail
  // this whole feature exists to produce, and deleting them would leave the
  // next person to look at these lines with the same question and no answer.
  // But a settled item sitting in the list of things to settle is just noise.
  const openClusters = data.clusters.filter((c) => !c.review);
  const reviewedClusters = data.clusters.filter((c) => c.review);

  // One cluster, rendered the same whether it is waiting for a decision or
  // carrying one.
  const renderCluster = (c) => {
        const tone = TONE[c.certainty] || TONE.strong;
        const done = !!c.review;
        return (
          <div
            key={c.key}
            className="card"
            style={{ marginBottom: 12, opacity: done ? 0.62 : 1 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className={`badge ${tone.cls}`}>{tone.word}</span>
              <strong style={{ fontSize: 13 }}>{c.label}</strong>
              <span style={{ flex: 1 }} />
              {c.exposure > 0 && (
                <span className="subtitle" style={{ margin: 0, fontSize: 12 }}>
                  {money(c.exposure)} would be paid twice
                </span>
              )}
            </div>
            <p className="subtitle" style={{ margin: "4px 0 8px", fontSize: 12 }}>{c.detail}</p>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Vendor</th>
                    <th>Description</th>
                    <th>Receipt no.</th>
                    <th>Amount</th>
                    <th>Report</th>
                  </tr>
                </thead>
                <tbody>
                  {c.items.map((i) => (
                    <tr key={i.item_id}>
                      <td>{i.employee_name}</td>
                      <td className="col-nowrap">{i.expense_date}</td>
                      <td>{i.supplier_name || "—"}</td>
                      <td>{i.description || i.category || "—"}</td>
                      <td className="col-nowrap">{i.receipt_ref || "—"}</td>
                      <td className="col-nowrap">{money(i.amount)}</td>
                      <td className="col-nowrap">
                        {/* Carries the line id too, so the report opens with
                            the line in question already marked. */}
                        <Link
                          to={`/expenses?report=${i.report_id}&items=${i.item_id}`}
                          className="location-link"
                        >
                          {i.title || `#${i.report_id}`}
                        </Link>
                        {/* Whether this one has already been paid is the
                            first thing a reviewer needs: a reimbursed line
                            beside a submitted one is money about to go out
                            a second time. */}
                        <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
                          {i.status}
                          {i.has_receipt ? " · receipt attached" : " · no receipt"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* One button per report rather than one for the cluster. Judging a
                pair means reading both sides, and they are usually different
                reports — Laiza's September lunches sit on a reimbursed report
                and a draft, and you need both open to tell which is which. */}
            {!done && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                <span className="subtitle" style={{ margin: 0, fontSize: 12 }}>Open</span>
                {[...new Map(c.items.map((i) => [i.report_id, i])).values()].map((i) => (
                  <Link
                    key={i.report_id}
                    to={`/expenses?report=${i.report_id}&items=${c.items
                      .filter((x) => x.report_id === i.report_id)
                      .map((x) => x.item_id)
                      .join(",")}`}
                    className="btn btn-sm btn-secondary"
                  >
                    {i.title || `#${i.report_id}`} · {i.status}
                  </Link>
                ))}
              </div>
            )}

            {done ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                <span className={`badge ${c.review.verdict === "confirmed" ? "badge-rejected" : "badge-approved"}`}>
                  {c.review.verdict === "confirmed" ? "Confirmed duplicate" : "Not a duplicate"}
                </span>
                <span className="subtitle" style={{ margin: 0, fontSize: 12 }}>
                  {c.review.note ? `“${c.review.note}” — ` : ""}
                  {c.review.decided_at}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy === c.key}
                  onClick={() => reopen(c)}
                >
                  Reopen
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy === c.key}
                  onClick={() => ask(c)}
                >
                  {c.asked ? "Ask again" : "Ask the employee"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy === c.key}
                  onClick={() => decide(c, "cleared")}
                >
                  Not a duplicate
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy === c.key}
                  onClick={() => decide(c, "confirmed")}
                >
                  Confirm duplicate
                </button>
                <span className="subtitle" style={{ margin: 0, fontSize: 11 }}>
                  {c.asked
                    ? `Asked ${c.asked.to} on ${c.asked.at}${c.asked.by ? ` by ${c.asked.by}` : ""} — waiting on a reply.`
                    : "Confirming records the finding — reject the report itself on its own row."}
                </span>
              </div>
            )}
          </div>
        );
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <button
        type="button"
        className="link-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", fontSize: 14 }}
      >
        <span aria-hidden="true" style={{ fontSize: 11, width: 10 }}>{open ? "▼" : "▶"}</span>
        <strong>Possible duplicate receipts</strong>
        {data.open_count > 0 ? (
          <span className="badge badge-pending">{data.open_count} to review</span>
        ) : (
          <span className="badge badge-approved">all reviewed</span>
        )}
        {waiting > 0 && <span className="badge badge-draft">{waiting} awaiting a reply</span>}
        {data.exposure > 0 && (
          <span className="subtitle" style={{ margin: 0, fontSize: 12 }}>
            {money(data.exposure)} at stake
          </span>
        )}
      </button>

      {!open && (
        <p className="subtitle" style={{ margin: "6px 0 0", fontSize: 12, paddingLeft: 18 }}>
          Lines that may be the same receipt claimed twice. Nothing is blocked — these are for someone to judge.
        </p>
      )}

      {open && (
        <div style={{ marginTop: 12 }}>
          {error && <div className="error-banner">{error}</div>}

          {openClusters.length === 0 && (
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Nothing to review. Every pair the checks found has been ruled on.
            </p>
          )}

          {openClusters.map(renderCluster)}

          {/* Settled, and out of the way. Kept rather than deleted because the
              judgement and the reason for it are the whole point of the
              exercise: the next person to notice these two identical fares
              should find the answer, not the question again. */}
          {reviewedClusters.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
              <button
                type="button"
                className="link-btn"
                aria-expanded={showReviewed}
                onClick={() => setShowReviewed((v) => !v)}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
              >
                <span aria-hidden="true" style={{ fontSize: 10, width: 9 }}>{showReviewed ? "▼" : "▶"}</span>
                Already reviewed
                <span className="badge badge-draft">{reviewedClusters.length}</span>
              </button>
              {showReviewed && <div style={{ marginTop: 10 }}>{reviewedClusters.map(renderCluster)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
