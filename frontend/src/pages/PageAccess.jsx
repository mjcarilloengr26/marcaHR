import { useEffect, useState } from "react";
import { api } from "../api/client";

function formatManilaTime(dbTimestamp) {
  if (!dbTimestamp) return "—";
  const iso = `${dbTimestamp.replace(" ", "T")}${dbTimestamp.endsWith("Z") ? "" : "Z"}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dbTimestamp;
  return d.toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

// "in 4 days" / "in 3 hours" / "expired" — the number on its own doesn't say
// much without knowing today's date.
function relativeToNow(dbTimestamp) {
  if (!dbTimestamp) return "";
  const d = new Date(`${dbTimestamp.replace(" ", "T")}Z`);
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export default function PageAccess() {
  const [grants, setGrants] = useState([]);
  const [pages, setPages] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const [form, setForm] = useState({ user_id: "", page_key: "", role_label: "", mode: "days", days: 5, expires_at: "" });

  const loadGrants = () =>
    api.get("/page-access").then(setGrants).catch((err) => setError(err.message));

  useEffect(() => {
    Promise.all([
      api.get("/page-access").then(setGrants),
      api.get("/page-access/pages").then(setPages),
      api.get("/users").then(setUsers),
    ])
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const payload = {
        user_id: Number(form.user_id),
        page_key: form.page_key,
        role_label: form.role_label || null,
      };
      if (form.mode === "days") payload.days = Number(form.days);
      else payload.expires_at = form.expires_at;

      await api.post("/page-access", payload);
      setSaved("Access granted.");
      setForm({ user_id: "", page_key: "", role_label: "", mode: "days", days: 5, expires_at: "" });
      await loadGrants();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id) => {
    setError("");
    setSaved("");
    try {
      await api.del(`/page-access/${id}`);
      setSaved("Access revoked.");
      await loadGrants();
    } catch (err) {
      setError(err.message);
    }
  };

  const pageLabel = (key) => pages.find((p) => p.key === key)?.label || key;
  const userLabel = (g) => g.employee_name || g.user_email;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Page Access</h1>
          <p className="subtitle">
            Give someone temporary access to a single page — it expires on its own, no follow-up needed
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner">{saved}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Grant access</h2>
        <form onSubmit={submit}>
          <div className="grid grid-2">
            <div className="form-row">
              <label>User</label>
              <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} required>
                <option value="">Select a user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.employee_name ? `${u.employee_name} (${u.email})` : u.email} — {u.role}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Page</label>
              <select value={form.page_key} onChange={(e) => setForm({ ...form, page_key: e.target.value })} required>
                <option value="">Select a page…</option>
                {pages.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Role name (optional)</label>
              <input
                type="text"
                placeholder="e.g. Inventory Staff"
                value={form.role_label}
                onChange={(e) => setForm({ ...form, role_label: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Access lasts</label>
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="days">For a number of days</option>
                <option value="until">Until a specific date &amp; time</option>
              </select>
            </div>
            {form.mode === "days" ? (
              <div className="form-row">
                <label>Number of days</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={form.days}
                  onChange={(e) => setForm({ ...form, days: e.target.value })}
                  required
                />
              </div>
            ) : (
              <div className="form-row">
                <label>Expires on</label>
                <input
                  type="datetime-local"
                  value={form.expires_at}
                  onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
                  required
                />
              </div>
            )}
          </div>
          <p className="subtitle" style={{ margin: "4px 0 12px" }}>
            Access ends automatically at the expiry — both the menu item and the underlying data stop being
            reachable. Users, Events, and the Administration settings pages can't be granted this way, since
            temporary access to user management would let someone make the change permanent.
          </p>
          <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? "Granting…" : "Grant access"}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Existing grants</h2>
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : grants.length === 0 ? (
          <div className="empty-state">No page access has been granted yet.</div>
        ) : (
          <table className="sticky-head">
            <thead>
              <tr>
                <th>User</th>
                <th>Page</th>
                <th>Role name</th>
                <th>Expires</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{userLabel(g)}</td>
                  <td>{pageLabel(g.page_key)}</td>
                  <td>{g.role_label || "—"}</td>
                  <td>
                    {formatManilaTime(g.expires_at)}
                    {g.is_active && (
                      <span className="subtitle" style={{ marginLeft: 6 }}>({relativeToNow(g.expires_at)})</span>
                    )}
                  </td>
                  <td>
                    {g.revoked_at ? (
                      <span className="badge badge-cancelled">revoked</span>
                    ) : g.is_active ? (
                      <span className="badge badge-approved">active</span>
                    ) : (
                      <span className="badge badge-inactive">expired</span>
                    )}
                  </td>
                  <td>
                    {g.is_active && (
                      <button className="btn btn-sm btn-secondary" onClick={() => revoke(g.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
