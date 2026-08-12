import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import { useAuth } from "../context/AuthContext";
import Funnel from "../components/Funnel";


export default function Dashboard() {
  const { money } = useAppSettings();
  const { user, employee } = useAuth();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get("/dashboard/stats")
      .then(setStats)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!stats) return <div className="page-loading">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Welcome{employee ? `, ${employee.first_name}` : ""}</h1>
          <p className="subtitle">Here's what's happening today.</p>
        </div>
      </div>

      {user.role === "employee" ? (
        <div className="grid grid-4">
          <div className="stat-card">
            <div className="stat-value">{stats.pendingLeave}</div>
            <div className="stat-label">Pending leave requests</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.todayAttendance ? stats.todayAttendance.status : "—"}</div>
            <div className="stat-label">Today's attendance</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.latestReview ? `${stats.latestReview.rating}/5` : "—"}</div>
            <div className="stat-label">Latest performance rating</div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-4">
            <div className="stat-card">
              <div className="stat-value">{stats.totalEmployees}</div>
              <div className="stat-label">Active employees</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.totalDepartments}</div>
              <div className="stat-label">Departments</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.pendingLeaveRequests}</div>
              <div className="stat-label">Pending leave requests</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.presentToday}</div>
              <div className="stat-label">Present today</div>
            </div>
          </div>

          <div className="card">
            <h2>Employees by department</h2>
            <table>
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Employees</th>
                </tr>
              </thead>
              <tbody>
                {stats.byDepartment.map((d) => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td>{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Funnel
            title="Expense report funnel"
            subtitle="How liquidation/expense reports move from creation to reimbursement"
            stages={stats.expenseFunnel?.stages}
            branchLabel="Rejected"
            branchCount={stats.expenseFunnel?.rejected}
            branchUnit="report"
          />

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Expense Summary</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Every expense item claimed by each employee, live from Liquidation &amp; Expense Reports
            </p>
            {(!stats.expenseSummary || stats.expenseSummary.length === 0) && (
              <div className="empty-state">No expense items recorded yet.</div>
            )}
            {stats.expenseSummary && stats.expenseSummary.length > 0 && (
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
                  {stats.expenseSummary.map((row) => (
                    <tr key={row.employee_id}>
                      <td>{row.employee_name}</td>
                      <td>{row.monthly_count} · {money(row.monthly_total)}</td>
                      <td>{row.quarterly_count} · {money(row.quarterly_total)}</td>
                      <td>{row.annual_count} · {money(row.annual_total)}</td>
                      <td>{row.total_count} · {money(row.total_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
