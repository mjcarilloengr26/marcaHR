import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function Departments() {
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/departments").then(setDepartments).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/departments", { name, description });
      setName("");
      setDescription("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this department?")) return;
    try {
      await api.del(`/departments/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Departments</h1>
          <p className="subtitle">Organize your company structure</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form className="card form-inline" onSubmit={handleAdd} style={{ marginBottom: 16 }}>
        <div className="form-row">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="form-row" style={{ flex: 1 }}>
          <label>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Adding…" : "+ Add department"}
        </button>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Employees</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.description || "—"}</td>
                <td>{d.employee_count}</td>
                <td>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {departments.length === 0 && <div className="empty-state">No departments yet.</div>}
      </div>
    </div>
  );
}
