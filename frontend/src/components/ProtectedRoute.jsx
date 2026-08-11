import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import TermsGate from "./TermsGate";

export default function ProtectedRoute({ children, roles }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.terms_accepted) return <TermsGate />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;

  return children;
}
