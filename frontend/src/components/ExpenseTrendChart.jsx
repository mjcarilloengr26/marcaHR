import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import useContainerWidth from "../hooks/useContainerWidth";

// Expense spend by category, month by month (or by quarter, or by year), so a
// category that is creeping up shows as a band getting thicker.
//
// Stacked columns rather than lines: the question is two-sided — is the total
// growing, and which category is doing it — and a stack answers both at once.
// Lines answer only the second, and seven of them cross each other into a
// tangle. When one category needs a closer look, clicking it in the legend
// draws that category alone on its own scale, which is where a small but
// steadily growing line item becomes visible.
//
// The table underneath is the precise half: last complete period against the
// one before, in pesos and per cent. The period still in progress is never in
// that comparison — three weeks of November against all of October would show
// every category falling.

const PERIODS = [
  { key: "month", label: "Monthly" },
  { key: "quarter", label: "Quarterly" },
  { key: "year", label: "Yearly" },
];
const HEIGHT = 260;
const PAD = { left: 56, right: 8, top: 12, bottom: 28 };
const colorOf = (s) => (s.slot ? `var(--series-${s.slot})` : "var(--series-rest)");

// A column segment with only its top corners rounded, so the stack reads as
// one bar sitting on the baseline rather than a pile of pills.
function topRounded(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M ${x} ${y + h} L ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr} L ${x + w} ${y + h} Z`;
}

function niceCeiling(v) {
  if (v <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  // Each ceiling divides into four round gridline values (1.6 → 0.4, 0.8,
  // 1.2), so the axis never reads ₱375k or ₱1.1M.
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

export default function ExpenseTrendChart() {
  const { money, moneyCompact } = useAppSettings();
  const [period, setPeriod] = useState("month");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(null);
  const [hover, setHover] = useState(null);
  const [ref, measured] = useContainerWidth();

  useEffect(() => {
    let live = true;
    setError("");
    api
      .get(`/dashboard/expense-trend?period=${period}`)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [period]);

  // The categories in the series are the same for every period (they are
  // ranked over all time), so a focused one survives switching the filter.
  useEffect(() => {
    if (focus && data && !data.series.some((s) => s.key === focus)) setFocus(null);
    setHover(null);
  }, [data, focus]);

  const header = (
    <div className="page-header" style={{ marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
      <div>
        <h2>Expense trend by category</h2>
        <p className="subtitle" style={{ margin: 0 }}>
          Claimed expense items (submitted, approved and reimbursed) by expense date
        </p>
      </div>
      <div className="trend-periods" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );

  // The measured box is rendered in every state, loading included: the width
  // hook attaches when it first mounts, so a box that only appeared once the
  // data arrived would never be measured and the chart would never draw.
  const frame = (body) => (
    <div className="card" style={{ marginTop: 16 }}>
      {header}
      <div ref={ref}>{body}</div>
    </div>
  );
  if (error) return frame(<div className="error-banner">{error}</div>);
  if (!data) return frame(<div className="page-loading" style={{ height: HEIGHT }}>Loading…</div>);
  // Switching period keeps the old chart up, faded, until the new one
  // arrives, rather than collapsing the card and jumping the page.
  const stale = data.period !== period;

  const { buckets, series } = data;
  const shown = focus ? series.filter((s) => s.key === focus) : series;
  const totals = buckets.map((_, b) => shown.reduce((a, s) => a + s.values[b], 0));
  const empty = series.length === 0 || data.totals.every((t) => t === 0);

  const width = measured || 800;
  const periodLabel = PERIODS.find((p) => p.key === data.period).label.toLowerCase();
  const isMobile = width < 480;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceCeiling(Math.max(...totals));
  const slotW = innerW / buckets.length;
  const barW = Math.max(6, Math.min(48, slotW * 0.62));
  const xOf = (b) => PAD.left + slotW * b + (slotW - barW) / 2;
  const yOf = (v) => PAD.top + innerH - (innerH * v) / max;
  const ticks = isMobile ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const showLabel = (b) => !isMobile || buckets.length <= 6 || b % 2 === (buckets.length - 1) % 2;
  // Months show their year on January and on the first column, so a window
  // that crosses New Year says which year each side is.
  const axisLabel = (bk, b) =>
    data.period === "month" && (b === 0 || bk.short === "Jan") ? `${bk.short} '${bk.key.slice(2, 4)}` : bk.short;

  // Growth: the last complete bucket against the one before it.
  const last = buckets.length - 2;
  const prev = buckets.length - 3;
  const current = buckets.length - 1;
  const change = (s) => {
    const a = s.values[prev];
    const b = s.values[last];
    return { diff: b - a, pct: a > 0 ? ((b - a) / a) * 100 : null, isNew: a === 0 && b > 0 };
  };
  const rowsForTable = [...series].sort((x, y) => change(y).diff - change(x).diff);
  const sum = (b) => series.reduce((a, s) => a + s.values[b], 0);
  const totalRow = { values: buckets.map((_, b) => sum(b)) };

  const changeCell = (c) => {
    if (c.isNew) return <span className="trend-up">▲ new</span>;
    if (Math.abs(c.diff) < 0.005) return <span style={{ color: "var(--text-muted)" }}>no change</span>;
    const up = c.diff > 0;
    return (
      <span className={up ? "trend-up" : "trend-down"}>
        {up ? "▲" : "▼"} {money(Math.abs(c.diff))}
        {c.pct !== null && ` (${up ? "+" : "−"}${Math.abs(c.pct).toFixed(0)}%)`}
      </span>
    );
  };

  const tip = hover !== null && (
    <div
      className="trend-tip"
      style={{
        top: PAD.top,
        ...(xOf(hover) + barW / 2 > width / 2 ? { right: width - xOf(hover) + 8 } : { left: xOf(hover) + barW + 8 }),
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {buckets[hover].label}
        {!buckets[hover].complete && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · so far</span>}
      </div>
      {[...shown].reverse().filter((s) => shown.length === 1 || s.values[hover] !== 0).map((s) => (
        <div key={s.key} className="trend-tip-row">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span className="trend-swatch" style={{ background: colorOf(s) }} />
            {s.name}
          </span>
          <span>{money(s.values[hover])}</span>
        </div>
      ))}
      {shown.length > 1 && (
        <div className="trend-tip-row" style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4, fontWeight: 600 }}>
          <span>Total</span>
          <span>{money(totals[hover])}</span>
        </div>
      )}
    </div>
  );

  return frame(
    <div style={{ opacity: stale ? 0.5 : 1, transition: "opacity 0.15s" }}>
      {empty ? (
        <div className="empty-state">No claimed expenses in this range yet.</div>
      ) : (
        <>
          <div className="trend-legend">
            {series.map((s) => (
              <button
                key={s.key}
                type="button"
                data-dim={Boolean(focus && focus !== s.key)}
                aria-pressed={focus === s.key}
                title={
                  s.members?.length
                    ? `${s.members.join(", ")} — click to show on its own`
                    : focus === s.key
                    ? "Click to show every category again"
                    : "Click to show this category on its own"
                }
                onClick={() => setFocus(focus === s.key ? null : s.key)}
              >
                <span className="trend-swatch" style={{ background: colorOf(s) }} />
                {s.name}
              </button>
            ))}
            {focus && (
              <button type="button" onClick={() => setFocus(null)} style={{ color: "var(--primary)" }}>
                Show all
              </button>
            )}
          </div>

          <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
            {measured > 0 && (
              <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} style={{ display: "block" }} role="img"
                aria-label={`Expenses by category, ${periodLabel}. The table below has every figure.`}>
                {ticks.map((t) => {
                  const y = PAD.top + innerH * (1 - t);
                  return (
                    <g key={t}>
                      <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
                      <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={isMobile ? 10 : 11} fill="var(--text-muted)">
                        {moneyCompact(max * t)}
                      </text>
                    </g>
                  );
                })}

                {buckets.map((bk, b) => {
                  let base = 0;
                  const top = shown.reduce((acc, s, n) => (s.values[b] > 0 ? n : acc), -1);
                  return (
                    <g key={bk.key} opacity={bk.complete ? 1 : 0.55}>
                      {shown.map((s, n) => {
                        const v = s.values[b];
                        if (v <= 0) return null;
                        const y0 = yOf(base);
                        base += v;
                        const y1 = yOf(base);
                        const h = Math.max(1, y0 - y1);
                        return (
                          <path
                            key={s.key}
                            d={n === top ? topRounded(xOf(b), y1, barW, h, 4) : `M ${xOf(b)} ${y1} h ${barW} v ${h} h ${-barW} Z`}
                            fill={colorOf(s)}
                            stroke="var(--surface)"
                            strokeWidth="1"
                          />
                        );
                      })}
                      {hover === b && (
                        <rect x={xOf(b) - 3} y={PAD.top} width={barW + 6} height={innerH} fill="var(--text)" opacity="0.06" rx="4" />
                      )}
                      {showLabel(b) && (
                        <text x={xOf(b) + barW / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={isMobile ? 10 : 11} fill="var(--text-muted)">
                          {axisLabel(bk, b)}
                          {!bk.complete && "*"}
                        </text>
                      )}
                      {/* The whole column is the hover and tap target, not
                          just the painted part: a thin segment is too small
                          to find with a mouse, let alone a thumb. */}
                      <rect
                        x={PAD.left + slotW * b}
                        y={PAD.top}
                        width={slotW}
                        height={innerH + PAD.bottom}
                        fill="transparent"
                        onMouseEnter={() => setHover(b)}
                        // A tap on a phone arrives as hover then click; toggling here
                        // would open and close it in the same touch.
                        onClick={() => setHover(b)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}
            {tip}
          </div>
          <p className="subtitle" style={{ margin: "6px 0 14px", fontSize: 12 }}>
            * {buckets[current].label} is still in progress, so it is left out of the comparison below.
            {focus ? " Showing one category on its own scale." : " Click a category above to see it on its own."}
          </p>

          <div style={{ overflowX: "auto" }}>
            <table className="sticky-head trend-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num hide-sm">{buckets[prev].label}</th>
                  <th className="num">{buckets[last].label}</th>
                  <th className="num">Change</th>
                  <th className="num hide-sm">{buckets[current].label} so far</th>
                  <th className="num hide-sm hide-md">{buckets.length} {{ month: "months", quarter: "quarters", year: "years" }[data.period]} total</th>
                </tr>
              </thead>
              <tbody>
                {rowsForTable.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span className="trend-swatch" style={{ background: colorOf(s) }} />
                        <span>
                          {s.name}
                          {s.members?.length > 0 && (
                            <span title={s.members.join(", ")} style={{ display: "block", fontSize: 12, color: "var(--text-muted)", cursor: "help" }}>
                              {s.members.length} smaller {s.members.length === 1 ? "category" : "categories"}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="num hide-sm">{money(s.values[prev])}</td>
                    <td className="num">{money(s.values[last])}</td>
                    <td className="num">{changeCell(change(s))}</td>
                    <td className="num hide-sm">{money(s.values[current])}</td>
                    <td className="num hide-sm hide-md">{money(s.total)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 600 }}>
                  <td>Total</td>
                  <td className="num hide-sm">{money(totalRow.values[prev])}</td>
                  <td className="num">{money(totalRow.values[last])}</td>
                  <td className="num">{changeCell(change(totalRow))}</td>
                  <td className="num hide-sm">{money(totalRow.values[current])}</td>
                  <td className="num hide-sm hide-md">{money(totalRow.values.reduce((a, v) => a + v, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
