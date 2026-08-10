const db = require("../db");

// Best-effort audit trail — a logging failure must never break the real
// operation it's recording, so every error is swallowed here (and reported
// to the console for anyone watching server logs), same pattern as the
// fire-and-forget email notifications in notifications.js.
async function logEvent({ userId, userEmail, action, entityType, entityId, details, ip }) {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId || null,
        userEmail || null,
        action,
        entityType || null,
        entityId || null,
        details !== undefined ? JSON.stringify(details) : null,
        ip || null
      );
  } catch (err) {
    console.error("Audit log failed:", err);
  }
}

// Convenience wrapper for the common case: an authenticated request (req.user
// set by requireAuth) recording an action against some entity.
function logRequestEvent(req, action, { entityType, entityId, details } = {}) {
  return logEvent({
    userId: req.user?.id,
    userEmail: req.user?.email,
    action,
    entityType,
    entityId,
    details,
    ip: req.ip,
  });
}

module.exports = { logEvent, logRequestEvent };
