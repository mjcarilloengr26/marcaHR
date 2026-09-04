import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

export default function Login() {
  const { user, login } = useAuth();
  const { t } = useAppSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loginNotice, setLoginNotice] = useState("");
  const [logoData, setLogoData] = useState(null);
  const [companyName, setCompanyName] = useState("MARCA GROUP");

  // Public, unauthenticated endpoints — editable at Administration > Terms &
  // Conditions and Administration > Branding, rather than hardcoded here.
  useEffect(() => {
    api.get("/terms/login-notice").then((data) => setLoginNotice(data.login_notice)).catch(() => {});
    api
      .get("/branding")
      .then((data) => {
        setLogoData(data.logo_data);
        if (data.company_name) setCompanyName(data.company_name);
      })
      .catch(() => {});
  }, []);

  // Deliberately no redirect-when-already-signed-in here. Bouncing straight to
  // the dashboard is what made opening the sign-in page look like an automatic
  // login, and it also left no way to sign in as somebody else without hunting
  // for the logout button first. Reaching this page means you intend to sign
  // in, so it always shows the form.

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await login(email, password);
      // Admins land on the Snapshot: it is the page they open the app to read,
      // and sending them to the welcome screen first is a click they always
      // undo. Everyone else keeps the Overview — Snapshot is admin/HR only and
      // an employee has no business figures on it to see.
      //
      // Branching on the returned user rather than the context: setUser has
      // been called but this render still closes over the previous value, so
      // reading `user` here would send the first sign-in to the wrong page.
      navigate(data?.user?.role === "admin" ? "/snapshot" : "/");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        {logoData ? (
          <img src={logoData} alt={companyName} className="brand-mark login-brand-mark brand-mark-img" />
        ) : (
          <div className="brand-mark login-brand-mark">{companyName.trim().charAt(0).toUpperCase() || "M"}</div>
        )}
        <h1>{companyName}</h1>
        <p className="subtitle">{t("Sign in to continue")}</p>
        {location.state?.idleLogout && (
          <div className="error-banner">You were signed out due to inactivity. Please sign in again.</div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <div className="form-row">
          <label>{t("Email")}</label>
          <input
            type="email"
            placeholder="admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="form-row">
          <label>{t("Password")}</label>
          {/* The toggle sits inside the field rather than beside it, so the
              input keeps the full width the email field has and the two rows
              stay aligned. Padding on the input reserves the space so a long
              password never runs under the button. */}
          <div className="input-with-action">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className="input-action"
              onClick={() => setShowPassword((v) => !v)}
              // Announced to a screen reader, and shown on hover for everyone
              // else — an eye glyph alone does not say which state it means.
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              title={showPassword ? "Hide password" : "Show password"}
              // Swallowing mousedown is what actually keeps the caret in the
              // field — without it the click blurs the input and typing
              // resumes nowhere. tabIndex keeps it out of the tab order too,
              // so Tab still goes password -> Sign in.
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
        </div>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Signing in…" : t("Sign in")}
        </button>
        {loginNotice && <div className="login-hint">{loginNotice}</div>}
      </form>
    </div>
  );
}
