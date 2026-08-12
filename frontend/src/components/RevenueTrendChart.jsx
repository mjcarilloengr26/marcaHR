import { useId } from "react";
import { useAppSettings } from "../context/AppSettingsContext";
import useContainerWidth from "../hooks/useContainerWidth";


const HEIGHT = 280;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const MOBILE_BREAKPOINT = 480;

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

// Closes the line path down to the baseline (y = 0) and back to the start,
// turning it into a fillable area shape without altering the line itself.
function buildAreaPath(values, xFor, yFor, yBase) {
  const top = buildPath(values, xFor, yFor);
  const lastX = xFor(values.length - 1);
  const firstX = xFor(0);
  return `${top} L ${lastX} ${yBase} L ${firstX} ${yBase} Z`;
}

export default function RevenueTrendChart({ thisYear, lastYear, months }) {
  const [containerRef, measuredWidth] = useContainerWidth();
  const { money, moneyCompact } = useAppSettings();
  const gradientId = useId();

  if (!months || months.length === 0) return null;

  const width = measuredWidth || 800;
  const isMobile = width < MOBILE_BREAKPOINT;
  const innerWidth = width - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const maxValue = Math.max(1, ...months.map((m) => Math.max(m.thisYear, m.lastYear)));
  // Round the axis ceiling up to a friendly step so gridline labels aren't jagged numbers.
  const step = Math.pow(10, Math.floor(Math.log10(maxValue)));
  const niceMax = Math.ceil(maxValue / step) * step;

  const xFor = (i) => PAD_LEFT + (innerWidth * i) / (months.length - 1 || 1);
  const yFor = (v) => PAD_TOP + innerHeight - (innerHeight * v) / niceMax;

  const gridLines = isMobile ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  // Every month on a full-size screen; every other month once it's too narrow for
  // 12 non-overlapping labels, so text never gets crammed together.
  const labelIndices = isMobile ? months.map((_, i) => i).filter((i) => i % 2 === 0) : months.map((_, i) => i);
  const fontSize = isMobile ? 10 : 11;
  const thisYearValues = months.map((m) => m.thisYear);
  const lastYearValues = months.map((m) => m.lastYear);
  const yBase = yFor(0);
  const thisYearGradientId = `${gradientId}-this-year`;
  const lastYearGradientId = `${gradientId}-last-year`;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
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

      <div ref={containerRef}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} style={{ display: "block" }} role="img" aria-label={`Monthly order revenue, ${thisYear} versus ${lastYear}`}>
            <defs>
              <linearGradient id={thisYearGradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={THIS_YEAR_COLOR} stopOpacity="0.35" />
                <stop offset="100%" stopColor={THIS_YEAR_COLOR} stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={lastYearGradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={LAST_YEAR_COLOR} stopOpacity="0.3" />
                <stop offset="100%" stopColor={LAST_YEAR_COLOR} stopOpacity="0.02" />
              </linearGradient>
            </defs>

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

            {labelIndices.map((i) => (
              <text key={months[i].month} x={xFor(i)} y={HEIGHT - 8} textAnchor="middle" fontSize={fontSize} fill="var(--text-muted)">
                {months[i].label}
              </text>
            ))}

            <path d={buildAreaPath(lastYearValues, xFor, yFor, yBase)} fill={`url(#${lastYearGradientId})`} stroke="none" />
            <path d={buildAreaPath(thisYearValues, xFor, yFor, yBase)} fill={`url(#${thisYearGradientId})`} stroke="none" />

            <path d={buildPath(lastYearValues, xFor, yFor)} fill="none" stroke={LAST_YEAR_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d={buildPath(thisYearValues, xFor, yFor)} fill="none" stroke={THIS_YEAR_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

            {months.map((m, i) => (
              <circle key={`ly-${m.month}`} cx={xFor(i)} cy={yFor(m.lastYear)} r={isMobile ? 3 : 4} fill="var(--surface)" stroke={LAST_YEAR_COLOR} strokeWidth="2">
                <title>{`${m.label} ${lastYear}: ${money(m.lastYear)}`}</title>
              </circle>
            ))}
            {months.map((m, i) => (
              <circle key={`ty-${m.month}`} cx={xFor(i)} cy={yFor(m.thisYear)} r={isMobile ? 3 : 4} fill="var(--surface)" stroke={THIS_YEAR_COLOR} strokeWidth="2">
                <title>{`${m.label} ${thisYear}: ${money(m.thisYear)}`}</title>
              </circle>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
