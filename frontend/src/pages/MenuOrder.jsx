import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { NAV_ITEMS, groupNavItems, applyNavOrder } from "../config/navItems";

// Reordering is scoped to a single section on purpose: a link's section is
// what puts it under the right heading, so dragging one across groups would
// silently re-file it somewhere the heading no longer describes. Drops from
// another section are rejected rather than silently ignored, so it's clear
// why nothing moved.
export default function MenuOrder() {
  const [groups, setGroups] = useState([]);
  // The dragged item lives in a ref, not state: the drop handler must read it
  // synchronously, and a state value would still be the pre-drag one if React
  // hasn't re-rendered between dragstart and drop. `dragKey` state exists only
  // to drive the highlight.
  const dragRef = useRef(null); // { section, to }
  const [dragKey, setDragKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api
      .get("/nav-order")
      .then((rows) => {
        const orderByKey = Object.fromEntries(rows.map((r) => [r.item_key, r.position]));
        setGroups(groupNavItems(applyNavOrder(NAV_ITEMS, orderByKey)).filter((g) => g.section));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const onDragStart = (section, to) => (e) => {
    dragRef.current = { section, to };
    setDragKey(to);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragKey(null);
  };

  const onDrop = (section, targetTo) => (e) => {
    e.preventDefault();
    setNotice("");
    const dragged = dragRef.current;
    if (!dragged) return;
    if (dragged.section !== section) {
      setNotice("Menu items can only be reordered within their own group.");
      endDrag();
      return;
    }
    if (dragged.to === targetTo) {
      endDrag();
      return;
    }
    setGroups((prev) =>
      prev.map((g) => {
        if (g.section !== section) return g;
        const links = [...g.links];
        const from = links.findIndex((l) => l.to === dragged.to);
        const to = links.findIndex((l) => l.to === targetTo);
        if (from === -1 || to === -1) return g;
        const [moved] = links.splice(from, 1);
        links.splice(to, 0, moved);
        return { ...g, links };
      })
    );
    endDrag();
    setSaved(false);
  };

  // Nudge buttons alongside the drag handles — dragging is awkward on touch
  // screens, and this page is reachable from a phone like any other.
  const move = (section, to, delta) => {
    setNotice("");
    setSaved(false);
    setGroups((prev) =>
      prev.map((g) => {
        if (g.section !== section) return g;
        const links = [...g.links];
        const i = links.findIndex((l) => l.to === to);
        const j = i + delta;
        if (i === -1 || j < 0 || j >= links.length) return g;
        [links[i], links[j]] = [links[j], links[i]];
        return { ...g, links };
      })
    );
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      // Positions restart per section, which is all the sidebar needs since it
      // only ever sorts within a section.
      const items = groups.flatMap((g) => g.links.map((l, i) => ({ item_key: l.to, position: i })));
      await api.put("/nav-order", { items });
      setSaved(true);
      window.dispatchEvent(new Event("menu-order-updated"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.put("/nav-order", { items: [] });
      setGroups(groupNavItems(NAV_ITEMS).filter((g) => g.section));
      setSaved(true);
      window.dispatchEvent(new Event("menu-order-updated"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Menu Order</h1>
          <p className="subtitle">Drag items to reorder the sidebar. Applies to everyone.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-secondary" onClick={resetToDefault} disabled={saving || loading}>
            Reset to default
          </button>
          <button className="btn" onClick={save} disabled={saving || loading}>
            {saving ? "Saving…" : "Save order"}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="error-banner">{notice}</div>}
      {saved && <div className="success-banner">Menu order saved — the sidebar has been updated.</div>}

      {loading ? (
        <div className="page-loading">Loading…</div>
      ) : (
        <div className="grid grid-2">
          {groups.map((g) => (
            <div className="card" key={g.section} style={{ marginBottom: 16 }}>
              <h2 style={{ marginTop: 0, fontSize: 15 }}>
                <span style={{ marginRight: 8 }}>{g.sectionItem?.icon}</span>
                {g.section}
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.links.map((l, i) => (
                  <div
                    key={l.to}
                    draggable
                    onDragStart={onDragStart(g.section, l.to)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={onDrop(g.section, l.to)}
                    onDragEnd={endDrag}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: dragKey === l.to ? "var(--hover-bg)" : "var(--surface)",
                      cursor: "grab",
                    }}
                  >
                    <span style={{ color: "var(--text-muted)", cursor: "grab" }} aria-hidden="true">⠿</span>
                    <span>{l.icon}</span>
                    <span style={{ flex: 1 }}>{l.label}</span>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => move(g.section, l.to, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${l.label} up`}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => move(g.section, l.to, 1)}
                      disabled={i === g.links.length - 1}
                      aria-label={`Move ${l.label} down`}
                    >
                      ↓
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
