// Ordinal sequential ramp (blue, light→dark) — one step per funnel stage.
const STAGE_COLORS = ["#86b6ef", "#3987e5", "#1c5cab", "#104281"];

export default function ExpenseFunnel({ funnel }) {
  if (!funnel) return null;
  const { stages, rejected } = funnel;
  const maxCount = stages[0]?.count || 0;

  return (
    <div className="card">
      <h2>Expense report funnel</h2>
      <p className="subtitle" style={{ marginTop: -8 }}>
        How liquidation/expense reports move from creation to reimbursement
      </p>
      <div className="funnel">
        {stages.map((stage, i) => {
          const widthPct = maxCount > 0 ? Math.max((stage.count / maxCount) * 100, stage.count > 0 ? 6 : 0) : 0;
          const pctOfFirst = maxCount > 0 ? Math.round((stage.count / maxCount) * 100) : 0;
          return (
            <div className="funnel-row" key={stage.key}>
              <div className="funnel-label">{stage.label}</div>
              <div className="funnel-track" title={`${stage.label}: ${stage.count} (${pctOfFirst}% of created)`}>
                <div
                  className="funnel-bar"
                  style={{ width: `${widthPct}%`, background: STAGE_COLORS[i] }}
                />
              </div>
              <div className="funnel-value">
                {stage.count}
                {i > 0 && <span className="funnel-pct"> · {pctOfFirst}%</span>}
              </div>
            </div>
          );
        })}
      </div>
      {rejected > 0 && (
        <div className="funnel-rejected">
          <span className="badge badge-rejected">⚠ Rejected</span>
          <span>{rejected} report{rejected === 1 ? "" : "s"} rejected after submission</span>
        </div>
      )}
    </div>
  );
}
