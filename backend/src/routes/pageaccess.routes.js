const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { GRANTABLE_PAGES, isGrantablePageKey } = require("../services/pageAccess");

const router = express.Router();

// Catalog of pages that can be granted — drives the admin page's dropdown so
// it can't drift from what the server will actually honour.
router.get(
  "/pages",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(GRANTABLE_PAGES.map(({ key, label }) => ({ key, label })));
  })
);

router.get(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT g.*, u.email AS user_email, (e.first_name || ' ' || e.last_name) AS employee_name,
                (g.revoked_at IS NULL AND g.expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) AS is_active
         FROM page_access_grants g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ORDER BY g.created_at DESC`
      )
      .all();
    res.json(rows);
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { user_id, page_key, role_label, expires_at, days } = req.body || {};
    if (!user_id || !page_key) {
      return res.status(400).json({ error: "user_id and page_key are required" });
    }
    if (!isGrantablePageKey(page_key)) {
      return res.status(400).json({ error: "That page cannot be granted temporary access" });
    }

    const user = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(user_id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Either an explicit end date/time, or a number of days from now — the
    // two ways the admin page offers to express "until when".
    let expiresAt = null;
    if (expires_at) {
      const d = new Date(expires_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "expires_at is not a valid date/time" });
      if (d.getTime() <= Date.now()) return res.status(400).json({ error: "Expiry must be in the future" });
      expiresAt = d.toISOString().slice(0, 19).replace("T", " ");
    } else {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0 || n > 365) {
        return res.status(400).json({ error: "Provide an expiry date/time, or days between 1 and 365" });
      }
      expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    }

    const info = await db
      .prepare(
        `INSERT INTO page_access_grants (user_id, page_key, role_label, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(user_id, page_key, role_label || null, expiresAt, req.user.id);

    await logRequestEvent(req, "grant_page_access", {
      entityType: "page_access_grant",
      entityId: info.lastInsertRowid,
      details: { user_id, page_key, expires_at: expiresAt, role_label: role_label || null },
    });
    res.status(201).json(await db.prepare("SELECT * FROM page_access_grants WHERE id = ?").get(info.lastInsertRowid));
  })
);

// Revoke early. Kept as a soft revoke (revoked_at) rather than a delete so the
// grant stays visible as a historical record of who had access when.
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const grant = await db.prepare("SELECT * FROM page_access_grants WHERE id = ?").get(req.params.id);
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await db
      .prepare(
        `UPDATE page_access_grants SET revoked_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`
      )
      .run(req.params.id);
    await logRequestEvent(req, "revoke_page_access", {
      entityType: "page_access_grant",
      entityId: Number(req.params.id),
      details: { user_id: grant.user_id, page_key: grant.page_key },
    });
    res.json(await db.prepare("SELECT * FROM page_access_grants WHERE id = ?").get(req.params.id));
  })
);

// Remove the record entirely. This is a different action from revoking, not a
// harder version of it: revoking ends the access and keeps the row as evidence
// of who could reach what and when, which is the whole point of the soft
// revoke above. Deleting throws that evidence away.
//
// So the grant is written to the audit log in full before it goes — user,
// page, the label it was given, when it was granted, when it expired and
// whether it had been revoked. Events keeps the history that this table no
// longer will.
//
// Deleting a still-active grant also ends the access, since the "active grant"
// query stops matching. The page says so before it lets you do it.
router.delete(
  "/:id/permanent",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const grant = await db
      .prepare(
        `SELECT g.*, u.email AS user_email,
                (g.revoked_at IS NULL AND g.expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) AS is_active
         FROM page_access_grants g JOIN users u ON u.id = g.user_id WHERE g.id = ?`
      )
      .get(req.params.id);
    if (!grant) return res.status(404).json({ error: "Grant not found" });

    await logRequestEvent(req, "delete_page_access_grant", {
      entityType: "page_access_grant",
      entityId: Number(req.params.id),
      details: {
        user_id: grant.user_id,
        user_email: grant.user_email,
        page_key: grant.page_key,
        role_label: grant.role_label,
        granted_at: grant.created_at,
        expires_at: grant.expires_at,
        revoked_at: grant.revoked_at,
        was_active_when_deleted: Boolean(grant.is_active),
      },
    });

    await db.prepare("DELETE FROM page_access_grants WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
