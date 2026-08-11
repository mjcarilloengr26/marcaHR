import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, getToken, setToken } from "../api/client";
import { useIdleLogout } from "../hooks/useIdleLogout";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(null);

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.get("/auth/me");
      setUser(data.user);
      setEmployee(data.employee);
    } catch (err) {
      setToken(null);
      setUser(null);
      setEmployee(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = async (email, password) => {
    const data = await api.post("/auth/login", { email, password });
    setToken(data.token);
    setUser(data.user);
    setEmployee(data.employee);
    return data;
  };

  const logout = () => {
    // Best-effort — record the event, but never let a failed request block
    // the user from actually logging out.
    api.post("/auth/logout").catch(() => {});
    setToken(null);
    setUser(null);
    setEmployee(null);
  };

  const acceptTerms = async () => {
    await api.post("/auth/accept-terms");
    setUser((u) => ({ ...u, terms_accepted: true }));
  };

  // Every signed-in session needs to know the configured idle-logout window
  // (Administration > Security, admin-only to edit) to run its own timer.
  useEffect(() => {
    if (!user) {
      setIdleTimeoutMinutes(null);
      return;
    }
    api
      .get("/security-settings")
      .then((data) => setIdleTimeoutMinutes(data.idle_timeout_minutes))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useIdleLogout({
    enabled: !!user,
    minutes: idleTimeoutMinutes,
    onIdle: () => {
      logout();
      navigate("/login", { state: { idleLogout: true } });
    },
  });

  return (
    <AuthContext.Provider value={{ user, employee, loading, login, logout, acceptTerms, refresh: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
