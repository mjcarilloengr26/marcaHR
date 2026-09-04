const express = require("express");
const db = require("../db");
const { requireAuth, requireRole, requireStrictRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { logRequestEvent } = require("../services/auditLog");
const { notifyAssetReturnFiled, notifyAssetReturnDecision } = require("../notifications");

const router = express.Router();

// The photo is deliberately absent from this list. These are phone photos of
// tools and laptops, and a list of thirty of them would be tens of megabytes
// for a table that only needs to know whether to show a "view photo" link.
// has_photo drives that link; GET /:id/photo serves the bytes on demand.
const SELECT = `
  SELECT r.id, r.asset_id, r.employee_id, r.return_date, r.employee_note,
         r.quantity, r.status, r.asset_condition, r.review_note, r.reviewed_at, r.created_at,
         (r.photo_data IS NOT NULL) AS has_photo, r.photo_name,
         (e.first_name || ' ' || e.last_name) AS employee_name,
         d.name AS department_name,
         (rv.first_name || ' ' || rv.last_name) AS reviewed_by_name,
         a.asset_type, a.brand, a.model, a.serial_number, a.asset_tag,
         a.date_issued, a.status AS asset_status,
         a.quantity AS asset_quantity, a.returned_quantity AS asset_returned_quantity,
         (a.quantity - a.returned_quantity) AS asset_outstanding_quantity
  FROM asset_returns r
  JOIN employees e ON e.id = r.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN employees rv ON rv.id = r.reviewed_by
  JOIN employee_assets a ON a.id = r.asset_id`;

const isHr = (req) => ["admin", "hr"].includes(req.user.role);
const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const CONDITIONS = ["good", "damaged", "incomplete"];

// Same rules as an expense receipt: a base64 data URL, capped well below the
// request limit so one field cannot fill a whole request.
function parsePhoto(body) {
  const data = body?.photo_data;
  if (!data) return { name: null, type: null, data: null };
  if (typeof data !== "string" || !data.startsWith("data:") || data.length > 6_000_000) {
    return { name: null, type: null, data: null };
  }
  return {
    name: typeof body.photo_name === "string" ? body.photo_name.slice(0, 255) : null,
    type: typeof body.photo_type === "string" ? body.photo_type.slice(0, 100) : null,
    data,
  };
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let sql = `${SELECT} WHERE 1=1`;
    const params = [];

    // An employee sees the returns they filed, and nothing else.
    if (!isHr(req)) {
      sql += " AND r.employee_id = ?";
      params.push(req.user.employee_id ?? -1);
    } else if (req.query.employee_id) {
      sql += " AND r.employee_id = ?";
      params.push(req.query.employee_id);
    }
    if (req.query.status) {
      sql += " AND r.status = ?";
      params.push(req.query.status);
    }

    // Pending first: those are the ones waiting on somebody.
    sql += " ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC";
    res.json(await db.prepare(sql).all(...params));
  })
);

// The photo, on demand. Visible to the employee who filed the return and to
// HR/admin — the same people who can see the return itself.
router.get(
  "/:id/photo",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT employee_id, photo_name, photo_type, photo_data FROM asset_returns WHERE id = ?")
      .get(req.params.id);
    if (!row) return res.status(404).json({ error: "Return not found" });
    if (!isHr(req) && row.employee_id !== req.user.employee_id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (!row.photo_data) return res.status(404).json({ error: "No photo attached to that return" });
    res.json({ photo_name: row.photo_name, photo_type: row.photo_type, photo_data: row.photo_data });
  })
);

// File a return. Anyone can file one for an asset issued to them; HR can file
// on someone's behalf, for the case where the item is handed over in person
// and the employee never touches the app.
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { asset_id, return_date, employee_note } = body;
    if (!asset_id) return res.status(400).json({ error: "asset_id is required" });
    if (!return_date) return res.status(400).json({ error: "A return date is required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(return_date)) {
      return res.status(400).json({ error: "return_date must be YYYY-MM-DD" });
    }

    const asset = await db.prepare("SELECT * FROM employee_assets WHERE id = ?").get(asset_id);
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    const outstanding = asset.quantity - asset.returned_quantity;

    // An employee can only hand back what is actually charged to them.
    if (!isHr(req) && asset.employee_id !== req.user.employee_id) {
      return res.status(403).json({ error: "That asset is not issued to you" });
    }
    if (asset.status !== "active") {
      return res.status(400).json({ error: `That asset is already marked ${asset.status}` });
    }
    // A future date would let someone file a return for an item still in their
    // hands and have it accepted before it exists.
    if (return_date > nowStamp().slice(0, 10)) {
      return res.status(400).json({ error: "The return date cannot be in the future" });
    }
    if (return_date < asset.date_issued) {
      return res.status(400).json({ error: `The asset was only issued on ${asset.date_issued}` });
    }

    const open = await db
      .prepare("SELECT id FROM asset_returns WHERE asset_id = ? AND status = 'pending'")
      .get(asset_id);
    if (open) return res.status(409).json({ error: "A return for that asset is already awaiting a decision" });

    // How many are coming back. Defaults to everything still outstanding,
    // which is the whole story for a laptop and the common case for kit.
    const quantity = body.quantity === undefined || body.quantity === null || body.quantity === ""
      ? outstanding
      : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "Return at least one item" });
    }
    if (quantity > outstanding) {
      return res.status(400).json({
        error: `Only ${outstanding} of that asset ${outstanding === 1 ? "is" : "are"} still out — you cannot return ${quantity}`,
      });
    }

    const photo = parsePhoto(body);
    const info = await db
      .prepare(
        `INSERT INTO asset_returns (asset_id, employee_id, return_date, quantity, employee_note, photo_data, photo_name, photo_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        asset_id,
        asset.employee_id,
        return_date,
        quantity,
        employee_note?.trim() || null,
        photo.data,
        photo.name,
        photo.type
      );

    await logRequestEvent(req, "file_asset_return", {
      entityType: "asset_return",
      entityId: info.lastInsertRowid,
      details: { asset_id, employee_id: asset.employee_id, return_date, quantity, has_photo: Boolean(photo.data) },
    });

    const created = await db.prepare(`${SELECT} WHERE r.id = ?`).get(info.lastInsertRowid);
    notifyAssetReturnFiled(created);
    res.status(201).json(created);
  })
);

// Accept or reject. Accepting is what actually returns the asset — nothing
// before this point changes employee_assets.
//
// requireStrictRole, not requireRole: this deliberately ignores Page Access
// grants. A grant keeps the Company Assets page usable while someone is away,
// but accepting a return is a sign-off that an item came back and in what
// condition, and that stays with admin or HR.
router.put(
  "/:id",
  requireAuth,
  requireStrictRole("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { status, asset_condition, review_note } = req.body || {};
    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be accepted or rejected" });
    }

    const existing = await db.prepare("SELECT * FROM asset_returns WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Return not found" });
    if (existing.status !== "pending") {
      return res.status(400).json({ error: `That return was already ${existing.status}` });
    }

    // Accepting is a statement about the item's condition, so it has to say
    // what condition that is. Rejecting does not — the note carries the reason.
    if (status === "accepted" && !CONDITIONS.includes(asset_condition)) {
      return res.status(400).json({ error: `Record the condition: one of ${CONDITIONS.join(", ")}` });
    }
    // Accepting something back as damaged or incomplete without saying what is
    // wrong leaves nothing to act on later.
    if (status === "accepted" && asset_condition !== "good" && !review_note?.trim()) {
      return res.status(400).json({ error: "Say what is wrong with it when accepting as damaged or incomplete" });
    }

    await db
      .prepare(
        `UPDATE asset_returns SET status = ?, asset_condition = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        status === "accepted" ? asset_condition : null,
        review_note?.trim() || null,
        req.user.employee_id || null,
        nowStamp(),
        req.params.id
      );

    if (status === "accepted") {
      // The condition goes onto the asset as well as the return: someone
      // auditing the asset register should not have to find the return row to
      // learn the laptop came back with a cracked screen.
      const note = [asset_condition && `Returned in ${asset_condition} condition`, review_note?.trim()]
        .filter(Boolean)
        .join(" — ");

      const asset = await db.prepare("SELECT quantity, returned_quantity FROM employee_assets WHERE id = ?").get(existing.asset_id);
      const returnedNow = (asset.returned_quantity || 0) + (existing.quantity || 1);
      const closed = returnedNow >= asset.quantity;

      // A partial return deducts from what is still out and leaves the record
      // active; the row only closes once nothing is outstanding. The condition
      // note is appended rather than replaced, because two partial returns of
      // the same kit can come back in different states.
      await db
        .prepare(
          `UPDATE employee_assets
              SET returned_quantity = ?,
                  status = CASE WHEN ? THEN 'returned' ELSE status END,
                  date_returned = CASE WHEN ? THEN ? ELSE date_returned END,
                  condition_note = CASE
                    WHEN ?::text IS NULL THEN condition_note
                    WHEN condition_note IS NULL OR condition_note = '' THEN ?
                    ELSE condition_note || ' · ' || ?
                  END
            WHERE id = ?`
        )
        .run(
          returnedNow,
          closed,
          closed,
          existing.return_date,
          note || null,
          note || null,
          note || null,
          existing.asset_id
        );
    }

    await logRequestEvent(req, "review_asset_return", {
      entityType: "asset_return",
      entityId: Number(req.params.id),
      details: { status, asset_condition: asset_condition || null, asset_id: existing.asset_id },
    });

    const updated = await db.prepare(`${SELECT} WHERE r.id = ?`).get(req.params.id);
    notifyAssetReturnDecision(updated);
    res.json(updated);
  })
);

// Withdraw a return that has not been decided yet. HR can remove any row;
// an employee can only take back their own, and only while it is pending —
// once it is decided it is a record, not a draft.
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM asset_returns WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Return not found" });

    if (!isHr(req)) {
      if (row.employee_id !== req.user.employee_id) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      if (row.status !== "pending") {
        return res.status(400).json({ error: "That return has already been decided" });
      }
    }

    await db.prepare("DELETE FROM asset_returns WHERE id = ?").run(req.params.id);
    await logRequestEvent(req, "delete_asset_return", {
      entityType: "asset_return",
      entityId: Number(req.params.id),
      details: { asset_id: row.asset_id, employee_id: row.employee_id, status: row.status },
    });
    res.status(204).end();
  })
);

module.exports = router;
