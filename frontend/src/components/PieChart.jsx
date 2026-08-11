const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// All labels/values render as plain HTML (the legend), never as SVG <text> —
// sidesteps the class of bug where SVG text scales down illegibly on narrow
// screens (see RevenueTrendChart), since a pie chart's own arcs need no text
// inside the drawing at all.
export default function PieChart({ data, size = 160 }) {
  const slices = (data || []).filter((d) => d.value > 0);
  const total = slices.reduce((s, d) => s + d.value, 0);

  if (total <= 0) {
    return <div className="empty-state" style={{ padding: 16 }}>No amounts to chart for this period.</div>;
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  // A single slice covering the full circle can't be drawn as one SVG arc
  // (the arc's start and end point coincide), so that case renders as a
  // plain <circle> instead.
  const paths =
    slices.length === 1
      ? [{ ...slices[0], pct: 100, isCircle: true }]
      : (() => {
          let cumulative = 0;
          return slices.map((d) => {
            const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
            cumulative += d.value;
            const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
            const x1 = cx + r * Math.cos(startAngle);
            const y1 = cy + r * Math.sin(startAngle);
            const x2 = cx + r * Math.cos(endAngle);
            const y2 = cy + r * Math.sin(endAngle);
            const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
            const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
            return { ...d, path, pct: (d.value / total) * 100 };
          });
        })();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }} role="img" aria-label="Breakdown pie chart">
        {paths.map((s) =>
          s.isCircle ? (
            <circle key={s.label} cx={cx} cy={cy} r={r} fill={s.color} stroke="var(--surface)" strokeWidth="2">
              <title>{`${s.label}: ${money(s.value)} (100%)`}</title>
            </circle>
          ) : (
            <path key={s.label} d={s.path} fill={s.color} stroke="var(--surface)" strokeWidth="2">
              <title>{`${s.label}: ${money(s.value)} (${s.pct.toFixed(1)}%)`}</title>
            </path>
          )
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 160 }}>
        {slices.map((d, i) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: "inline-block", flexShrink: 0 }} />
            <span style={{ color: "var(--text-muted)" }}>{d.label}</span>
            <span style={{ marginLeft: "auto", fontWeight: 600 }}>{money(d.value)}</span>
            <span style={{ color: "var(--text-muted)", minWidth: 40, textAlign: "right" }}>{paths[i].pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
