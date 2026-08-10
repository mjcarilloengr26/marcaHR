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
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  // Client-side check just controls what's shown here — the backend enforces the
  // same "admin or Finance department/title" rule independently on every request,
  // so this page being reachable at all doesn't grant access to the data itself.
  const canExport =
    user?.role === "admin" || (employee?.department_name || "").toLowerCase().includes("finance");

  const changePeriodType = (type) => {
    setPeriodType(type);
    if (type === "monthly") setPeriodIndex(now.getMonth() + 1);
    else if (type === "quarterly") setPeriodIndex(Math.floor(now.getMonth() / 3) + 1);
    else setPeriodIndex(0);
  };

  const exportToExcel = async () => {
    setExporting(true);
    setError("");
    try {
      await downloadFile(
        `/reports/sales-finance-export?period_type=${periodType}&year=${year}&index=${periodIndex}`,
        "marca-group-sales-finance-report.xlsx"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  if (!canExport) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>Reports</h1>
            <p className="subtitle">Export sales and finance data to Excel</p>
          </div>
        </div>
        <div className="empty-state">This page is available to Admin and Finance only.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p className="subtitle">Export sales and finance data to Excel</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2>Sales &amp; Finance Report</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          Downloads one Excel workbook with Sales Lead Summary, Sales Targets, Orders, and Expense Summary as separate sheets.
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
        <button type="button" className="btn" onClick={exportToExcel} disabled={exporting}>
          {exporting ? "Exporting…" : "Export to Excel"}
        </button>
      </div>
    </div>
  );
}
