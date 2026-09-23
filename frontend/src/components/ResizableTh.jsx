import { useCallback, useEffect, useState } from "react";

// A remembered column width. Per viewer, in localStorage, which is what that
// is for: it is not shared state, it is not worth a round trip, and losing it
// costs one drag. Every access is guarded — a private window, or a browser set
// to block site data, throws on read.
export function useColumnWidth(storageKey, { defaultWidth = 180, min = 90, max = 560 } = {}) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {
      /* no stored preference available */
    }
    return defaultWidth;
  });
  const [settling, setSettling] = useState(false);

  // Written when the drag settles rather than on every pointer move, so one
  // resize is one write instead of a few hundred.
  useEffect(() => {
    if (settling) return;
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* the column simply starts at its default next time */
    }
  }, [settling, width, storageKey]);

  return { width, setWidth, setSettling, defaultWidth, min, max };
}

// A table heading whose column can be dragged wider or narrower.
//
// Some columns hold one thing of a known size and some hold whatever the data
// happens to be — a project's full title, a long address. No single width is
// right for both a screen of short names and one long one, and the people
// reading the table are the ones who know which they are looking at.
//
// Controlled on purpose. A table that scrolls sideways is laid out
// automatically, and there a width on a <th> is only a suggestion the browser
// will overrule to fit the content — which is exactly the column this exists
// to tame. So the page owns the number, hands it here for the grip, and also
// applies it to the cell contents, where it actually binds.
//
// Same mechanics as the Gantt chart's label column, which had this first: the
// pointer is tracked on the document rather than the grip, because at speed a
// cursor outruns a six-pixel target and a drag that dies the moment it slips
// off feels broken.
export default function ResizableTh({ label, column, className = "th-plain", children }) {
  const { width, setWidth, setSettling, defaultWidth, min, max } = column;

  const startResize = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const originX = e.clientX;
      const originW = width;
      setSettling(true);

      const move = (ev) => setWidth(Math.min(max, Math.max(min, originW + (ev.clientX - originX))));
      const stop = () => {
        setSettling(false);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
    },
    [width, min, max, setWidth, setSettling]
  );

  const nudge = (by) => setWidth((w) => Math.min(max, Math.max(min, w + by)));

  return (
    <th className={className} style={{ width, minWidth: width, position: "relative" }}>
      {children ?? label}
      <span
        className="col-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${label} column`}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(defaultWidth)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-16); }
          if (e.key === "ArrowRight") { e.preventDefault(); nudge(16); }
          if (e.key === "Home") { e.preventDefault(); setWidth(defaultWidth); }
        }}
      />
    </th>
  );
}
