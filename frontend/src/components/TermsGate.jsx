import { useState } from "react";
import { useAuth } from "../context/AuthContext";

// Blocking post-login acknowledgment — rendered by ProtectedRoute in place of
// the requested page whenever the signed-in user hasn't accepted the current
// TERMS_VERSION (backend/src/routes/auth.routes.js). No backdrop-click or Esc
// dismissal, since agreement (or logging out) are the only two ways forward.
export default function TermsGate() {
  const { acceptTerms, logout } = useAuth();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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

        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)" }}>
          <p>
            By continuing to use this application, you acknowledge and agree to the following terms governing your
            access to MARCA Group's Human Resources system.
          </p>

          <p style={{ color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>1. Data Privacy</p>
          <p>
            This system collects and processes personal information necessary for employment administration,
            including your name, contact details, employment records, attendance and time logs, GPS location at
            clock-in/out, photographs captured for attendance verification, performance records, and payroll and
            compensation data. This information is collected solely for legitimate HR, payroll, and business
            operations purposes, is accessible only to authorized personnel, and will not be shared with third
            parties except as required by law or company policy. You have the right to request access to,
            correction of, or clarification about your personal data held in this system.
          </p>

          <p style={{ color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>2. Cybersecurity &amp; Acceptable Use</p>
          <p>
            You are responsible for keeping your login credentials confidential and must not share your account
            with anyone else. Any activity performed under your account is presumed to be yours. Attempting to
            access data, records, or accounts you are not authorized to view is strictly prohibited. All access
            and changes made within this system are logged for security and audit purposes. Suspected security
            incidents, unauthorized access, or lost/compromised credentials must be reported to HR or IT
            administration immediately.
          </p>

          <p style={{ color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>3. Acknowledgment</p>
          <p>
            Misuse of this system, including unauthorized data access, sharing of credentials, or circumvention of
            security controls, may result in disciplinary action up to and including termination, and may carry
            legal liability under applicable data privacy law. Use of this application is further subject to MARCA
            Group's Terms and Conditions.
          </p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 14, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ marginTop: 3 }} />
          I have read and understood this notice, and I agree to the Terms and Conditions, Data Privacy, and
          Cybersecurity policy above.
        </label>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={logout}>Decline &amp; sign out</button>
          <button type="button" className="btn" disabled={!checked || submitting} onClick={handleAgree}>
            {submitting ? "Submitting…" : "I Agree & Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
