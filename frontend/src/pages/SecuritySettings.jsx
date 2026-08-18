import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

export default function SecuritySettings() {
  const { formatDateTime } = useAppSettings();
  const [minutes, setMinutes] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .get("/security-settings")
      .then((data) => {
        setMinutes(data.idle_timeout_minutes);
        setUpdatedAt(data.updated_at);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await api.put("/security-settings", { idle_timeout_minutes: Number(minutes) });
      setUpdatedAt(data.updated_at);
      setSaved(true);
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
          <h1>Security</h1>
          <p className="subtitle">Auto sign-out after inactivity, for data security</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner">Saved — takes effect for sessions on their next login.</div>}

      <div className="card">
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <form onSubmit={save}>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>
              Last updated: {formatDateTime(updatedAt)} (GMT+8). Everyone — admin, HR, and employees — is
              automatically signed out after this many minutes with no mouse, keyboard, or touch activity, so a
              workstation left signed in and unattended doesn't stay open indefinitely.
            </p>
            <div className="form-row" style={{ maxWidth: 240 }}>
              <label>Idle timeout (minutes)</label>
              <input
                type="number"
                min="1"
                max="480"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                required
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
