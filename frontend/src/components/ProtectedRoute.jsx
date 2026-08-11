import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import TermsGate from "./TermsGate";

// A temporary page-access grant (Administration > Page Access) lets a user
// through a route their role wouldn't normally allow, for as long as the
// grant is unexpired. `page_grants` only ever contains still-active grants —
// the server recomputes it on every /auth/me — so an expired one simply stops
// appearing and the role check takes over again. The API enforces the same
// rule independently, so this is convenience, not the security boundary.
export default function ProtectedRoute({ children, roles, pageKey }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.terms_accepted) return <TermsGate />;

  const hasGrant = !!pageKey && (user.page_grants || []).includes(pageKey);
  if (roles && !roles.includes(user.role) && !hasGrant) return <Navigate to="/" replace />;

  return children;
}
