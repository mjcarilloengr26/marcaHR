const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// Year-over-year grouped column chart: each category gets a light "previous
// year" bar next to a dark "current year" bar, plain HTML/CSS (no SVG) so
// labels stay a real, fixed font size — wrapped to two lines under each pair
// rather than rotated, same convention as the pie legend (largest pair-total
// first).
export default function BarChart({
  data,
  currentLabel = "This year",
  previousLabel = "Last year",
  currentColor = "#2f6fed",
  previousColor = "#a9c6fb",
  chartHeight = 130,
}) {
  const rows = (data || [])
    .filter((d) => d.current > 0 || d.previous > 0)
    .sort((a, b) => b.current + b.previous - (a.current + a.previous));
  const maxValue = Math.max(0, ...rows.flatMap((d) => [d.current, d.previous]));

  if (maxValue <= 0) {
    return <div className="empty-state" style={{ padding: 16 }}>No amounts to chart for this period.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: previousColor, display: "inline-block" }} />
          {previousLabel}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: currentColor, display: "inline-block" }} />
          {currentLabel}
        </span>
      </div>

      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 16, minHeight: chartHeight + 56, overflowX: "auto", paddingBottom: 4 }}
        role="img"
        aria-label="Year-over-year breakdown bar chart"
      >
        {rows.map((d) => {
          const prevHeight = Math.max(d.previous > 0 ? 3 : 0, (d.previous / maxValue) * chartHeight);
          const currHeight = Math.max(d.current > 0 ? 3 : 0, (d.current / maxValue) * chartHeight);
          return (
            <div key={d.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, width: 84 }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }} title={`${previousLabel}: ${money(d.previous)}`}>
                  <span style={{ fontSize: 11, marginBottom: 4, whiteSpace: "nowrap" }}>{d.previous > 0 ? money(d.previous) : ""}</span>
                  <div style={{ width: 22, height: prevHeight, background: previousColor, borderRadius: "3px 3px 0 0" }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }} title={`${currentLabel}: ${money(d.current)}`}>
                  <span style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, whiteSpace: "nowrap" }}>{d.current > 0 ? money(d.current) : ""}</span>
                  <div style={{ width: 22, height: currHeight, background: currentColor, borderRadius: "3px 3px 0 0" }} />
                </div>
              </div>
              <span
                title={d.label}
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  textAlign: "center",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  lineHeight: 1.2,
                  width: "100%",
                }}
              >
                {d.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
