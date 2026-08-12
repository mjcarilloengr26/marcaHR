import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

export default function LocalizationSettings() {
  const { money, t } = useAppSettings();
  const [options, setOptions] = useState({ currencies: [], languages: [] });
  const [form, setForm] = useState({ currency_code: "", language: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get("/app-settings").then((d) => setForm({ currency_code: d.currency_code, language: d.language })),
      api.get("/app-settings/options").then(setOptions),
    ])
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.put("/app-settings", form);
      setSaved(true);
      // Tells AppSettingsProvider to re-read, so every amount and label on
      // screen switches over without a reload.
      window.dispatchEvent(new Event("app-settings-updated"));
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
          <h1>{t("Localization")}</h1>
          <p className="subtitle">Currency and language used throughout the app, for everyone</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner">Saved — the new currency and language are now in use.</div>}

      {loading ? (
        <div className="page-loading">Loading…</div>
      ) : (
        <div className="card">
          <form onSubmit={save}>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Currency</label>
                <select
                  value={form.currency_code}
                  onChange={(e) => setForm({ ...form, currency_code: e.target.value })}
                >
                  {options.currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.symbol} — {c.label} ({c.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Language</label>
                <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                  {options.languages.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <p className="subtitle" style={{ margin: "4px 0 12px" }}>
              This is the currency the whole database operates in — normally chosen once during setup. Every amount
              is entered, stored, and shown in it. Amounts are formatted using the currency and language together,
              so the symbol and the digit grouping both follow local convention.
            </p>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Changing it later re-labels the figures already recorded rather than converting them, so only switch
              on an established database if the stored amounts genuinely are in the new currency.
            </p>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Translations currently cover the navigation, sign-in screen, and common buttons and headings.
              Anything not yet translated stays in English rather than showing a placeholder.
            </p>

            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Saving…" : t("Save changes")}
              </button>
            </div>
          </form>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Preview</h2>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>How amounts look with the currently saved setting:</p>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 15 }}>
              <span>{money(1250)}</span>
              <span>{money(48360)}</span>
              <span>{money(756700)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
