// Ordinal sequential ramps (blue, light→dark) — validated via the dataviz skill's
// validate_palette.js for 4 and 5 stage funnels respectively.
const RAMPS = {
  4: ["#86b6ef", "#3987e5", "#1c5cab", "#104281"],
  5: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
};

export default function Funnel({ title, subtitle, stages, branchLabel, branchCount, branchUnit = "item" }) {
  if (!stages) return null;
  const colors = RAMPS[stages.length] || RAMPS[4];
  const maxCount = stages[0]?.count || 0;

  return (
    <div className="card">
      <h2>{title}</h2>
      {subtitle && (
        <p className="subtitle" style={{ marginTop: -8 }}>
          {subtitle}
        </p>
      )}
      <div className="funnel">
        {stages.map((stage, i) => {
          const widthPct = maxCount > 0 ? Math.max((stage.count / maxCount) * 100, stage.count > 0 ? 6 : 0) : 0;
          const pctOfFirst = maxCount > 0 ? Math.round((stage.count / maxCount) * 100) : 0;
          return (
            <div className="funnel-row" key={stage.key}>
              <div className="funnel-label">{stage.label}</div>
              <div className="funnel-track" title={`${stage.label}: ${stage.count} (${pctOfFirst}% of first stage)`}>
                <div className="funnel-bar" style={{ width: `${widthPct}%`, background: colors[i] }} />
              </div>
              <div className="funnel-value">
                {stage.count}
                {i > 0 && <span className="funnel-pct"> · {pctOfFirst}%</span>}
              </div>
            </div>
          );
        })}
      </div>
      {branchCount > 0 && (
        <div className="funnel-rejected">
          <span className="badge badge-rejected">⚠ {branchLabel}</span>
          <span>
            {branchCount} {branchUnit}
            {branchCount === 1 ? "" : "s"} {branchLabel.toLowerCase()}
          </span>
        </div>
      )}
    </div>
  );
}
