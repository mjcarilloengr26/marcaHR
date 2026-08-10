import { useEffect, useState } from "react";
import { api } from "../api/client";

const ACTION_LABELS = {
  login: "Login",
  logout: "Logout",
  create_user: "Create user",
  update_user: "Update user",
  delete_user: "Delete user",
  create_employee: "Create employee",
  update_employee: "Update employee",
  delete_employee: "Delete employee",
  create_department: "Create department",
  update_department: "Update department",
  delete_department: "Delete department",
  deal_stage_change: "Opportunity stage change",
  update_sales_target: "Update sales target",
  export_excel: "Export to Excel",
  update_leave_type: "Update leave type",
  generate_payroll: "Generate payroll",
  update_payroll: "Update payroll",
  update_payroll_settings: "Update payroll settings",
  email_sent: "Email sent",
  email_failed: "Email failed",
  email_skipped: "Email skipped",
};

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function formatDetails(detailsJson) {
  if (!detailsJson) return "—";
  try {
    const obj = JSON.parse(detailsJson);
    return Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "—";
  } catch {
    return detailsJson;
  }
}

export default function Events() {
  const [events, setEvents] = useState([]);
  const [actions, setActions] = useState([]);
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/events/actions").then(setActions).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (q) params.set("q", q);
    api
      .get(`/events?${params.toString()}`)
      .then(setEvents)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  const onSearchSubmit = (e) => {
    e.preventDefault();
    load();
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Events</h1>
          <p className="subtitle">Audit trail — logins, logouts, and record changes across the app</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <form className="form-inline" style={{ marginBottom: 16 }} onSubmit={onSearchSubmit}>
          <div className="form-row">
            <label>Action</label>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>{actionLabel(a)}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Search</label>
            <input
              type="text"
              placeholder="User, entity, details…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-secondary">Search</button>
        </form>

        {loading && <div className="page-loading">Loading…</div>}
        {!loading && events.length === 0 && <div className="empty-state">No events found.</div>}
        {!loading && events.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{e.created_at}</td>
                  <td>{e.user_email || "—"}</td>
                  <td>{actionLabel(e.action)}</td>
                  <td>{e.entity_type ? `${e.entity_type}${e.entity_id ? ` #${e.entity_id}` : ""}` : "—"}</td>
                  <td>{formatDetails(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
