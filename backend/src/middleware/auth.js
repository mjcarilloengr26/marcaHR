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

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
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

module.exports = { signToken, requireAuth, requireRole, requireSelfOrRole, JWT_SECRET };
