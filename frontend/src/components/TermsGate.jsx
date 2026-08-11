import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";

// Blocking post-login acknowledgment — rendered by ProtectedRoute in place of
// the requested page whenever the signed-in user hasn't accepted the current
// version of terms_content (edited by admins at Administration > Terms &
// Conditions, backend/src/routes/terms.routes.js). No backdrop-click or Esc
// dismissal, since agreement (or logging out) are the only two ways forward.
export default function TermsGate() {
  const { acceptTerms, logout } = useAuth();
  const [content, setContent] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get("/terms")
      .then((data) => setContent(data.content))
      .catch((err) => setLoadError(err.message));
  }, []);

  const handleAgree = async () => {
    setSubmitting(true);
    setError("");
    try {
      await acceptTerms();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 640 }}>
        <h2>Terms and Conditions</h2>
        <p className="subtitle" style={{ marginTop: -8 }}>
          Data Privacy &amp; Cybersecurity Notice — please read before continuing
        </p>

        {loadError && <div className="error-banner">{loadError}</div>}
        {!content && !loadError && <div className="page-loading">Loading…</div>}
        {content && (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
            {content}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 14, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ marginTop: 3 }} />
          I have read and understood this notice, and I agree to the Terms and Conditions, Data Privacy, and
          Cybersecurity policy above.
        </label>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={logout}>Decline &amp; sign out</button>
          <button type="button" className="btn" disabled={!checked || submitting || !content} onClick={handleAgree}>
            {submitting ? "Submitting…" : "I Agree & Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
