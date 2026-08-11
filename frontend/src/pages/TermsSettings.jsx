import { useEffect, useState } from "react";
import { api } from "../api/client";

function formatManilaTime(dbTimestamp) {
  if (!dbTimestamp) return "—";
  const iso = `${dbTimestamp.replace(" ", "T")}${dbTimestamp.endsWith("Z") ? "" : "Z"}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dbTimestamp;
  return d.toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

export default function TermsSettings() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const [loginNotice, setLoginNotice] = useState("");
  const [loginNoticeLoading, setLoginNoticeLoading] = useState(true);
  const [savingLoginNotice, setSavingLoginNotice] = useState(false);
  const [loginNoticeError, setLoginNoticeError] = useState("");
  const [loginNoticeSaved, setLoginNoticeSaved] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .get("/terms")
      .then((data) => {
        setContent(data.content);
        setUpdatedAt(data.updated_at);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadLoginNotice = () => {
    setLoginNoticeLoading(true);
    api
      .get("/terms/login-notice")
      .then((data) => setLoginNotice(data.login_notice))
      .catch((err) => setLoginNoticeError(err.message))
      .finally(() => setLoginNoticeLoading(false));
  };

  useEffect(load, []);
  useEffect(loadLoginNotice, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await api.put("/terms", { content });
      setUpdatedAt(data.updated_at);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveLoginNotice = async (e) => {
    e.preventDefault();
    setSavingLoginNotice(true);
    setLoginNoticeError("");
    setLoginNoticeSaved(false);
    try {
      await api.put("/terms/login-notice", { login_notice: loginNotice });
      setLoginNoticeSaved(true);
    } catch (err) {
      setLoginNoticeError(err.message);
    } finally {
      setSavingLoginNotice(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Terms and Conditions</h1>
          <p className="subtitle">
            Data Privacy &amp; Cybersecurity notice shown to every user right after login, and the sign-in screen's
            terms footer
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Sign-in screen notice</h2>
        {loginNoticeError && <div className="error-banner">{loginNoticeError}</div>}
        {loginNoticeSaved && <div className="success-banner">Saved.</div>}
        {loginNoticeLoading ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <form onSubmit={saveLoginNotice}>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>
              Short line shown under the sign-in button, before anyone has logged in.
            </p>
            <div className="form-row">
              <input
                type="text"
                value={loginNotice}
                onChange={(e) => setLoginNotice(e.target.value)}
                required
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button type="submit" className="btn" disabled={savingLoginNotice}>
                {savingLoginNotice ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Post-login acknowledgment</h2>
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="success-banner">Saved — every user will be asked to re-accept on their next login.</div>}
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <form onSubmit={save}>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>
              Last updated: {formatManilaTime(updatedAt)} (GMT+8). Plain text — leave a blank line between
              paragraphs. Saving mints a new version, so everyone — even users who already agreed — will see this
              notice again and must re-accept before continuing to use the app.
            </p>
            <div className="form-row">
              <textarea
                rows={18}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                style={{ fontFamily: "inherit", fontSize: 13, lineHeight: 1.6, resize: "vertical" }}
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
