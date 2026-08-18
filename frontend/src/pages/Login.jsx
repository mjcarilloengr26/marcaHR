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
      await login(email, password);
      navigate("/");
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
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Signing in…" : t("Sign in")}
        </button>
        {loginNotice && <div className="login-hint">{loginNotice}</div>}
      </form>
    </div>
  );
}
