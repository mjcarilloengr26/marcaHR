import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

const emptyForm = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  department_id: "",
  position: "",
  manager_id: "",
  hire_date: "",
  base_salary: "",
  address: "",
};

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = () => {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    api.get(`/employees${query}`).then(setEmployees).catch((err) => setError(err.message));
  };

  useEffect(() => {
    api.get("/departments").then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const handleChange = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/employees", {
        ...form,
        department_id: form.department_id || null,
        manager_id: form.manager_id || null,
        base_salary: form.base_salary ? Number(form.base_salary) : 0,
      });
      setShowForm(false);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Employees</h1>
          <p className="subtitle">Manage employee records</p>
        </div>
        <button className="btn" onClick={() => setShowForm(true)}>
          + Add employee
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <input placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Position</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/employees/${e.id}`}>
                    {e.first_name} {e.last_name}
                  </Link>
                </td>
                <td>{e.email}</td>
                <td>{e.department_name || "—"}</td>
                <td>{e.position || "—"}</td>
                <td>
                  <span className={`badge badge-${e.status}`}>{e.status}</span>
                </td>
                <td>
                  <Link to={`/employees/${e.id}`} className="link-btn">
                    View →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {employees.length === 0 && <div className="empty-state">No employees found.</div>}
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>Add employee</h2>
            <div className="grid grid-2">
              <div className="form-row">
                <label>First name</label>
                <input value={form.first_name} onChange={handleChange("first_name")} required />
              </div>
              <div className="form-row">
                <label>Last name</label>
                <input value={form.last_name} onChange={handleChange("last_name")} required />
              </div>
            </div>
            <div className="form-row">
              <label>Email</label>
              <input type="email" value={form.email} onChange={handleChange("email")} required />
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Phone</label>
                <input value={form.phone} onChange={handleChange("phone")} />
              </div>
              <div className="form-row">
                <label>Position</label>
                <input value={form.position} onChange={handleChange("position")} />
              </div>
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Department</label>
                <select value={form.department_id} onChange={handleChange("department_id")}>
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Manager</label>
                <select value={form.manager_id} onChange={handleChange("manager_id")}>
                  <option value="">—</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.first_name} {emp.last_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Hire date</label>
                <input type="date" value={form.hire_date} onChange={handleChange("hire_date")} />
              </div>
              <div className="form-row">
                <label>Base salary</label>
                <input type="number" value={form.base_salary} onChange={handleChange("base_salary")} />
              </div>
            </div>
            <div className="form-row">
              <label>Address</label>
              <input value={form.address} onChange={handleChange("address")} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Saving…" : "Save employee"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
