import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loginNotice, setLoginNotice] = useState("");
  const [logoData, setLogoData] = useState(null);

  // Public, unauthenticated endpoints — editable at Administration > Terms &
  // Conditions and Administration > Branding, rather than hardcoded here.
  useEffect(() => {
    api.get("/terms/login-notice").then((data) => setLoginNotice(data.login_notice)).catch(() => {});
    api.get("/branding").then((data) => setLogoData(data.logo_data)).catch(() => {});
  }, []);

  if (user) return <Navigate to="/" replace />;

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
          <img src={logoData} alt="MARCA GROUP" className="brand-mark login-brand-mark brand-mark-img" />
        ) : (
          <div className="brand-mark login-brand-mark">M</div>
        )}
        <h1>MARCA GROUP</h1>
        <p className="subtitle">Sign in to continue</p>
        {location.state?.idleLogout && (
          <div className="error-banner">You were signed out due to inactivity. Please sign in again.</div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <div className="form-row">
          <label>Email</label>
          <input
            type="email"
            placeholder="admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="form-row">
          <label>Password</label>
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
        {loginNotice && <div className="login-hint">{loginNotice}</div>}
      </form>
    </div>
  );
}
