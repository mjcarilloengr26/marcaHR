import { useMemo, useState } from "react";

// Shared sortable-table behavior: click a column header to sort by it
// ascending, click again to flip to descending, click a different column to
// switch to it (starting ascending). Handles numbers, dates/strings (via
// localeCompare with numeric:true so "2" < "10"), and null/undefined (sorted
// to the end regardless of direction, rather than jumping around).
export function useSort(items, initialKey = null, initialDir = "desc") {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState(initialDir);

  const sorted = useMemo(() => {
    if (!sortKey) return items;
    const copy = [...items];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aMissing = av === null || av === undefined || av === "";
      const bMissing = bv === null || bv === undefined || bv === "";
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;

      let cmp;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [items, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const arrow = (key) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // Sets column and direction outright, for a dropdown or button that has to
  // land on a specific order. toggleSort can't express that — it always starts
  // a new column ascending and only flips on a repeat click.
  const setSort = (key, dir = "asc") => {
    setSortKey(key);
    setSortDir(dir);
  };

  return { sorted, sortKey, sortDir, toggleSort, setSort, arrow };
}
