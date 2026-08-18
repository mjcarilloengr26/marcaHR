import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { compressLogoFile } from "../utils/image";

export default function BrandingSettings() {
  const [logoData, setLogoData] = useState(null);
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef(null);

  const load = () => {
    setLoading(true);
    api
      .get("/branding")
      .then((data) => {
        setLogoData(data.logo_data);
        setCompanyName(data.company_name || "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = async (newLogoData) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await api.put("/branding", { logo_data: newLogoData, company_name: companyName });
      setLogoData(data.logo_data);
      setSaved(true);
      // Tell the sidebar header (Layout.jsx) to re-fetch so it swaps to the
      // new logo right away rather than after the next full page load.
      window.dispatchEvent(new Event("branding-updated"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const compressed = await compressLogoFile(file);
      await save(compressed);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Branding</h1>
          <p className="subtitle">Company name and logo, shown on the sign-in screen, the sidebar, emails and exported reports</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner">Saved.</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Company name</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          Used wherever the application names the company — the sign-in screen, the sidebar, notification emails and
          the author field of every exported spreadsheet.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="MARCA GROUP"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            type="button"
            className="btn"
            disabled={savingName || !companyName.trim()}
            onClick={async () => {
              setSavingName(true);
              setError("");
              setSaved(false);
              try {
                // Sends the logo unchanged alongside it — the endpoint takes
                // both together, and omitting the logo would clear it.
                const data = await api.put("/branding", { logo_data: logoData, company_name: companyName.trim() });
                setCompanyName(data.company_name || "");
                setSaved(true);
                window.dispatchEvent(new Event("branding-updated"));
              } catch (err) {
                setError(err.message);
              } finally {
                setSavingName(false);
              }
            }}
          >
            {savingName ? "Saving…" : "Save name"}
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              PNG or JPG recommended, square, at least 120×120px. Falls back to the default "M" mark when no logo is set.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  background: "var(--surface-alt, var(--surface))",
                  flexShrink: 0,
                }}
              >
                {logoData ? (
                  <img src={logoData} alt="Current logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                ) : (
                  <span className="brand-mark" style={{ width: 44, height: 44, fontSize: 20 }}>M</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" className="btn" disabled={saving} onClick={() => fileInputRef.current?.click()}>
                  {saving ? "Uploading…" : "Upload logo"}
                </button>
                {logoData && (
                  <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => save(null)}>
                    Remove logo
                  </button>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: "none" }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
