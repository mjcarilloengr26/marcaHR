const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, employee_id: user.employee_id },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authentication token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Role check, plus a fallback to temporary page-access grants
// (Administration > Page Access): a user whose role wouldn't normally reach
// this route is still allowed while they hold an unexpired grant covering the
// route's mount point. Checked here rather than only in the UI so an expired
// grant actually blocks the API, not just the nav link.
//
// Required lazily: this module is loaded by db.js's dependents, and
// pageAccess.js requires db.js — deferring avoids a circular import at boot.
function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (roles.includes(req.user.role)) return next();
    try {
      const { hasActiveGrantForApiPrefix } = require("../services/pageAccess");
      if (await hasActiveGrantForApiPrefix(req.user.id, req.baseUrl)) return next();
    } catch (err) {
      return next(err);
    }
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}

// Role check with no page-access fallback: the named roles, and nobody else,
// however the grants are configured.
//
// For decisions that are not "can this person use this screen" but "whose
// judgement is this" — accepting a returned asset is the case it was written
// for. A temporary grant is meant to keep a page working while someone is
// away; it should not hand over a sign-off that an item came back and what
// condition it was in.
function requireStrictRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Only admin or HR can do that" });
  };
}

// Allows HR/admin to act on anyone; employees only on their own employee_id.
function requireSelfOrRole(getEmployeeId, ...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (roles.includes(req.user.role)) return next();
    const targetId = Number(getEmployeeId(req));
    if (req.user.employee_id && req.user.employee_id === targetId) return next();
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}

module.exports = { signToken, requireAuth, requireRole, requireStrictRole, requireSelfOrRole, JWT_SECRET };
