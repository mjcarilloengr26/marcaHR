import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
import { api } from "../api/client";

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const routerLocation = useLocation();
  const [employee, setEmployee] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(Boolean(routerLocation.state?.edit));
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get(`/employees/${id}`).then((e) => {
      setEmployee(e);
      setForm(e);
    }).catch((err) => setError(err.message));
  };

  useEffect(() => {
    load();
    setEditing(Boolean(routerLocation.state?.edit));
    api.get("/departments").then(setDepartments).catch(() => {});
    api.get("/locations").then(setLocations).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleChange = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const updated = await api.put(`/employees/${id}`, {
        ...form,
        department_id: form.department_id || null,
        location_id: form.location_id || null,
        base_salary: form.base_salary ? Number(form.base_salary) : 0,
      });
      setEmployee(updated);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${employee.first_name} ${employee.last_name}? This cannot be undone.`)) return;
    try {
      await api.del(`/employees/${id}`);
      navigate("/employees");
    } catch (err) {
      setError(err.message);
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!employee) return <div className="page-loading">Loading…</div>;

  return (
    <div>
      <Link to="/employees" className="link-btn">
        ← Back to employees
      </Link>
      <div className="page-header" style={{ marginTop: 12 }}>
        <div>
          <h1>{employee.first_name} {employee.last_name}</h1>
          <p className="subtitle">{employee.position || "—"} · {employee.department_name || "No department"}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!editing && (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {!editing ? (
        <div className="card">
          <div className="grid grid-2">
            <div><strong>Email</strong><div>{employee.email}</div></div>
            <div><strong>Phone</strong><div>{employee.phone || "—"}</div></div>
            <div><strong>Department</strong><div>{employee.department_name || "—"}</div></div>
            <div><strong>Location (GPS attendance)</strong><div>{employee.location_name || "—"}</div></div>
            <div><strong>Manager</strong><div>{employee.manager_name || "—"}</div></div>
            <div><strong>Hire date</strong><div>{employee.hire_date || "—"}</div></div>
            <div><strong>Status</strong><div><span className={`badge badge-${employee.status}`}>{employee.status}</span></div></div>
            <div><strong>Base salary</strong><div>₱{Number(employee.base_salary || 0).toLocaleString()}</div></div>
            <div><strong>Address</strong><div>{employee.address || "—"}</div></div>
          </div>
        </div>
      ) : (
        <form className="card" onSubmit={handleSave}>
          <div className="grid grid-2">
            <div className="form-row">
              <label>First name</label>
              <input value={form.first_name} onChange={handleChange("first_name")} required />
            </div>
            <div className="form-row">
              <label>Last name</label>
              <input value={form.last_name} onChange={handleChange("last_name")} required />
            </div>
            <div className="form-row">
              <label>Email</label>
              <input type="email" value={form.email} onChange={handleChange("email")} required />
            </div>
            <div className="form-row">
              <label>Phone</label>
              <input value={form.phone || ""} onChange={handleChange("phone")} />
            </div>
            <div className="form-row">
              <label>Position</label>
              <input value={form.position || ""} onChange={handleChange("position")} />
            </div>
            <div className="form-row">
              <label>Department</label>
              <select value={form.department_id || ""} onChange={handleChange("department_id")}>
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Location (for GPS attendance)</label>
              <select value={form.location_id || ""} onChange={handleChange("location_id")}>
                <option value="">—</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Status</label>
              <select value={form.status} onChange={handleChange("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
            <div className="form-row">
              <label>Base salary</label>
              <input type="number" value={form.base_salary || ""} onChange={handleChange("base_salary")} />
            </div>
          </div>
          <div className="form-row">
            <label>Address</label>
            <input value={form.address || ""} onChange={handleChange("address")} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setEditing(false); setForm(employee); }}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
