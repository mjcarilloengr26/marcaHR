import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// The review is written as markdown with a known, small set of constructs —
// headings, paragraphs, bullets and bold. Rendering that subset directly beats
// pulling in a markdown library for six tag types.
function Narrative({ text }) {
  const blocks = [];
  let list = null;

  const inline = (s, key) => {
    // **bold** is the only inline markup the prompt asks for.
    const parts = s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return (
      <span key={key}>
        {parts.map((p, i) =>
          p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p
        )}
      </span>
    );
  };

  const flush = () => {
    if (list) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} style={{ margin: "0 0 14px", paddingLeft: 20, lineHeight: 1.65 }}>
          {list.map((li, i) => (
            <li key={i} style={{ marginBottom: 6 }}>{inline(li, i)}</li>
          ))}
        </ul>
      );
      list = null;
    }
  };

  for (const raw of (text || "").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flush();
      blocks.push(
        <h3 key={`h-${blocks.length}`} style={{ fontSize: 15, margin: "22px 0 8px" }}>
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith("- ")) {
      list = list || [];
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={`p-${blocks.length}`} style={{ margin: "0 0 12px", lineHeight: 1.7 }}>
          {inline(line, 0)}
        </p>
      );
    }
  }
  flush();
  return <div>{blocks}</div>;
}

// A figure with its previous-period counterpart, so movement is visible without
// the reader doing arithmetic.
function Figure({ label, value, previous, money, suffix = "" }) {
  const fmt = (v) =>
    v === null || v === undefined ? "—" : money ? money(v) : `${Number(v).toLocaleString()}${suffix}`;
  const delta =
    typeof value === "number" && typeof previous === "number" && previous !== 0
      ? ((value - previous) / Math.abs(previous)) * 100
      : null;
  const up = delta !== null && delta >= 0;

  return (
    <div className="stat-card">
      <div className="stat-value" style={{ fontSize: 20 }}>{fmt(value)}</div>
      <div className="stat-label">
        {label}
        <div className="subtitle" style={{ fontSize: 11, margin: "2px 0 0" }}>
          was {fmt(previous)}
          {delta !== null && (
            <span style={{ color: up ? "var(--success)" : "var(--danger)", marginLeft: 6 }}>
              {up ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BusinessReview() {
  const { money } = useAppSettings();
  const now = new Date();

  const [periodType, setPeriodType] = useState("monthly");
  const [index, setIndex] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const [review, setReview] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    return api
      .get(`/business-review?period_type=${periodType}&year=${year}&index=${index}`)
      .then(setReview)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadHistory = () =>
    api.get("/business-review/history").then(setHistory).catch(() => {});

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodType, year, index]);

  useEffect(() => {
    loadHistory();
  }, []);

  const changeType = (type) => {
    setPeriodType(type);
    if (type === "monthly") setIndex(now.getMonth() + 1);
    else if (type === "quarterly") setIndex(Math.floor(now.getMonth() / 3) + 1);
    else setIndex(0);
  };

  const generate = async () => {
    setGenerating(true);
    setError("");
    try {
      const written = await api.post("/business-review/generate", {
        period_type: periodType,
        year,
        index,
      });
      setReview(written);
      loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const openFromHistory = (h) => {
    setPeriodType(h.period_type);
    setYear(h.period_year);
    setIndex(h.period_index);
  };

  const f = review?.factSheet;
  const cur = f?.current;
  const prev = f?.previous;
  const thin = f && f.dataVolume.eventsThisPeriod < 15;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Business Review</h1>
          <p className="subtitle">
            The company's own figures for a period, and what they say
          </p>
        </div>
        <button className="btn" onClick={generate} disabled={generating || loading}>
          {generating ? "Writing… (about a minute)" : review?.narrative ? "Regenerate" : "Generate review"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-inline">
          <div className="form-row">
            <label>Period</label>
            <select value={periodType} onChange={(e) => changeType(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          {periodType === "monthly" && (
            <div className="form-row">
              <label>Month</label>
              <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                {MONTHS.slice(1).map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          )}
          {periodType === "quarterly" && (
            <div className="form-row">
              <label>Quarter</label>
              <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>Q{q}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-row">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>
        </div>
      </div>

      {loading && <div className="empty-state">Loading the figures…</div>}

      {!loading && f && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="page-header" style={{ marginBottom: 4 }}>
              <div>
                <h2>{f.period.label}</h2>
                <p className="subtitle" style={{ margin: 0 }}>
                  {f.period.start} to {f.period.end} · compared with {f.comparedWith.label} ·{" "}
                  {f.dataVolume.eventsThisPeriod} events recorded
                </p>
              </div>
            </div>

            {thin && (
              <div
                style={{
                  margin: "12px 0 4px",
                  padding: "10px 14px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--badge-pending-bg)",
                  color: "var(--warning)",
                  fontSize: 13,
                }}
              >
                Only {f.dataVolume.eventsThisPeriod} events were recorded in this period. Treat anything
                below as a description of what happened, not as a trend.
              </div>
            )}

            <div className="grid grid-4" style={{ marginTop: 14 }}>
              <Figure label="Revenue" value={cur.profitAndLoss.totals.totalRevenue}
                previous={prev.profitAndLoss.totals.totalRevenue} money={money} />
              <Figure label="Costs" value={cur.profitAndLoss.totals.totalCosts}
                previous={prev.profitAndLoss.totals.totalCosts} money={money} />
              <Figure label="Net profit" value={cur.profitAndLoss.totals.netProfit}
                previous={prev.profitAndLoss.totals.netProfit} money={money} />
              <Figure label="Collected" value={cur.revenue.collectedValue}
                previous={prev.revenue.collectedValue} money={money} />
            </div>

            <div className="grid grid-4" style={{ marginTop: 12 }}>
              <Figure label="Opportunities won" value={cur.sales.won} previous={prev.sales.won} />
              <Figure label="Won value" value={cur.sales.wonValue} previous={prev.sales.wonValue} money={money} />
              <Figure label="Invoiced" value={cur.revenue.invoicedValue}
                previous={prev.revenue.invoicedValue} money={money} />
              <Figure label="Purchase orders" value={cur.procurement.purchaseValue}
                previous={prev.procurement.purchaseValue} money={money} />
            </div>

            <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>Where things stand today</h3>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr><td>Open pipeline</td><td>{cur.sales.openPipelineCount} worth {money(cur.sales.openPipelineValue)}</td></tr>
                  <tr><td>Stalled {f.standing.staleThresholdDays}+ days</td><td>{f.standing.stalledOpportunities.count} worth {money(f.standing.stalledOpportunities.value)}</td></tr>
                  <tr><td>Receivables outstanding</td><td>{money(f.standing.receivables.outstanding)} ({money(f.standing.receivables.overdue)} overdue)</td></tr>
                  <tr><td>Stock on hand</td><td>{money(f.standing.inventory.stockValue)} · {f.standing.inventory.atReorderLevel} of {f.standing.inventory.items} at reorder level</td></tr>
                  <tr><td>Assets still issued</td><td>{f.standing.assetsStillIssued.count} worth {money(f.standing.assetsStillIssued.value)}</td></tr>
                  <tr><td>Pending asset requests</td><td>{f.standing.pendingAssetRequests}</td></tr>
                  <tr><td>Active headcount</td><td>{f.standing.activeHeadcount}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2>The review</h2>
            {review.narrative ? (
              <>
                <Narrative text={review.narrative} />
                <p className="subtitle" style={{ fontSize: 12, marginTop: 18 }}>
                  Written {review.generatedAt} by {review.model}
                  {review.usage.inputTokens
                    ? ` · ${review.usage.inputTokens} in / ${review.usage.outputTokens} out`
                    : ""}
                  {review.generatedByName ? ` · requested by ${review.generatedByName}` : " · scheduled"}
                  . Every figure it cites comes from the numbers above.
                </p>
              </>
            ) : review.narrativeError ? (
              <div className="error-banner" style={{ marginBottom: 0 }}>{review.narrativeError}</div>
            ) : (
              <div className="empty-state">
                No review written for {f.period.label} yet. The figures above are live — press
                Generate review to have them read and commented on.
              </div>
            )}
          </div>
        </>
      )}

      {history.length > 0 && (
        <div className="card">
          <h2>Previously written</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Written</th>
                  <th>By</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.period_label}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{(h.created_at || "").slice(0, 16)}</td>
                    <td>{h.generated_by_name || "Scheduled"}</td>
                    <td>
                      {h.has_narrative ? (
                        <span className="badge badge-approved">written</span>
                      ) : (
                        <span className="badge badge-rejected" title={h.narrative_error || ""}>figures only</span>
                      )}
                    </td>
                    <td>
                      <button className="link-btn" onClick={() => openFromHistory(h)}>Open →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
