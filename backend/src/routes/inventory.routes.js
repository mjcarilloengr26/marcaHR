const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { notifyLowStockAlarm } = require("../notifications");

const router = express.Router();

const SELECT_BASE = `
  SELECT i.*, l.name AS location_name
  FROM inventory_items i
  LEFT JOIN locations l ON l.id = i.location_id
`;

function getAlarmThresholdPercent() {
  const row = db.prepare("SELECT alarm_threshold_percent FROM inventory_settings WHERE id = 1").get();
  return row ? row.alarm_threshold_percent : 20;
}

// Three tiers: "ok" (above reorder level), "low" (at/below reorder level —
// time to reorder), "critical" (at/below the alarm threshold % of reorder
// level — the alarm zone that also triggers an email notification).
function computeStatus(item, thresholdPercent) {
  const alarmQty = item.reorder_level * (thresholdPercent / 100);
  if (item.quantity_on_hand <= alarmQty) return "critical";
  if (item.quantity_on_hand <= item.reorder_level) return "low";
  return "ok";
}

router.get("/settings", requireAuth, requireRole("admin", "hr"), (req, res) => {
  res.json({ alarm_threshold_percent: getAlarmThresholdPercent() });
});

router.put("/settings", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const pct = Number(req.body?.alarm_threshold_percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return res.status(400).json({ error: "alarm_threshold_percent must be a number between 0 and 100" });
  }
  db.prepare("UPDATE inventory_settings SET alarm_threshold_percent = ?, updated_at = datetime('now') WHERE id = 1").run(pct);
  res.json({ alarm_threshold_percent: pct });
});

router.get("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  let sql = `${SELECT_BASE} WHERE 1=1`;
  const params = [];
  if (req.query.category) {
    sql += " AND i.category = ?";
    params.push(req.query.category);
  }
  if (req.query.search) {
    sql += " AND (i.name LIKE ? OR i.sku LIKE ?)";
    const q = `%${req.query.search}%`;
    params.push(q, q);
  }
  sql += " ORDER BY i.name ASC";
  const items = db.prepare(sql).all(...params);
  const thresholdPercent = getAlarmThresholdPercent();
  const withStatus = items.map((i) => ({
    ...i,
    stock_status: computeStatus(i, thresholdPercent),
    total_value: i.quantity_on_hand * i.unit_cost,
  }));
  const filtered = req.query.low_stock === "true" ? withStatus.filter((i) => i.stock_status !== "ok") : withStatus;
  res.json(filtered);
});

router.get("/summary", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const items = db.prepare("SELECT * FROM inventory_items").all();
  const thresholdPercent = getAlarmThresholdPercent();
  const withStatus = items.map((i) => ({ ...i, stock_status: computeStatus(i, thresholdPercent) }));
  const totalItems = items.length;
  const totalValue = items.reduce((sum, i) => sum + i.quantity_on_hand * i.unit_cost, 0);
  const notOk = withStatus.filter((i) => i.stock_status !== "ok");
  const critical = withStatus.filter((i) => i.stock_status === "critical");
  res.json({
    totalItems,
    totalValue,
    alarmThresholdPercent: thresholdPercent,
    lowStockCount: notOk.length,
    criticalCount: critical.length,
    lowStockItems: notOk.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      quantity_on_hand: i.quantity_on_hand,
      reorder_level: i.reorder_level,
      unit: i.unit,
      stock_status: i.stock_status,
    })),
  });
});

router.get("/:id/transactions", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const item = db.prepare("SELECT id FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Inventory item not found" });
  const rows = db
    .prepare(
      `SELECT t.*, (e.first_name || ' ' || e.last_name) AS created_by_name
       FROM inventory_transactions t LEFT JOIN employees e ON e.id = t.created_by
       WHERE t.item_id = ? ORDER BY t.created_at DESC`
    )
    .all(req.params.id);
  res.json(rows);
});

router.post("/", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const { sku, name, category, unit, reorder_level, unit_cost, unit_price, location_id, notes } = req.body || {};
  if (!sku || !name) return res.status(400).json({ error: "sku and name are required" });
  try {
    const info = db
      .prepare(
        `INSERT INTO inventory_items (sku, name, category, unit, reorder_level, unit_cost, unit_price, location_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sku,
        name,
        category || null,
        unit || "pcs",
        reorder_level || 0,
        unit_cost || 0,
        unit_price || 0,
        location_id || null,
        notes || null
      );
    res.status(201).json(db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: "An item with that SKU already exists" });
  }
});

router.put("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Inventory item not found" });
  const { sku, name, category, unit, reorder_level, unit_cost, unit_price, location_id, notes } = req.body || {};
  try {
    db.prepare(
      `UPDATE inventory_items SET sku = ?, name = ?, category = ?, unit = ?, reorder_level = ?,
       unit_cost = ?, unit_price = ?, location_id = ?, notes = ? WHERE id = ?`
    ).run(
      sku ?? existing.sku,
      name ?? existing.name,
      category !== undefined ? category : existing.category,
      unit ?? existing.unit,
      reorder_level !== undefined ? reorder_level : existing.reorder_level,
      unit_cost !== undefined ? unit_cost : existing.unit_cost,
      unit_price !== undefined ? unit_price : existing.unit_price,
      location_id !== undefined ? location_id || null : existing.location_id,
      notes !== undefined ? notes : existing.notes,
      req.params.id
    );
  } catch (err) {
    return res.status(400).json({ error: "An item with that SKU already exists" });
  }
  res.json(db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id));
});

// Emails HR/admin the moment an item's quantity crosses INTO the alarm zone
// (not on every movement while it stays there, and not on the way out).
function notifyIfEnteredCritical(existing, newQuantity, thresholdPercent) {
  const oldStatus = computeStatus(existing, thresholdPercent);
  const newStatus = computeStatus({ ...existing, quantity_on_hand: newQuantity }, thresholdPercent);
  if (newStatus === "critical" && oldStatus !== "critical") {
    notifyLowStockAlarm({ ...existing, quantity_on_hand: newQuantity });
  }
}

function moveStock(req, res, type, sign) {
  const existing = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Inventory item not found" });
  const quantity = Number(req.body?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "quantity must be a positive number" });
  }
  if (type === "out" && quantity > existing.quantity_on_hand) {
    return res.status(400).json({ error: `Only ${existing.quantity_on_hand} ${existing.unit} in stock` });
  }
  const { reason, reference } = req.body || {};
  const newQuantity = existing.quantity_on_hand + sign * quantity;
  db.transaction(() => {
    db.prepare("UPDATE inventory_items SET quantity_on_hand = ? WHERE id = ?").run(newQuantity, req.params.id);
    db.prepare(
      `INSERT INTO inventory_transactions (item_id, type, quantity, reason, reference, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, type, quantity, reason || null, reference || null, req.user.employee_id || null);
  })();
  if (type === "out") notifyIfEnteredCritical(existing, newQuantity, getAlarmThresholdPercent());
  res.json(db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id));
}

router.post("/:id/stock-in", requireAuth, requireRole("admin", "hr"), (req, res) => moveStock(req, res, "in", 1));
router.post("/:id/stock-out", requireAuth, requireRole("admin", "hr"), (req, res) => moveStock(req, res, "out", -1));

// Adjustment sets the absolute quantity (e.g. after a physical stock count),
// logging the signed delta so the transaction history stays a true audit trail.
router.post("/:id/adjust", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Inventory item not found" });
  const newQuantity = Number(req.body?.quantity);
  if (!Number.isFinite(newQuantity) || newQuantity < 0) {
    return res.status(400).json({ error: "quantity must be zero or a positive number" });
  }
  const { reason } = req.body || {};
  const delta = newQuantity - existing.quantity_on_hand;
  db.transaction(() => {
    db.prepare("UPDATE inventory_items SET quantity_on_hand = ? WHERE id = ?").run(newQuantity, req.params.id);
    db.prepare(
      `INSERT INTO inventory_transactions (item_id, type, quantity, reason, reference, created_by)
       VALUES (?, 'adjustment', ?, ?, NULL, ?)`
    ).run(req.params.id, delta, reason || null, req.user.employee_id || null);
  })();
  notifyIfEnteredCritical(existing, newQuantity, getAlarmThresholdPercent());
  res.json(db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(req.params.id));
});

router.delete("/:id", requireAuth, requireRole("admin", "hr"), (req, res) => {
  const existing = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Inventory item not found" });
  db.prepare("DELETE FROM inventory_items WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
