import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, getToken, setToken } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);

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
    setToken(null);
    setUser(null);
    setEmployee(null);
  };

  return (
    <AuthContext.Provider value={{ user, employee, loading, login, logout, refresh: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
