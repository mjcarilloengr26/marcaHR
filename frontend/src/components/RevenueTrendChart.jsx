const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const WIDTH = 1000;
const HEIGHT = 280;
const PAD_LEFT = 64;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;

// This-year vs last-year is an identity comparison (two distinct series), not a
// magnitude ramp, so it gets two fixed categorical hues rather than shades of one
// hue — reusing --primary (already this app's brand blue) and --warning (already
// used elsewhere for amber accents) keeps it inside the app's existing palette
// instead of inventing new colors, while staying clearly distinct under color
// blindness (blue vs. amber is the classic safe pair).
const THIS_YEAR_COLOR = "#3454d1";
const LAST_YEAR_COLOR = "#b8860b";

function buildPath(values, xFor, yFor) {
  return values.map((v, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(v)}`).join(" ");
}

export default function RevenueTrendChart({ thisYear, lastYear, months }) {
  if (!months || months.length === 0) return null;

  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const maxValue = Math.max(1, ...months.map((m) => Math.max(m.thisYear, m.lastYear)));
  // Round the axis ceiling up to a friendly step so gridline labels aren't jagged numbers.
  const step = Math.pow(10, Math.floor(Math.log10(maxValue)));
  const niceMax = Math.ceil(maxValue / step) * step;

  const xFor = (i) => PAD_LEFT + (innerWidth * i) / (months.length - 1 || 1);
  const yFor = (v) => PAD_TOP + innerHeight - (innerHeight * v) / niceMax;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const thisYearValues = months.map((m) => m.thisYear);
  const lastYearValues = months.map((m) => m.lastYear);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 4 }}>
        <div>
          <h2>Revenue Trend</h2>
          <p className="subtitle" style={{ margin: 0 }}>
            Monthly order revenue — {thisYear} vs {lastYear}
          </p>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: THIS_YEAR_COLOR, display: "inline-block" }} />
            {thisYear}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: LAST_YEAR_COLOR, display: "inline-block" }} />
            {lastYear}
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={`Monthly order revenue, ${thisYear} versus ${lastYear}`}>
        {gridLines.map((g) => {
          const y = PAD_TOP + innerHeight * (1 - g);
          return (
            <g key={g}>
              <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
              <text x={PAD_LEFT - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {money(niceMax * g)}
              </text>
            </g>
          );
        })}

        {months.map((m, i) => (
          <text key={m.month} x={xFor(i)} y={HEIGHT - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {m.label}
          </text>
        ))}

        <path d={buildPath(lastYearValues, xFor, yFor)} fill="none" stroke={LAST_YEAR_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={buildPath(thisYearValues, xFor, yFor)} fill="none" stroke={THIS_YEAR_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {months.map((m, i) => (
          <circle key={`ly-${m.month}`} cx={xFor(i)} cy={yFor(m.lastYear)} r="4" fill="var(--surface)" stroke={LAST_YEAR_COLOR} strokeWidth="2">
            <title>{`${m.label} ${lastYear}: ${money(m.lastYear)}`}</title>
          </circle>
        ))}
        {months.map((m, i) => (
          <circle key={`ty-${m.month}`} cx={xFor(i)} cy={yFor(m.thisYear)} r="4" fill="var(--surface)" stroke={THIS_YEAR_COLOR} strokeWidth="2">
            <title>{`${m.label} ${thisYear}: ${money(m.thisYear)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
