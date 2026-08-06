// Meter: a single ratio against a limit. Fill uses the app's primary hue; the
// unfilled track is a lighter step of the same ramp, so progress reads across
// the whole bar (per the dataviz skill's meter spec).
export default function Meter({ label, value, max, formatValue, onEdit }) {
  const hasTarget = max > 0;
  const percent = hasTarget ? Math.round((value / max) * 100) : null;
  const widthPct = hasTarget ? Math.min(percent, 100) : 0;

  return (
    <div className="meter-row">
      <div className="meter-label">{label}</div>
      <div className="meter-track">
        <div className={`meter-fill${percent >= 100 ? " meter-fill-complete" : ""}`} style={{ width: `${widthPct}%` }} />
      </div>
      <div className="meter-value">
        {formatValue(value)}
        {hasTarget && (
          <>
            {" "}
            / {formatValue(max)} <span className="meter-pct">· {percent}%</span>
          </>
        )}
      </div>
      {onEdit && (
        <button className="link-btn meter-edit" onClick={onEdit}>
          {hasTarget ? "Edit target" : "Set target"}
        </button>
      )}
    </div>
  );
}
