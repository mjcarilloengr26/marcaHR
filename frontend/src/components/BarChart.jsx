import { useState } from "react";
import useContainerWidth from "../hooks/useContainerWidth";

const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
// Compact form for the y-axis (₱1,200,000 -> ₱1.2M) — same convention as
// RevenueTrendChart, so axis labels never crowd narrow screens.
const moneyCompact = (n) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `₱${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `₱${(v / 1_000).toFixed(0)}k`;
  return `₱${v}`;
};

const HEIGHT = 260;
const PAD_LEFT = 52;
const PAD_RIGHT = 12;
const PAD_TOP = 20;
const PAD_BOTTOM = 68;
const MOBILE_BREAKPOINT = 480;

function truncateLabel(label, maxChars) {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

// Year-over-year grouped column chart with real axes: the y-axis carries the
// amount scale (gridlines + compact labels, like RevenueTrendChart), the
// x-axis carries the category, and every bar is hoverable for its exact
// value — deliberately no number printed on every bar (that's the axis and
// tooltip's job), keeping the chart itself uncluttered at a glance.
export default function BarChart({
  data,
  currentLabel = "This year",
  previousLabel = "Last year",
  currentColor = "#2f6fed",
  previousColor = "#a9c6fb",
}) {
  const [containerRef, measuredWidth] = useContainerWidth();
  const [hover, setHover] = useState(null); // { x, y, label, year, value, color }

  const rows = (data || [])
    .filter((d) => d.current > 0 || d.previous > 0)
    .sort((a, b) => b.current + b.previous - (a.current + a.previous));

  if (rows.length === 0) {
    return <div className="empty-state" style={{ padding: 16 }}>No amounts to chart for this period.</div>;
  }

  const width = measuredWidth || 480;
  const isMobile = width < MOBILE_BREAKPOINT;
  const innerWidth = width - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const maxValue = Math.max(1, ...rows.flatMap((d) => [d.current, d.previous]));
  const step = Math.pow(10, Math.floor(Math.log10(maxValue)));
  const niceMax = Math.ceil(maxValue / step) * step;
  const yFor = (v) => PAD_TOP + innerHeight - (innerHeight * v) / niceMax;
  const yBase = yFor(0);

  const slotWidth = innerWidth / rows.length;
  const barWidth = Math.min(26, Math.max(6, slotWidth * 0.3));
  const barGap = 3;

  const gridLines = isMobile ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const fontSize = isMobile ? 10 : 11;
  const labelMaxChars = isMobile ? 10 : 14;

  return (
    <div>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: previousColor, display: "inline-block" }} />
          {previousLabel}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: currentColor, display: "inline-block" }} />
          {currentLabel}
        </span>
      </div>

      <div ref={containerRef} style={{ position: "relative", minWidth: 220 }}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            style={{ display: "block", overflow: "visible" }}
            role="img"
            aria-label="Year-over-year breakdown bar chart"
          >
            {gridLines.map((g) => {
              const y = PAD_TOP + innerHeight * (1 - g);
              return (
                <g key={g}>
                  <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
                  <text x={PAD_LEFT - 8} y={y + 4} textAnchor="end" fontSize={fontSize} fill="var(--text-muted)">
                    {moneyCompact(niceMax * g)}
                  </text>
                </g>
              );
            })}

            {/* Axis lines — recessive (muted, thin), just enough to anchor the plot */}
            <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={yBase} stroke="var(--text-muted)" strokeWidth="1" opacity="0.5" />
            <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yBase} y2={yBase} stroke="var(--text-muted)" strokeWidth="1" opacity="0.5" />

            {rows.map((d, i) => {
              const slotCenter = PAD_LEFT + slotWidth * i + slotWidth / 2;
              const prevX = slotCenter - barGap / 2 - barWidth;
              const currX = slotCenter + barGap / 2;
              const prevY = yFor(d.previous);
              const currY = yFor(d.current);
              const prevHeight = Math.max(d.previous > 0 ? 2 : 0, yBase - prevY);
              const currHeight = Math.max(d.current > 0 ? 2 : 0, yBase - currY);
              const isPrevHovered = hover?.i === i && hover?.which === "previous";
              const isCurrHovered = hover?.i === i && hover?.which === "current";

              const showTooltip = (which, value, x, y) => {
                setHover({ i, which, x, y, label: d.label, value, color: which === "current" ? currentColor : previousColor, year: which === "current" ? currentLabel : previousLabel });
              };

              return (
                <g key={d.label}>
                  {d.previous > 0 && (
                    <rect
                      x={prevX}
                      y={prevY}
                      width={barWidth}
                      height={prevHeight}
                      rx={3}
                      fill={previousColor}
                      style={{ cursor: "pointer", transition: "filter 0.12s ease", filter: isPrevHovered ? "brightness(1.15)" : "none" }}
                      onMouseEnter={() => showTooltip("previous", d.previous, prevX + barWidth / 2, prevY)}
                      onMouseLeave={() => setHover(null)}
                    />
                  )}
                  {d.current > 0 && (
                    <rect
                      x={currX}
                      y={currY}
                      width={barWidth}
                      height={currHeight}
                      rx={3}
                      fill={currentColor}
                      style={{ cursor: "pointer", transition: "filter 0.12s ease", filter: isCurrHovered ? "brightness(1.15)" : "none" }}
                      onMouseEnter={() => showTooltip("current", d.current, currX + barWidth / 2, currY)}
                      onMouseLeave={() => setHover(null)}
                    />
                  )}
                  <text
                    x={slotCenter}
                    y={yBase + 14}
                    textAnchor="end"
                    fontSize={fontSize}
                    fill="var(--text-muted)"
                    transform={`rotate(-35 ${slotCenter} ${yBase + 14})`}
                  >
                    <title>{d.label}</title>
                    {truncateLabel(d.label, labelMaxChars)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {hover && (
          <div
            style={{
              position: "absolute",
              left: hover.x,
              top: hover.y,
              transform: "translate(-50%, -100%) translateY(-8px)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              boxShadow: "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.15))",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              zIndex: 1,
            }}
          >
            <div style={{ fontWeight: 600 }}>{hover.label}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: hover.color, display: "inline-block" }} />
              {hover.year}: <strong style={{ color: "var(--text)" }}>{money(hover.value)}</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
