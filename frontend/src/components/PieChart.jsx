import { useAppSettings } from "../context/AppSettingsContext";

// A donut rather than a filled pie.
//
// The hole is the reason. A part-to-whole chart is always read against its
// total, and on a solid pie that total lives nowhere — the eye has to add the
// legend up. Putting it in the middle makes the whole the chart is dividing
// the first thing you see, and the arcs around it the answer to "of what".
// The ring also reads more accurately than a wedge: the mind is better at
// comparing arc length than the area of a triangle with a curved end.
//
// All labels and values render as plain HTML — the legend, and the centre
// figure positioned over the drawing — never as SVG <text>. That sidesteps the
// class of bug where SVG text scales down illegibly on narrow screens (see
// RevenueTrendChart), and it lets the centre figure wear the same type tokens
// as the rest of the page.
export default function PieChart({ data, size = 160 }) {
  const { money, moneyCompact } = useAppSettings();
  const slices = (data || []).filter((d) => d.value > 0);
  const total = slices.reduce((s, d) => s + d.value, 0);

  if (total <= 0) {
    return <div className="empty-state" style={{ padding: 16 }}>No amounts to chart for this period.</div>;
  }

  const cx = size / 2;
  const cy = size / 2;
  // 2 off the edge leaves room for the surface stroke between segments to sit
  // fully inside the box rather than being clipped by it.
  const R = size / 2 - 2;
  // A ring thick enough to read as a band and a hole wide enough to hold the
  // total. Below about 0.55 the middle is too cramped for the figure; above
  // 0.7 the band gets thin enough that small segments disappear.
  const INNER_RATIO = 0.62;
  const r = R * INNER_RATIO;

  const point = (radius, angle) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];

  // A single segment covering the whole circle cannot be drawn as one arc —
  // its start and end points coincide — so it renders as a stroked circle
  // sitting on the ring's centre line instead.
  const segments =
    slices.length === 1
      ? [{ ...slices[0], pct: 100, isRing: true }]
      : (() => {
          let cumulative = 0;
          return slices.map((d) => {
            const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
            cumulative += d.value;
            const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
            const [x1o, y1o] = point(R, startAngle);
            const [x2o, y2o] = point(R, endAngle);
            const [x2i, y2i] = point(r, endAngle);
            const [x1i, y1i] = point(r, startAngle);
            const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
            // Out along the start edge, round the outside, in along the end
            // edge, back round the inside.
            const path = [
              `M ${x1o} ${y1o}`,
              `A ${R} ${R} 0 ${largeArc} 1 ${x2o} ${y2o}`,
              `L ${x2i} ${y2i}`,
              `A ${r} ${r} 0 ${largeArc} 0 ${x1i} ${y1i}`,
              "Z",
            ].join(" ");
            return { ...d, path, pct: (d.value / total) * 100 };
          });
        })();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown donut chart">
          {segments.map((s) =>
            s.isRing ? (
              <circle
                key={s.label}
                cx={cx}
                cy={cy}
                r={(R + r) / 2}
                fill="none"
                stroke={s.color}
                strokeWidth={R - r}
              >
                <title>{`${s.label}: ${money(s.value)} (100%)`}</title>
              </circle>
            ) : (
              <path key={s.label} d={s.path} fill={s.color} stroke="var(--surface)" strokeWidth="2">
                <title>{`${s.label}: ${money(s.value)} (${s.pct.toFixed(1)}%)`}</title>
              </path>
            )
          )}
        </svg>
        {/* Compact in the middle — the exact figure is on hover and in the
            legend beside it, and a full peso total at this size would either
            spill out of the hole or be set too small to read. pointer-events
            off so the centre never swallows a hover meant for an arc.

            It is the figure that is centred on the ring, not the figure and
            its caption together. Centring the pair put the number a few pixels
            low — the caption above it took up half the difference — and
            against a circle that reads as misaligned however small it is. The
            caption hangs off the top of the figure instead, so it costs the
            number nothing. */}
        <div
          title={money(total)}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div style={{ position: "relative", textAlign: "center", lineHeight: 1.2 }}>
            <span
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "100%",
                marginBottom: 2,
                fontSize: 10,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              Total
            </span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{moneyCompact(total)}</span>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 160 }}>
        {slices.map((d, i) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: "inline-block", flexShrink: 0 }} />
            <span style={{ color: "var(--text-muted)" }}>{d.label}</span>
            <span style={{ marginLeft: "auto", fontWeight: 600 }}>{money(d.value)}</span>
            <span style={{ color: "var(--text-muted)", minWidth: 40, textAlign: "right" }}>{segments[i].pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
