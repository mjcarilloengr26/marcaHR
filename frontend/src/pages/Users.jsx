import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function Users() {
  const [users, setUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", role: "employee", employee_id: "" });

  const load = () => api.get("/users").then(setUsers).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    api.get("/employees").then(setEmployees).catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/users", { ...form, employee_id: form.employee_id || null });
      setShowForm(false);
      setForm({ email: "", password: "", role: "employee", employee_id: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this user login?")) return;
    try {
      await api.del(`/users/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p className="subtitle">Manage login accounts and roles</p>
        </div>
        <button className="btn" onClick={() => setShowForm(true)}>+ Add user</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Linked employee</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td><span className="badge badge-draft">{u.role}</span></td>
                <td>{u.employee_name || "—"}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(u.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <div className="empty-state">No users yet.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>Add user</h2>
            <div className="form-row">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="form-row">
              <label>Password</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </div>
            <div className="form-row">
              <label>Role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="employee">Employee</option>
                <option value="hr">HR</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="form-row">
              <label>Linked employee</label>
              <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
                <option value="">— None —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Create user"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
