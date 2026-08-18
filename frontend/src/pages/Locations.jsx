import { useEffect, useState } from "react";
import { api } from "../api/client";

const emptyForm = { name: "", lat: "", lng: "", radius_meters: "1000", address: "" };

export default function Locations() {
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = () => api.get("/locations").then(setLocations).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError("Geolocation isn't available in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }));
        setLocating(false);
      },
      () => {
        setError("Couldn't get your current location. Enter coordinates manually.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        lat: Number(form.lat),
        lng: Number(form.lng),
        radius_meters: Number(form.radius_meters) || 1000,
      };
      if (editingId) {
        await api.put(`/locations/${editingId}`, payload);
        setEditingId(null);
      } else {
        await api.post("/locations", payload);
      }
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (location) => {
    setEditingId(location.id);
    setForm({
      name: location.name,
      lat: location.lat,
      lng: location.lng,
      radius_meters: location.radius_meters,
      address: location.address || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this location? Employees assigned to it will become unassigned.")) return;
    try {
      await api.del(`/locations/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Locations</h1>
          <p className="subtitle">Office sites for GPS attendance geofencing — assign employees to one on their profile</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
        {editingId && (
          <div className="form-row" style={{ marginBottom: 4 }}>
            <strong>Editing: {form.name}</strong>
          </div>
        )}
        <div className="form-inline">
          <div className="form-row">
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Manila HQ" />
          </div>
          <div className="form-row">
            <label>Latitude</label>
            <input type="number" step="0.000001" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} required />
          </div>
          <div className="form-row">
            <label>Longitude</label>
            <input type="number" step="0.000001" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} required />
          </div>
          <div className="form-row">
            <label>Radius (meters)</label>
            <input type="number" value={form.radius_meters} onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} />
          </div>
          <button type="button" className="btn btn-secondary" onClick={useCurrentLocation} disabled={locating}>
            {locating ? "Locating…" : "📍 Use my location"}
          </button>
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <label>Address (optional)</label>
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? "Saving…" : editingId ? "Save changes" : "+ Add location"}
          </button>
          {editingId && (
            <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              <th>Name</th>
              <th>Coordinates</th>
              <th>Radius</th>
              <th>Address</th>
              <th>Employees</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {locations.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>
                  <a
                    className="location-link"
                    href={`https://www.google.com/maps?q=${l.lat},${l.lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {l.lat.toFixed(5)}, {l.lng.toFixed(5)}
                  </a>
                </td>
                <td>{l.radius_meters >= 1000 ? `${(l.radius_meters / 1000).toFixed(1)} km` : `${l.radius_meters} m`}</td>
                <td>{l.address || "—"}</td>
                <td>{l.employee_count}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => openEdit(l)}>
                    Edit
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(l.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {locations.length === 0 && <div className="empty-state">No locations yet — add one above, then assign employees to it from their profile.</div>}
      </div>
    </div>
  );
}
