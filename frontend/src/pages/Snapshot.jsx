import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import RevenueTrendChart from "../components/RevenueTrendChart";

// The one-page read of the business, sized to fill a single screen so it can
// live on an office wall panel. Everything comes from one /snapshot call, which
// is built on the same service as the monthly Business Review email — the page
// and the email cannot quote different numbers for the same period.
//
// It opens on the year to date, not the month: a wall display is read in
// passing, and how the year is going is the question a glance can answer. The
// comparison is the same span of last year rather than all of it, so eight
// months are never measured against twelve. Full year, quarter and month stay
// selectable for anyone sitting down with it.

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// A wall panel is never refreshed by hand, so it refreshes itself. Five minutes
// is often enough that the figures are never visibly stale and rare enough that
// it costs the database nothing.
const REFRESH_MS = 5 * 60 * 1000;

// Up is not automatically good. Cost rising is not a win, so each measure
// carries its own polarity rather than the tile guessing from the sign.
function toneFor(direction, goodWhen) {
  if (direction === "flat") return "var(--text-muted)";
  if (direction === "new") return "var(--primary)";
  const good = goodWhen === "up" ? direction === "up" : direction === "down";
  return good ? "var(--success)" : "var(--danger)";
}

// The server sends money in `amounts` and marks its place in the sentence with
// {0}, {1}. Formatting happens here because the currency and its separators are
// a per-user setting the server does not know about.
function fillAmounts(detail, amounts = [], money) {
  return String(detail).replace(/\{(\d+)\}/g, (whole, i) =>
    amounts[Number(i)] === undefined ? whole : money(amounts[Number(i)])
  );
}

// One accent per measure, fixed to the measure and not to how it is doing —
// a tile must not change colour because a number moved, or the eye starts
// reading the palette instead of the figures.
const ACCENT = {
  revenue: "blue",
  netProfit: "green",
  costs: "amber",
  collected: "teal",
  won: "blue",
  pipeline: "violet",
};

function Kpi({ h, comparedWith, money }) {
  const d = h.delta;
  return (
    <div className="snap-kpi" data-accent={ACCENT[h.key] || "blue"}>
      <div className="snap-kpi-value" title={money(h.value)}>{money(h.value)}</div>
      <div className="snap-kpi-label">{h.label}</div>
      <div className="snap-kpi-hint">{h.hint}</div>
      {d ? (
        <span className="snap-kpi-delta" style={{ color: toneFor(d.direction, h.goodWhen) }}>
          {/* Nothing to divide by means there is no rate, only a first
              occurrence. "New" says that; "+100%" would imply a trend. */}
          {d.direction === "new"
            ? `New vs ${comparedWith}`
            : `${d.direction === "up" ? "▲" : d.direction === "down" ? "▼" : "—"} ${Math.abs(d.percent)}% vs ${comparedWith}`}
        </span>
      ) : (
        <span className="snap-kpi-delta" style={{ color: "var(--text-muted)", fontWeight: 500 }}>
          Position today
        </span>
      )}
    </div>
  );
}

function MatrixCol({ title, note, rows }) {
  return (
    <div className="snap-card">
      <h2>{title}</h2>
      {note && <p className="snap-note">{note}</p>}
      <ul className="snap-matrix-rows">
        {rows.map((r) => (
          <li className="snap-matrix-row" key={r.label}>
            <span style={{ minWidth: 0 }}>{r.label}</span>
            <b style={{ color: r.tone }}>{r.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Snapshot() {
  const { money, moneyWhole } = useAppSettings();
  const now = new Date();

  const [periodType, setPeriodType] = useState("ytd");
  const [year, setYear] = useState(now.getFullYear());
  const [index, setIndex] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [tv, setTv] = useState(false);
  const firstLoad = useRef(true);

  // The chart is given a pixel height, but the band it sits in is sized from
  // the viewport — so the slot is measured and the height handed down.
  const [chartHeight, setChartHeight] = useState(220);
  const observer = useRef(null);
  const wentFullscreen = useRef(false);

  // A callback ref, not useRef + useEffect: the slot does not exist on the
  // first render (the page returns a spinner until the data lands), so an
  // effect with an empty dependency list would observe nothing and the chart
  // would keep the placeholder height forever.
  const chartSlot = useCallback((node) => {
    observer.current?.disconnect();
    if (!node || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      const h = Math.round(entry.contentRect.height);
      if (h > 0) setChartHeight(Math.max(120, h));
    });
    observer.current.observe(node);
  }, []);

  const load = useCallback(
    (showSpinner) => {
      if (showSpinner) setLoading(true);
      return api
        .get(`/snapshot?period_type=${periodType}&year=${year}&index=${index}`)
        .then((d) => {
          setData(d);
          setError("");
          setUpdatedAt(new Date());
        })
        // A failed background refresh must not blank a wall display that is
        // already showing good figures — the last good read stays up and the
        // banner says it went stale.
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    },
    [periodType, year, index]
  );

  useEffect(() => {
    load(firstLoad.current || !data);
    firstLoad.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => () => observer.current?.disconnect(), []);

  // TV mode hides the app chrome and goes fullscreen. The class is cleared on
  // unmount too, or navigating away would leave the sidebar hidden everywhere.
  useEffect(() => {
    document.body.classList.toggle("snapshot-tv", tv);
    return () => document.body.classList.remove("snapshot-tv");
  }, [tv]);

  // Leaving fullscreen with Esc has to switch the mode off as well, or the page
  // keeps hiding the navigation with no obvious way back. Guarded by whether
  // fullscreen was actually entered: a browser can refuse the request (a kiosk
  // policy, an iframe), and without the guard that refusal fires this handler
  // and turns TV mode straight back off — leaving the button doing nothing on
  // exactly the locked-down displays it exists for.
  useEffect(() => {
    const sync = () => {
      if (!document.fullscreenElement && wentFullscreen.current) {
        wentFullscreen.current = false;
        setTv(false);
      }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // Hiding the chrome is the point; fullscreen is a bonus on top of it, so the
  // mode flips first and the request is allowed to fail.
  const toggleTv = async () => {
    const next = !tv;
    setTv(next);
    try {
      if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      /* Refused — the chrome still hides, which is most of the benefit. */
    }
    wentFullscreen.current = next && !!document.fullscreenElement;
  };

  const changeType = (t) => {
    setPeriodType(t);
    setIndex(t === "monthly" ? now.getMonth() + 1 : t === "quarterly" ? Math.floor(now.getMonth() / 3) + 1 : 1);
  };

  const needsIndex = periodType === "monthly" || periodType === "quarterly";

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y -= 1) years.push(y);
  const indexes =
    periodType === "monthly"
      ? MONTHS.slice(1).map((label, i) => ({ value: i + 1, label }))
      : [1, 2, 3, 4].map((q) => ({ value: q, label: `Q${q}` }));

  if (loading && !data) return <div className="page-loading">Loading…</div>;
  if (!data) return <div className="error-banner">{error || "No data"}</div>;

  return (
    <div className="snap">
      <div className="snap-bar">
        <div style={{ minWidth: 0 }}>
          <h1 className="snap-title">{data.period.label}</h1>
          <p className="snap-sub">
            {data.period.start} to {data.period.end} · against {data.comparedWith.label}
            {updatedAt && ` · updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            {error && " · refresh failed, showing the last good read"}
          </p>
        </div>
        <div className="snap-controls">
          <select value={periodType} onChange={(e) => changeType(e.target.value)}>
            <option value="ytd">Year to date</option>
            <option value="yearly">Full year</option>
            <option value="quarterly">Quarterly</option>
            <option value="monthly">Monthly</option>
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {needsIndex && (
            <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {indexes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <button className="btn btn-sm btn-secondary" onClick={toggleTv}>
            {tv ? "Exit TV mode" : "TV mode"}
          </button>
        </div>
      </div>

      <div className="snap-top">
        <div className="snap-kpis">
          {data.headlines.map((h) => (
            <Kpi key={h.key} h={h} comparedWith={data.comparedWith.label} money={money} />
          ))}
        </div>
        <div className="snap-card">
          <div className="snap-chart-head">
            <div>
              <h2>Revenue Trend</h2>
              <p className="snap-note">Monthly order revenue — {data.trend.thisYear} vs {data.trend.lastYear}</p>
            </div>
          </div>
          <div ref={chartSlot} className="snap-chart-slot">
            <RevenueTrendChart
              embedded
              height={chartHeight}
              thisYear={data.trend.thisYear}
              lastYear={data.trend.lastYear}
              months={data.trend.months}
            />
          </div>
        </div>
      </div>

      <div className="snap-matrix">
        <MatrixCol
          title="Billing"
          note={
            data.moneyIn.collectionRatePercent === null
              ? "No invoices issued, so no collection rate"
              : `${data.moneyIn.collectionRatePercent}% of what was invoiced has been collected`
          }
          rows={[
            { label: "Invoiced", value: money(data.moneyIn.invoiced) },
            { label: "Collected", value: money(data.moneyIn.collected), tone: "var(--success)" },
            {
              label: "Outstanding",
              value: money(data.moneyIn.outstanding),
              tone: data.moneyIn.overdue > 0 ? "var(--danger)" : undefined,
            },
            {
              label: `Drafted, never sent (${data.moneyIn.unsent.count})`,
              value: money(data.moneyIn.unsent.value),
              tone: data.moneyIn.unsent.value > 0 ? "var(--danger)" : undefined,
            },
          ]}
        />
        <MatrixCol
          title="Cost"
          note={`Everything that cost money in ${data.period.label}`}
          rows={[
            { label: "Procurement", value: money(data.moneyOut.procurement) },
            { label: "Payroll", value: money(data.moneyOut.payroll) },
            { label: "Operating expenses", value: money(data.moneyOut.operatingExpenses) },
            { label: "Total", value: money(data.moneyOut.total) },
          ]}
        />
        <MatrixCol
          title="Cost centers"
          note={`${data.costCenters.centers} in use · ${data.costCenters.year} allocation`}
          rows={[
            { label: "Allocated", value: moneyWhole(data.costCenters.budget) },
            { label: "Spent", value: moneyWhole(data.costCenters.spent) },
            {
              label: "Remaining",
              value: moneyWhole(data.costCenters.budget - data.costCenters.spent),
              tone: data.costCenters.budget - data.costCenters.spent < 0 ? "var(--danger)" : undefined,
            },
            {
              label: "Over allocation",
              value: String(data.costCenters.overBudget),
              tone: data.costCenters.overBudget > 0 ? "var(--danger)" : "var(--success)",
            },
          ]}
        />
      </div>

      {/* The wins, along the bottom. This screen is walked past by the whole
          office, so it carries what is going well; the problems are raised in
          the Business Review, which reaches the people who can act on them. */}
      <div className="snap-attention">
        {data.highlights.length === 0 ? (
          <div className="snap-flag">
            <div className="snap-flag-title">No results recorded yet for {data.period.label}.</div>
          </div>
        ) : (
          data.highlights.map((h) => (
            <div className="snap-flag" key={h.title} style={{ borderLeftColor: "var(--success)" }}>
              <div className="snap-flag-title">{h.title}</div>
              <div className="snap-flag-detail">{fillAmounts(h.detail, h.amounts, money)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
