import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";

// Telling somebody a line is already claimed while they are typing it, rather
// than a fortnight later when the duplicate check catches it.
//
// The whole set is fetched once when the form opens and matched in the
// browser. An employee has a few dozen claimed lines — a date and an amount
// each — so this is smaller than the round trip it replaces, and the answer
// appears as the amount is typed rather than after it.
//
// Narrow on purpose: same date AND same amount. The looser version — anything
// dated on or before the last date already claimed — was measured against the
// live data first and fired on 15.4% of lines, about one in six. A warning
// that common is one people learn to dismiss without reading, and it would
// have been dismissed on the occasion it mattered. This one fires on 0.3% and
// still catches the mistake it was built for: a new report started from a date
// the previous one already covered.
export function useClaimedLines(employeeId) {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (!employeeId) {
      setLines([]);
      return;
    }
    let alive = true;
    api
      .get(`/expenses/claimed-lines?employee_id=${employeeId}`)
      // A failure costs the warning, never the ability to file an expense.
      .then((rows) => alive && setLines(Array.isArray(rows) ? rows : []))
      .catch(() => alive && setLines([]));
    return () => {
      alive = false;
    };
  }, [employeeId]);

  // Keyed for lookup, so checking a line is a map read rather than a scan of
  // the list on every keystroke.
  const byKey = useMemo(() => {
    const m = new Map();
    for (const l of lines) m.set(`${l.expense_date}|${Number(l.amount).toFixed(2)}`, l);
    return m;
  }, [lines]);

  // Returns the already-claimed line this one matches, or null.
  return (date, amount) => {
    const value = Number(amount);
    if (!date || !Number.isFinite(value) || value <= 0) return null;
    return byKey.get(`${date}|${value.toFixed(2)}`) || null;
  };
}
