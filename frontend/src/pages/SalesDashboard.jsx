import { useEffect, useState } from "react";
import { api } from "../api/client";
import Funnel from "../components/Funnel";
import Meter from "../components/Meter";
import RevenueTrendChart from "../components/RevenueTrendChart";
import PieChart from "../components/PieChart";

const money = (n) => `₱${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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

function periodLabel(periodType, year, index) {
  if (periodType === "yearly") return `${year}`;
  if (periodType === "quarterly") return `Q${index} ${year}`;
  return `${MONTH_NAMES[index]} ${year}`;
}

function YtdComparison({ thisYear, lastYear }) {
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
      <span className="subtitle" style={{ margin: 0 }}>vs {money(lastYear)} same period last year</span>
    </div>
  );
}

export default function SalesDashboard() {
  const [stats, setStats] = useState(null);
  const [revenueTrend, setRevenueTrend] = useState(null);
  const [targets, setTargets] = useState([]);
  const [pnl, setPnl] = useState(null);
  const [expensesReport, setExpensesReport] = useState(null);
  const [error, setError] = useState("");
  const now = new Date();
  const [periodType, setPeriodType] = useState("monthly");
  const [periodIndex, setPeriodIndex] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [expPeriodType, setExpPeriodType] = useState("monthly");
  const [expPeriodIndex, setExpPeriodIndex] = useState(now.getMonth() + 1);
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
      .get(`/sales/profit-loss?period_type=${periodType}&year=${year}&index=${periodIndex}`)
      .then(setPnl)
      .catch((err) => setError(err.message));

  const loadExpensesReport = () =>
    api
      .get(`/sales/expenses-report?period_type=${expPeriodType}&year=${expYear}&index=${expPeriodIndex}`)
      .then(setExpensesReport)
      .catch((err) => setError(err.message));

  useEffect(() => {
    api.get("/sales/stats").then(setStats).catch((err) => setError(err.message));
    api.get("/sales/revenue-trend").then(setRevenueTrend).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadTargets();
    loadPnl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodType, periodIndex, year]);

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
          <div className="stat-value">{money(stats.kpis.pipelineValue)}</div>
          <div className="stat-label">Open pipeline value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.wonValue)}</div>
          <div className="stat-label">Won value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.kpis.openDeals}</div>
          <div className="stat-label">Open opportunities</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.ordersRevenue)}</div>
          <div className="stat-label">Orders revenue</div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.ordersRevenueYtdThisYear)}</div>
          <div className="stat-label">Order revenue — year to date (as of {stats.kpis.ytdAsOf})</div>
          <YtdComparison thisYear={stats.kpis.ordersRevenueYtdThisYear} lastYear={stats.kpis.ordersRevenueYtdLastYear} />
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.orderBacklogValue)}</div>
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

      {revenueTrend && <RevenueTrendChart thisYear={revenueTrend.thisYear} lastYear={revenueTrend.lastYear} months={revenueTrend.months} />}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-header" style={{ marginBottom: 4 }}>
            <div>
              <h2>Profit &amp; Loss</h2>
              <p className="subtitle" style={{ margin: 0 }}>
                Order revenue minus procurement, payroll, and operating expenses for {periodLabel(periodType, year, periodIndex)}
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

          {!pnl && <div className="page-loading">Loading…</div>}
          {pnl && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 20 }}>
                <div className="stat-card">
                  <div className="stat-value">{money(pnl.totals.totalRevenue)}</div>
                  <div className="stat-label">Total revenue</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{money(pnl.totals.totalCosts)}</div>
                  <div className="stat-label">Total costs</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: pnl.totals.netProfit >= 0 ? "var(--success)" : "var(--danger)" }}>
                    {pnl.totals.netProfit >= 0 ? money(pnl.totals.netProfit) : `-${money(Math.abs(pnl.totals.netProfit))}`}
                  </div>
                  <div className="stat-label">{pnl.totals.netProfit >= 0 ? "Net profit" : "Net loss"}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{pnl.totals.profitMarginPercent === null ? "—" : `${pnl.totals.profitMarginPercent.toFixed(1)}%`}</div>
                  <div className="stat-label">Profit margin</div>
                </div>
              </div>

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
                  <div className="stat-value">{money(expensesReport.totals.totalCashAdvance)}</div>
                  <div className="stat-label">Total cash advance</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{money(expensesReport.totals.totalExpenses)}</div>
                  <div className="stat-label">Total expenses</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: expensesReport.totals.balance >= 0 ? "var(--success)" : "var(--danger)" }}>
                    {money(Math.abs(expensesReport.totals.balance))}
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

              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 280px" }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>By Expenses Type</h3>
                  <PieChart
                    data={expensesReport.byType.map((t) => ({
                      label: t.type,
                      value: t.amount,
                      color: EXPENSE_TYPE_COLORS[t.type] || EXPENSE_TYPE_COLORS.Unspecified,
                    }))}
                  />
                </div>
                <div style={{ flex: "1 1 280px" }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>By Title / Purpose</h3>
                  <PieChart
                    data={expensesReport.byTitle.map((t, i) => ({
                      label: t.title,
                      value: t.amount,
                      color: titleColor(t.title, i),
                    }))}
                  />
                </div>
              </div>
            </>
          )}
        </div>

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

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Sales Lead Summary</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          Every opportunity owned by each rep, bucketed by when it was created — live from Sales Opportunities
        </p>
        {targets.length === 0 && <div className="empty-state">No sales employees found.</div>}
        {targets.length > 0 && (
          <table>
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

      {editingTarget && (
        <div className="modal-backdrop" onClick={() => setEditingTarget(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveTarget}>
            <h2>Set target — {editingTarget.employee_name}</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              {periodLabel(periodType, year, periodIndex)}
            </p>
            <div className="form-row">
              <label>Target amount</label>
              <input type="number" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} autoFocus />
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
