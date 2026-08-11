import { useState } from "react";
import { downloadFile } from "../api/client";
import { useAuth } from "../context/AuthContext";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Reports() {
  const { user, employee } = useAuth();
  const now = new Date();

  const [periodType, setPeriodType] = useState("monthly");
  const [periodIndex, setPeriodIndex] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [exportingSalesFinance, setExportingSalesFinance] = useState(false);

  const [poPeriodType, setPoPeriodType] = useState("monthly");
  const [poPeriodIndex, setPoPeriodIndex] = useState(now.getMonth() + 1);
  const [poYear, setPoYear] = useState(now.getFullYear());
  const [exportingPurchaseOrders, setExportingPurchaseOrders] = useState(false);

  const [payrollMonth, setPayrollMonth] = useState(now.getMonth() + 1);
  const [payrollYear, setPayrollYear] = useState(now.getFullYear());
  const [payrollHalf, setPayrollHalf] = useState(""); // "" = both halves
  const [exportingPayroll, setExportingPayroll] = useState(false);

  const [error, setError] = useState("");

  // Client-side checks just control what's shown here — the backend enforces
  // the equivalent rule independently on every request, so this page being
  // reachable at all doesn't grant access to the underlying data.
  const isFinance = (employee?.department_name || "").toLowerCase().includes("finance");
  const canExportSalesFinance = user?.role === "admin" || isFinance;
  const canExportPurchaseOrders = user?.role === "admin" || isFinance;
  const canExportPayroll = ["admin", "hr"].includes(user?.role) || isFinance;
  const canSeePage = canExportSalesFinance || canExportPurchaseOrders || canExportPayroll;

  const changePeriodType = (type) => {
    setPeriodType(type);
    if (type === "monthly") setPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setPeriodIndex(0);
  };

  const changePoPeriodType = (type) => {
    setPoPeriodType(type);
    if (type === "monthly") setPoPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setPoPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setPoPeriodIndex(0);
  };

  const exportSalesFinance = async () => {
    setExportingSalesFinance(true);
    setError("");
    try {
      await downloadFile(
        `/reports/sales-finance-export?period_type=${periodType}&year=${year}&index=${periodIndex}`,
        "marca-group-sales-finance-report.xlsx"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setExportingSalesFinance(false);
    }
  };

  const exportPurchaseOrders = async () => {
    setExportingPurchaseOrders(true);
    setError("");
    try {
      await downloadFile(
        `/reports/purchase-orders-export?period_type=${poPeriodType}&year=${poYear}&index=${poPeriodIndex}`,
        "marca-group-purchase-orders-report.xlsx"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setExportingPurchaseOrders(false);
    }
  };

  const exportPayroll = async () => {
    setExportingPayroll(true);
    setError("");
    try {
      const half = payrollHalf ? `&period_half=${payrollHalf}` : "";
      await downloadFile(
        `/reports/payroll-export?period_month=${payrollMonth}&period_year=${payrollYear}${half}`,
        "marca-group-payroll-report.xlsx"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setExportingPayroll(false);
    }
  };

  if (!canSeePage) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>Reports</h1>
            <p className="subtitle">Export sales, finance, purchase orders, and payroll data to Excel</p>
          </div>
        </div>
        <div className="empty-state">This page is available to Admin, HR, and Finance only.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p className="subtitle">Export sales, finance, purchase orders, and payroll data to Excel</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canExportSalesFinance && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Sales &amp; Finance Report</h2>
          <p className="subtitle" style={{ margin: "0 0 12px" }}>
            Downloads one Excel workbook with Sales Lead Summary, Sales Targets, Orders, Sales Opportunities (per employee), and Expense Summary as separate sheets.
          </p>
          <div className="form-inline" style={{ marginBottom: 16 }}>
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
          <button type="button" className="btn" onClick={exportSalesFinance} disabled={exportingSalesFinance}>
            {exportingSalesFinance ? "Exporting…" : "Export to Excel"}
          </button>
        </div>
      )}

      {canExportPurchaseOrders && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Purchase Orders Report</h2>
          <p className="subtitle" style={{ margin: "0 0 12px" }}>
            Downloads an Excel workbook of purchase orders for the selected period, separate from the reports above and below.
          </p>
          <div className="form-inline" style={{ marginBottom: 16 }}>
            <div className="form-row">
              <label>Period</label>
              <select value={poPeriodType} onChange={(e) => changePoPeriodType(e.target.value)}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
            {poPeriodType === "monthly" && (
              <div className="form-row">
                <label>Month</label>
                <select value={poPeriodIndex} onChange={(e) => setPoPeriodIndex(Number(e.target.value))}>
                  {MONTH_NAMES.slice(1).map((name, i) => (
                    <option key={name} value={i + 1}>{name}</option>
                  ))}
                </select>
              </div>
            )}
            {poPeriodType === "quarterly" && (
              <div className="form-row">
                <label>Quarter</label>
                <select value={poPeriodIndex} onChange={(e) => setPoPeriodIndex(Number(e.target.value))}>
                  <option value={1}>Q1</option>
                  <option value={2}>Q2</option>
                  <option value={3}>Q3</option>
                  <option value={4}>Q4</option>
                </select>
              </div>
            )}
            <div className="form-row">
              <label>Year</label>
              <input type="number" value={poYear} onChange={(e) => setPoYear(Number(e.target.value))} />
            </div>
          </div>
          <button type="button" className="btn" onClick={exportPurchaseOrders} disabled={exportingPurchaseOrders}>
            {exportingPurchaseOrders ? "Exporting…" : "Export to Excel"}
          </button>
        </div>
      )}

      {canExportPayroll && (
        <div className="card">
          <h2>Payroll Report</h2>
          <p className="subtitle" style={{ margin: "0 0 12px" }}>
            Downloads an Excel workbook of payroll records for the selected period, separate from the reports above.
          </p>
          <div className="form-inline" style={{ marginBottom: 16 }}>
            <div className="form-row">
              <label>Month</label>
              <select value={payrollMonth} onChange={(e) => setPayrollMonth(Number(e.target.value))}>
                {MONTH_NAMES.slice(1).map((name, i) => (
                  <option key={name} value={i + 1}>{name}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Year</label>
              <input type="number" value={payrollYear} onChange={(e) => setPayrollYear(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Cut-off</label>
              <select value={payrollHalf} onChange={(e) => setPayrollHalf(e.target.value)}>
                <option value="">Both halves</option>
                <option value="1">1st half (1–15)</option>
                <option value="2">2nd half (16–end)</option>
              </select>
            </div>
          </div>
          <button type="button" className="btn" onClick={exportPayroll} disabled={exportingPayroll}>
            {exportingPayroll ? "Exporting…" : "Export to Excel"}
          </button>
        </div>
      )}
    </div>
  );
}
