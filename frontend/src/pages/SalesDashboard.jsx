import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import Funnel from "../components/Funnel";
import Meter from "../components/Meter";
import RevenueTrendChart from "../components/RevenueTrendChart";
import PieChart from "../components/PieChart";
import BarChart from "../components/BarChart";
import DecimalInput from "../components/DecimalInput";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Fixed categorical hues, one per cost/profit category — reused across the
// pie and its legend so a slice's color always means the same thing. Net
// Profit gets the app's --success green (it's the "good" leftover), the
// three cost lines get distinct hues (blue/amber/violet) rather than shades
// of one color, since they're identities to distinguish, not a magnitude ramp.
const PNL_COLORS = {
  netProfit: "#1e8e5a",
  payroll: "#3454d1",
  procurement: "#b8860b",
  operatingExpenses: "#8b5cf6",
};

// Fixed categorical hues for expense types — Unspecified (reports created
// before the Expenses Type dropdown existed, or left blank) gets a neutral
// gray rather than a "real" category color, since it isn't an identity so
// much as an absence of one.
const EXPENSE_TYPE_COLORS = {
  "Operating Expenses": "#2f6fed",
  "Project Expenses": "#e0930b",
  Unspecified: "#6b7280",
};

// Title/Purpose isn't a fixed small taxonomy like Expenses Type — the
// dropdown offers ~13 presets plus arbitrary free text when "Others" is
// picked, so slices are colored by position in this rotation (already
// sorted by amount, largest first) rather than a per-label fixed map.
// "Unspecified" (reports predating the dropdown) still gets the same
// neutral gray used elsewhere for "no real category".
const TITLE_PALETTE = [
  "#2f6fed", "#e0930b", "#1e8e5a", "#d64550", "#8b5cf6",
  "#0891b2", "#c026d3", "#65a30d", "#b45309", "#4338ca",
  "#db2777", "#0d9488",
];
function titleColor(title, index) {
  return title === "Unspecified" ? "#6b7280" : TITLE_PALETTE[index % TITLE_PALETTE.length];
}

// Same rotation for line-item categories, with the neutral gray reserved for
// items nobody categorised — an absence, not an identity.
function categoryColor(label, index) {
  return label === "Uncategorised" ? "#6b7280" : TITLE_PALETTE[index % TITLE_PALETTE.length];
}

// Year-to-date spend against each cost centre's allocation. The bars answer
// "who is close to the line"; the table underneath answers "by how much",
// which a bar cannot say precisely enough to act on.
function CostCenterSpend({ money, moneyWhole }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get(`/cost-centers?year=${year}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [year]);

  if (error || !data) return null;

  // Only cost centres that have an allocation or some spend. A list padded
  // with untouched, unbudgeted rows buries the ones that matter.
  const rows = data.centers.filter((c) => c.budget > 0 || c.spent > 0);
  const years = [];
  for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 3; y -= 1) years.push(y);

  const overspent = rows.filter((c) => c.overBudget);
  const nearing = rows.filter((c) => !c.overBudget && c.usedPercent !== null && c.usedPercent >= 80);
  const unbudgeted = rows.filter((c) => c.budget === 0 && c.spent > 0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Cost center spending</h2>
          <p className="subtitle" style={{ margin: 0 }}>
            Year-to-date spend against each allocation. Set the allocations under
            Administration &rsaquo; Cost Centers.
          </p>
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: "auto" }}>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          Nothing allocated or spent in {year}. Add a cost center and its allocation to start tracking.
        </div>
      ) : (
        <>
          {(overspent.length > 0 || nearing.length > 0 || unbudgeted.length > 0) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {overspent.length > 0 && (
                <span className="badge badge-rejected">
                  {overspent.length} over allocation — {moneyWhole(overspent.reduce((n, c) => n + Math.abs(c.remaining), 0))} above
                </span>
              )}
              {nearing.length > 0 && (
                <span className="badge badge-pending">{nearing.length} past 80% of allocation</span>
              )}
              {unbudgeted.length > 0 && (
                <span className="badge badge-draft">{unbudgeted.length} spending with no allocation set</span>
              )}
            </div>
          )}

          <BarChart
            data={rows.map((c) => ({ label: c.name, current: c.spent, previous: c.budget }))}
            currentLabel="Spent"
            previousLabel="Allocated"
            currentColor="#2f6fed"
            previousColor="#a9c6fb"
          />

          <div className="table-scroll" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr>
                  <th className="th-plain">Cost center</th>
                  <th className="th-plain">Allocated</th>
                  <th className="th-plain">Spent</th>
                  <th className="th-plain">Remaining</th>
                  <th className="th-plain">Used</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="col-nowrap">{c.budget > 0 ? money(c.budget) : <span className="subtitle">none set</span>}</td>
                    <td className="col-nowrap">{money(c.spent)}</td>
                    <td className="col-nowrap" style={{ color: c.remaining < 0 ? "var(--danger)" : undefined }}>
                      {c.budget > 0 ? money(c.remaining) : "—"}
                    </td>
                    <td className="col-nowrap">
                      {c.usedPercent === null ? (
                        <span className="subtitle">—</span>
                      ) : (
                        <span style={{ color: c.overBudget ? "var(--danger)" : c.usedPercent >= 80 ? "var(--warning)" : undefined }}>
                          {c.usedPercent}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.unassigned.length > 0 && (
            <p className="subtitle" style={{ marginTop: 12, marginBottom: 0 }}>
              {moneyWhole(data.unassigned.reduce((n, u) => n + u.spent, 0))} was booked to names that are
              not set up as cost centers, so no allocation is watching it — listed under Administration
              &rsaquo; Cost Centers.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function periodLabel(periodType, year, index) {
  if (periodType === "yearly") return `${year}`;
  if (periodType === "quarterly") return `Q${index} ${year}`;
  return `${MONTH_NAMES[index]} ${year}`;
}

function YtdComparison({ thisYear, lastYear }) {
  const { moneyWhole } = useAppSettings();
  if (!lastYear) {
    return (
      <div className="subtitle" style={{ margin: "6px 0 0" }}>
        No orders in the same period last year to compare against.
      </div>
    );
  }
  const change = ((thisYear - lastYear) / lastYear) * 100;
  const up = change >= 0;
  return (
    <div style={{ marginTop: 6, fontSize: 13 }}>
      <span style={{ color: up ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
        {up ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
      </span>{" "}
      <span className="subtitle" style={{ margin: 0 }}>vs {moneyWhole(lastYear)} same period last year</span>
    </div>
  );
}



// A pipeline that has stopped moving is the thing a sales review exists to
// catch, and it is invisible on every other tile here: open pipeline value
// looks identical whether the deals are progressing or parked.
function PipelineAging({ aging, money, moneyWhole, isHr, thresholdDraft, setThresholdDraft, saveThreshold, savingThreshold }) {
  if (!aging) return null;
  const { totals, byStage, worst, thresholdDays, staleCount } = aging;
  const clean = staleCount === 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 4 }}>
        <div>
          <h2>Pipeline aging</h2>
          <p className="subtitle" style={{ margin: 0 }}>
            Open opportunities that have not moved for {thresholdDays}+ days, or have run past their expected close date
          </p>
        </div>
        {isHr && (
          <div className="form-inline" style={{ gap: 8 }}>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: 12 }}>Stale after (days)</label>
              <input
                type="number"
                min="1"
                max="365"
                style={{ width: 90 }}
                value={thresholdDraft}
                onChange={(e) => setThresholdDraft(e.target.value)}
              />
            </div>
            <button
              className="btn btn-sm btn-secondary"
              disabled={savingThreshold || Number(thresholdDraft) === thresholdDays}
              onClick={saveThreshold}
            >
              {savingThreshold ? "Saving…" : "Apply"}
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-4" style={{ marginTop: 12, marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value" style={{ color: totals.stalledCount ? "var(--danger)" : undefined }}>
            {totals.stalledCount}
          </div>
          <div className="stat-label">Stalled {thresholdDays}+ days — {moneyWhole(totals.stalledValue)} at risk</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: totals.overdueCount ? "var(--danger)" : undefined }}>
            {totals.overdueCount}
          </div>
          <div className="stat-label">Past expected close — {moneyWhole(totals.overdueValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totals.avgDaysInStage}d</div>
          <div className="stat-label">Average time in current stage</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totals.noCloseDate}</div>
          <div className="stat-label">Open with no close date set</div>
        </div>
      </div>

      {byStage.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Open</th>
                <th>Value</th>
                <th>Average age in stage</th>
                <th>Oldest</th>
              </tr>
            </thead>
            <tbody>
              {byStage.map((row) => (
                <tr key={row.stage}>
                  <td><span className="badge badge-neutral">{row.stage}</span></td>
                  <td>{row.count}</td>
                  <td>{money(row.value)}</td>
                  <td>{row.avgDays}d</td>
                  <td style={{ color: row.oldestDays >= thresholdDays ? "var(--danger)" : undefined }}>
                    {row.oldestDays}d
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {clean ? (
        <div className="empty-state">
          Nothing has gone quiet — every open opportunity has moved within {thresholdDays} days and is inside its close date.
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: 15 }}>
            Needs attention
            {staleCount > worst.length && (
              <span className="subtitle" style={{ fontSize: 12, fontWeight: 400 }}>
                {" "}— worst {worst.length} of {staleCount}
              </span>
            )}
          </h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Opportunity</th>
                  <th>Customer</th>
                  <th>Owner</th>
                  <th>Value</th>
                  <th>Stage</th>
                  <th>In stage</th>
                  <th>Past close</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td>{d.customer_name}</td>
                    <td>{d.owner_name || "Unassigned"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{money(d.value)}</td>
                    <td><span className="badge badge-neutral">{d.stage}</span></td>
                    <td
                      style={{
                        whiteSpace: "nowrap",
                        color: d.days_in_stage >= thresholdDays ? "var(--danger)" : undefined,
                        fontWeight: d.days_in_stage >= thresholdDays ? 600 : 400,
                      }}
                    >
                      {d.days_in_stage}d
                    </td>
                    <td style={{ whiteSpace: "nowrap", color: d.days_past_close > 0 ? "var(--danger)" : undefined }}>
                      {d.days_past_close === null ? "no date" : d.days_past_close > 0 ? `${d.days_past_close}d` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function SalesDashboard() {
  const { money, moneyWhole } = useAppSettings();
  const [stats, setStats] = useState(null);
  const [revenueTrend, setRevenueTrend] = useState(null);
  const [targets, setTargets] = useState([]);
  const [pnl, setPnl] = useState(null);
  const [expensesReport, setExpensesReport] = useState(null);
  const [aging, setAging] = useState(null);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);
  const { user } = useAuth();
  const isHrUser = user?.role === "admin" || user?.role === "hr";
  const [error, setError] = useState("");
  const now = new Date();
  const [pnlPeriodType, setPnlPeriodType] = useState("yearly");
  const [pnlPeriodIndex, setPnlPeriodIndex] = useState(0);
  const [pnlYear, setPnlYear] = useState(now.getFullYear());
  const [periodType, setPeriodType] = useState("monthly");
  const [periodIndex, setPeriodIndex] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [expPeriodType, setExpPeriodType] = useState("yearly");
  const [expPeriodIndex, setExpPeriodIndex] = useState(0);
  const [expYear, setExpYear] = useState(now.getFullYear());
  const [editingTarget, setEditingTarget] = useState(null);
  const [targetAmount, setTargetAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const loadTargets = () =>
    api
      .get(`/sales/targets?period_type=${periodType}&year=${year}&index=${periodIndex}`)
      .then(setTargets)
      .catch((err) => setError(err.message));

  const loadPnl = () =>
    api
      .get(`/sales/profit-loss?period_type=${pnlPeriodType}&year=${pnlYear}&index=${pnlPeriodIndex}`)
      .then(setPnl)
      .catch((err) => setError(err.message));

  const loadExpensesReport = () =>
    api
      .get(`/sales/expenses-report?period_type=${expPeriodType}&year=${expYear}&index=${expPeriodIndex}`)
      .then(setExpensesReport)
      .catch((err) => setError(err.message));

  const loadAging = () =>
    api
      .get("/deals/aging/summary")
      .then((d) => {
        setAging(d);
        setThresholdDraft(String(d.thresholdDays));
      })
      // Aging is one card on a page of many; if it fails the rest of the
      // dashboard should still be readable.
      .catch(() => {});

  const saveThreshold = async () => {
    const days = Number(thresholdDraft);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError("Stale-after must be a whole number of days between 1 and 365");
      return;
    }
    setSavingThreshold(true);
    setError("");
    try {
      const updated = await api.put("/deals/aging/settings", { stale_deal_days: days });
      setAging(updated);
      setThresholdDraft(String(updated.thresholdDays));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingThreshold(false);
    }
  };

  useEffect(() => {
    api.get("/sales/stats").then(setStats).catch((err) => setError(err.message));
    api.get("/sales/revenue-trend").then(setRevenueTrend).catch((err) => setError(err.message));
    loadAging();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodType, periodIndex, year]);

  useEffect(() => {
    loadPnl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnlPeriodType, pnlPeriodIndex, pnlYear]);

  useEffect(() => {
    loadExpensesReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expPeriodType, expPeriodIndex, expYear]);

  const changePeriodType = (type) => {
    setPeriodType(type);
    if (type === "monthly") setPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setPeriodIndex(0);
  };

  const changePnlPeriodType = (type) => {
    setPnlPeriodType(type);
    if (type === "monthly") setPnlPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setPnlPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setPnlPeriodIndex(0);
  };

  const changeExpPeriodType = (type) => {
    setExpPeriodType(type);
    if (type === "monthly") setExpPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setExpPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setExpPeriodIndex(0);
  };

  const openEdit = (row) => {
    setEditingTarget(row);
    setTargetAmount(row.target_amount || "");
  };

  const saveTarget = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/sales/targets", {
        employee_id: editingTarget.employee_id,
        period_type: periodType,
        period_year: year,
        period_index: periodIndex,
        target_amount: Number(targetAmount) || 0,
      });
      setEditingTarget(null);
      loadTargets();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!stats) return <div className="page-loading">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sales Dashboard</h1>
          <p className="subtitle">Pipeline and order fulfillment at a glance</p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(stats.kpis.pipelineValue)}</div>
          <div className="stat-label">Open pipeline value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(stats.kpis.wonValue)}</div>
          <div className="stat-label">Won value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.kpis.openDeals}</div>
          <div className="stat-label">Open opportunities</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(stats.kpis.ordersRevenue)}</div>
          <div className="stat-label">Orders revenue</div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(stats.kpis.ordersRevenueYtdThisYear)}</div>
          <div className="stat-label">Order revenue — year to date (as of {stats.kpis.ytdAsOf})</div>
          <YtdComparison thisYear={stats.kpis.ordersRevenueYtdThisYear} lastYear={stats.kpis.ordersRevenueYtdLastYear} />
        </div>
        <div className="stat-card">
          <div className="stat-value">{moneyWhole(stats.kpis.orderBacklogValue)}</div>
          <div className="stat-label">
            Order backlog — {stats.kpis.orderBacklogCount} order{stats.kpis.orderBacklogCount === 1 ? "" : "s"} not yet delivered
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.kpis.winRate === null ? "—" : `${stats.kpis.winRate.toFixed(0)}%`}</div>
          <div className="stat-label">
            Win rate — {stats.kpis.wonDeals} won / {stats.kpis.lostDeals} lost
            {stats.kpis.winRate === null && " (no closed opportunities yet)"}
          </div>
        </div>
      </div>

      {/* Section heading. The page mixed money in among the sales cards —
          Profit & Loss and the expense breakdowns sat between the KPI tiles
          and the pipeline funnels — so reading it meant crossing subjects
          twice. Everything about winning work comes first, everything about
          spending after, with a heading so the break is visible. */}
      <h2 style={{ margin: "26px 0 2px", fontSize: 18 }}>Sales performance</h2>
      <p className="subtitle" style={{ marginBottom: 14 }}>Pipeline, fulfilment and how each rep is tracking.</p>

      {revenueTrend && <RevenueTrendChart thisYear={revenueTrend.thisYear} lastYear={revenueTrend.lastYear} months={revenueTrend.months} />}


      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Funnel
          title="Sales pipeline"
          subtitle="Opportunities by stage reached"
          stages={stats.dealFunnel.stages}
          branchLabel="Lost"
          branchCount={stats.dealFunnel.lost}
          branchUnit="opportunity"
          branchUnitPlural="opportunities"
        />
        <Funnel
          title="Order fulfillment"
          subtitle="Orders by status reached"
          stages={stats.orderFunnel.stages}
          branchLabel="Cancelled"
          branchCount={stats.orderFunnel.cancelled}
          branchUnit="order"
        />
      </div>

      <PipelineAging
        aging={aging}
        money={money}
        moneyWhole={moneyWhole}
        isHr={isHrUser}
        thresholdDraft={thresholdDraft}
        setThresholdDraft={setThresholdDraft}
        saveThreshold={saveThreshold}
        savingThreshold={savingThreshold}
      />

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Sales Lead Summary</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          Every opportunity owned by each rep, bucketed by when it was created — live from Sales Opportunities
        </p>
        {targets.length === 0 && <div className="empty-state">No sales employees found.</div>}
        {targets.length > 0 && (
          <table className="sticky-head">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Monthly</th>
                <th>Quarterly</th>
                <th>Annually</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => (
                <tr key={row.employee_id}>
                  <td>{row.employee_name}</td>
                  <td>{row.monthly_leads} · {money(row.monthly_lead_value)}</td>
                  <td>{row.quarterly_leads} · {money(row.quarterly_lead_value)}</td>
                  <td>{row.annual_leads} · {money(row.annual_lead_value)}</td>
                  <td>{row.total_leads} · {money(row.total_lead_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="page-header" style={{ marginBottom: 4 }}>
          <div>
            <h2>Sales targets</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              Won opportunity value + order revenue vs. each rep's target
            </p>
          </div>
          <div className="form-inline">
            <div className="form-row">
              <label>Period</label>
              <select value={periodType} onChange={(e) => changePeriodType(e.target.value)}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
            {periodType === "monthly" && (
              <div className="form-row">
                <label>Month</label>
                <select value={periodIndex} onChange={(e) => setPeriodIndex(Number(e.target.value))}>
                  {MONTH_NAMES.slice(1).map((name, i) => (
                    <option key={name} value={i + 1}>{name}</option>
                  ))}
                </select>
              </div>
            )}
            {periodType === "quarterly" && (
              <div className="form-row">
                <label>Quarter</label>
                <select value={periodIndex} onChange={(e) => setPeriodIndex(Number(e.target.value))}>
                  <option value={1}>Q1</option>
                  <option value={2}>Q2</option>
                  <option value={3}>Q3</option>
                  <option value={4}>Q4</option>
                </select>
              </div>
            )}
            <div className="form-row">
              <label>Year</label>
              <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
            </div>
          </div>
        </div>

        {targets.length === 0 && (
          <div className="empty-state">No sales employees found for {periodLabel(periodType, year, periodIndex)}.</div>
        )}
        {targets.map((row) => (
          <Meter
            key={row.employee_id}
            label={row.employee_name}
            value={row.actual_amount}
            max={row.target_amount}
            formatValue={money}
            onEdit={() => openEdit(row)}
          />
        ))}
      </div>

      <h2 style={{ margin: "30px 0 2px", fontSize: 18 }}>Money and spending</h2>
      <p className="subtitle" style={{ marginBottom: 14 }}>
        What the work earned after costs, where the money went, and how each cost center is
        tracking against its allocation.
      </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-header" style={{ marginBottom: 4 }}>
            <div>
              <h2>Profit &amp; Loss</h2>
              <p className="subtitle" style={{ margin: 0 }}>
                Order revenue minus procurement, payroll, and operating expenses for {periodLabel(pnlPeriodType, pnlYear, pnlPeriodIndex)}
              </p>
            </div>
            <div className="form-inline">
              <div className="form-row">
                <label>Period</label>
                <select value={pnlPeriodType} onChange={(e) => changePnlPeriodType(e.target.value)}>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              {pnlPeriodType === "monthly" && (
                <div className="form-row">
                  <label>Month</label>
                  <select value={pnlPeriodIndex} onChange={(e) => setPnlPeriodIndex(Number(e.target.value))}>
                    {MONTH_NAMES.slice(1).map((name, i) => (
                      <option key={name} value={i + 1}>{name}</option>
                    ))}
                  </select>
                </div>
              )}
              {pnlPeriodType === "quarterly" && (
                <div className="form-row">
                  <label>Quarter</label>
                  <select value={pnlPeriodIndex} onChange={(e) => setPnlPeriodIndex(Number(e.target.value))}>
                    <option value={1}>Q1</option>
                    <option value={2}>Q2</option>
                    <option value={3}>Q3</option>
                    <option value={4}>Q4</option>
                  </select>
                </div>
              )}
              <div className="form-row">
                <label>Year</label>
                <input type="number" value={pnlYear} onChange={(e) => setPnlYear(Number(e.target.value))} />
              </div>
            </div>
          </div>

          {!pnl && <div className="page-loading">Loading…</div>}
          {pnl && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 20 }}>
                <div className="stat-card">
                  <div className="stat-value">{moneyWhole(pnl.totals.totalRevenue)}</div>
                  <div className="stat-label">Total revenue</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{moneyWhole(pnl.totals.totalCosts)}</div>
                  <div className="stat-label">Total costs</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: pnl.totals.netProfit >= 0 ? "var(--success)" : "var(--danger)" }}>
                    {pnl.totals.netProfit >= 0 ? moneyWhole(pnl.totals.netProfit) : `-${moneyWhole(Math.abs(pnl.totals.netProfit))}`}
                  </div>
                  <div className="stat-label">{pnl.totals.netProfit >= 0 ? "Net profit" : "Net loss"}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{pnl.totals.profitMarginPercent === null ? "—" : `${pnl.totals.profitMarginPercent.toFixed(1)}%`}</div>
                  <div className="stat-label">Profit margin</div>
                </div>
              </div>

              {/* Same fixed width the Expenses Report pies use, so all three pies
                  on this page occupy an identical block instead of this one
                  spanning the whole card. The circle itself is already a fixed
                  160px inside PieChart; this pins the legend beside it too. */}
              <div style={{ maxWidth: 460 }}>
                <PieChart
                  data={
                    pnl.totals.netProfit >= 0
                      ? [
                          { label: "Net Profit", value: pnl.totals.netProfit, color: PNL_COLORS.netProfit },
                          { label: "Payroll", value: pnl.costs.payroll, color: PNL_COLORS.payroll },
                          { label: "Procurement", value: pnl.costs.procurement, color: PNL_COLORS.procurement },
                          { label: "Operating Expenses", value: pnl.costs.operatingExpenses, color: PNL_COLORS.operatingExpenses },
                        ]
                      : [
                          { label: "Payroll", value: pnl.costs.payroll, color: PNL_COLORS.payroll },
                          { label: "Procurement", value: pnl.costs.procurement, color: PNL_COLORS.procurement },
                          { label: "Operating Expenses", value: pnl.costs.operatingExpenses, color: PNL_COLORS.operatingExpenses },
                        ]
                  }
                />
              </div>
              {pnl.totals.netProfit < 0 && (
                <p className="subtitle" style={{ marginTop: 12, marginBottom: 0 }}>
                  Costs exceeded revenue this period, so the chart shows cost composition only (no profit slice to draw).
                </p>
              )}
            </>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-header" style={{ marginBottom: 4 }}>
            <div>
              <h2>Expenses Report</h2>
              <p className="subtitle" style={{ margin: 0 }}>
                Liquidation &amp; expense report cash advances vs. actual spend for {periodLabel(expPeriodType, expYear, expPeriodIndex)}
              </p>
            </div>
            <div className="form-inline">
              <div className="form-row">
                <label>Period</label>
                <select value={expPeriodType} onChange={(e) => changeExpPeriodType(e.target.value)}>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              {expPeriodType === "monthly" && (
                <div className="form-row">
                  <label>Month</label>
                  <select value={expPeriodIndex} onChange={(e) => setExpPeriodIndex(Number(e.target.value))}>
                    {MONTH_NAMES.slice(1).map((name, i) => (
                      <option key={name} value={i + 1}>{name}</option>
                    ))}
                  </select>
                </div>
              )}
              {expPeriodType === "quarterly" && (
                <div className="form-row">
                  <label>Quarter</label>
                  <select value={expPeriodIndex} onChange={(e) => setExpPeriodIndex(Number(e.target.value))}>
                    <option value={1}>Q1</option>
                    <option value={2}>Q2</option>
                    <option value={3}>Q3</option>
                    <option value={4}>Q4</option>
                  </select>
                </div>
              )}
              <div className="form-row">
                <label>Year</label>
                <input type="number" value={expYear} onChange={(e) => setExpYear(Number(e.target.value))} />
              </div>
            </div>
          </div>

          {!expensesReport && <div className="page-loading">Loading…</div>}
          {expensesReport && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 20 }}>
                <div className="stat-card">
                  <div className="stat-value">{moneyWhole(expensesReport.totals.totalCashAdvance)}</div>
                  <div className="stat-label">Total cash advance</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{moneyWhole(expensesReport.totals.totalExpenses)}</div>
                  <div className="stat-label">Total expenses</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: expensesReport.totals.balance >= 0 ? "var(--success)" : "var(--danger)" }}>
                    {moneyWhole(Math.abs(expensesReport.totals.balance))}
                  </div>
                  <div className="stat-label">{expensesReport.totals.balance >= 0 ? "Due to company" : "Due to employees"}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">
                    {expensesReport.totals.liquidationRatePercent === null ? "—" : `${expensesReport.totals.liquidationRatePercent.toFixed(1)}%`}
                  </div>
                  <div className="stat-label">Liquidation rate</div>
                </div>
              </div>

              {(() => {
                const byTypePieData = expensesReport.byType.map((t) => ({
                  label: t.label,
                  value: t.current,
                  color: EXPENSE_TYPE_COLORS[t.label] || EXPENSE_TYPE_COLORS.Unspecified,
                }));
                const byTitlePieData = expensesReport.byTitle.map((t, i) => ({
                  label: t.label,
                  value: t.current,
                  color: titleColor(t.label, i),
                }));
                // Colour is assigned once per label from the combined
                // totals, then reused in every section. Colouring by position
                // within each pie would give Meals one colour under Operating
                // and another under Project, which is precisely what makes two
                // pies impossible to read against each other.
                // One colour map across every pie, keyed on the label and
                // shared by both dimensions. Utilities as a purpose and
                // Utilities as a category are the same money, so showing it in
                // two colours side by side undoes the comparison the split
                // exists to make. Assigned biggest-first so the slices that
                // matter get distinct hues before the rotation wraps.
                // Keyed case-insensitively: the purpose "SOP" and the category
                // "sop" are the same PHP 145,000, and giving them two colours
                // hides the one correspondence these charts exist to show.
                const labelTotals = new Map();
                for (const r of [...(expensesReport.byTitle || []), ...(expensesReport.byCategory || [])]) {
                  const key = String(r.label).toLowerCase();
                  labelTotals.set(key, Math.max(labelTotals.get(key) || 0, r.current + r.previous));
                }
                const sharedColor = (() => {
                  const map = new Map();
                  let i = 0;
                  for (const [key] of [...labelTotals.entries()].sort((a, b) => b[1] - a[1])) {
                    if (key === "unspecified" || key === "uncategorised") {
                      map.set(key, "#6b7280");
                      continue;
                    }
                    map.set(key, TITLE_PALETTE[i % TITLE_PALETTE.length]);
                    i += 1;
                  }
                  return (label) => map.get(String(label).toLowerCase()) || "#6b7280";
                })();
                const purposeColor = sharedColor;
                const catColor = sharedColor;
                const currentYearLabel = `${expensesReport.period.year}`;
                const previousYearLabel = `${expensesReport.previousPeriod.year}`;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div>
                      <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>By Expenses Type</h3>
                      {/* Both expense sections use identical column sizing so the two
                          bar charts match and line up. The pie column is pinned to a
                          fixed basis rather than allowed to grow — letting it grow
                          pushed the bar chart to the far right of wide screens with a
                          large empty gap. The bar then takes all remaining width, so
                          on a wide screen it runs to the right edge and more
                          categories fit before the plot has to scroll at all.
                          `0 1`/`minWidth: 0` plus wrap keeps both stacking
                          full-width on narrow screens. */}
                      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ flex: "0 1 460px", minWidth: 0 }}>
                          <PieChart data={byTypePieData} />
                        </div>
                        <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                          <BarChart
                            data={expensesReport.byType}
                            currentLabel={currentYearLabel}
                            previousLabel={previousYearLabel}
                            currentColor="#2f6fed"
                            previousColor="#a9c6fb"
                          />
                        </div>
                      </div>
                    </div>
                    {(expensesReport.breakdownsByType || []).map((section) => {
                      // One pie and one bar per dimension, laid out exactly
                      // like the By Expenses Type card above: the pie gives the
                      // split within this year, the bar gives the movement
                      // against last year. Losing the bars lost the only
                      // year-on-year comparison on the card.
                      const block = (heading, rows, barColor, prevBarColor) => (
                        <div key={heading} style={{ marginTop: 20 }}>
                          <h4 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600 }}>{heading}</h4>
                          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
                            <div style={{ flex: "0 1 460px", minWidth: 0 }}>
                              <PieChart data={rows.map((r) => ({ label: r.label, value: r.current, color: sharedColor(r.label) }))} />
                            </div>
                            <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                              <BarChart
                                data={rows}
                                currentLabel={currentYearLabel}
                                previousLabel={previousYearLabel}
                                currentColor={barColor}
                                previousColor={prevBarColor}
                              />
                            </div>
                          </div>
                        </div>
                      );
                      return (
                        <div key={section.type}>
                          <h3 style={{ margin: "0 0 2px", fontSize: 14 }}>
                            {section.type} — {moneyWhole(section.total)}
                            {expensesReport.totals.totalExpenses > 0 && (
                              <span className="subtitle" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
                                {Math.round((section.total / expensesReport.totals.totalExpenses) * 100)}% of all spend
                              </span>
                            )}
                          </h3>
                          <p className="subtitle" style={{ margin: 0, fontSize: 12 }}>
                            Purpose is what each advance was raised for; category is what the money actually
                            bought. A purpose holds several categories, so the two describe the same total
                            different ways.
                          </p>
                          {section.total === 0 ? (
                            <div className="empty-state">Nothing spent under {section.type} this period.</div>
                          ) : (
                            <>
                              {block(`${section.type} — by report purpose`, section.byTitle, "#7c3aed", "#cbb6fa")}
                              {block(`${section.type} — by category`, section.byCategory, "#0891b2", "#a5e4ef")}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}
        </div>

      <CostCenterSpend money={money} moneyWhole={moneyWhole} />

      {editingTarget && (
        <div className="modal-backdrop" onClick={() => setEditingTarget(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveTarget}>
            <h2>Set target — {editingTarget.employee_name}</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              {periodLabel(periodType, year, periodIndex)}
            </p>
            <div className="form-row">
              <label>Target amount</label>
              <DecimalInput value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingTarget(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save target"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
