import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";

// The vocabulary every expense is filed under, and every spend chart is
// grouped by.
//
// It used to be a list in the source, which meant a genuinely missing category
// needed a deploy — and before that it was open free text, which meant one
// person's one-off phrase became a permanent slice on the dashboard. This is
// the middle: a fixed list, with somebody responsible for it.
//
// Admin only, because the cost of a careless entry is not local. Add "Fuel
// Expenses" beside "Fuel" and the two charts stop comparing across periods for
// good — the spend is split down two columns with nothing saying they are the
// same thing.
export default function ExpenseCategories() {
  const { moneyPrecise: money } = useAppSettings();
  const [rows, setRows] = useState(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () =>
    api
      .get("/expenses/categories")
      .then(setRows)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const add = async (e) => {
    e.preventDefault();
    const typed = name.trim();
    if (!typed) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post("/expenses/categories", { name: typed });
      setName("");
      setNotice(`"${typed}" can now be picked when filing an expense.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (row, active) => {
    if (
      !active &&
      !confirm(
        `Retire "${row.name}"?\n\n` +
          "It stops being offered on new expense lines. The " +
          `${row.uses} line${row.uses === 1 ? "" : "s"} already filed under it keep it, ` +
          "and it carries on appearing under its own name on the charts."
      )
    ) {
      return;
    }
    setBusyId(row.id);
    setError("");
    setNotice("");
    try {
      await api.put(`/expenses/categories/${row.id}`, { active });
      setNotice(active ? `"${row.name}" is available again.` : `"${row.name}" retired.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete "${row.name}"? Nothing has ever been filed under it, so it goes without trace.`)) return;
    setBusyId(row.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/expenses/categories/${row.id}`);
      setNotice(`"${row.name}" deleted.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const active = (rows || []).filter((r) => r.active);
  const retired = (rows || []).filter((r) => !r.active);

  const table = (list) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Lines filed</th>
            <th>Total spend</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name}
                {r.is_system && (
                  <div className="subtitle" style={{ fontSize: 11, margin: 0 }}>
                    built in — the catch-all, and cannot be removed
                  </div>
                )}
              </td>
              <td className="col-nowrap">{r.uses || "—"}</td>
              <td className="col-nowrap">{r.total > 0 ? money(r.total) : "—"}</td>
              <td>
                <div className="col-actions">
                  {!r.is_system && r.active && (
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busyId === r.id}
                      onClick={() => setActive(r, false)}
                    >
                      Retire
                    </button>
                  )}
                  {!r.is_system && !r.active && (
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busyId === r.id}
                      onClick={() => setActive(r, true)}
                    >
                      Bring back
                    </button>
                  )}
                  {/* Delete only where there is nothing to lose. Anything with
                      spend behind it is retired instead — the server refuses
                      the delete either way, and offering a button that cannot
                      work is worse than not offering it. */}
                  {!r.is_system && r.uses === 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busyId === r.id}
                      onClick={() => remove(r)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Expense Categories</h1>
          <p className="subtitle">What expenses may be filed under, and how the spend charts are grouped</p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <form className="form-inline" onSubmit={add}>
          <div className="form-row" style={{ flex: 1 }}>
            <label>New category</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Permits & Licences"
              maxLength={60}
            />
          </div>
          <button className="btn" disabled={saving || !name.trim()}>
            {saving ? "Adding…" : "Add category"}
          </button>
        </form>
        <p className="subtitle" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Check it is not already here under another wording first. "Fuel Expenses" beside "Fuel" splits the same spend
          down two columns, and no chart can tell they are the same thing.
        </p>
      </div>

      {!rows && <div className="page-loading">Loading…</div>}

      {rows && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>In use — {active.length}</h2>
            <p className="subtitle" style={{ marginTop: -6 }}>Offered when somebody files an expense.</p>
            {table(active)}
          </div>

          {retired.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2 style={{ marginTop: 0 }}>Retired — {retired.length}</h2>
              <p className="subtitle" style={{ marginTop: -6 }}>
                No longer offered on new lines. Everything already filed under these keeps its category, and the charts
                still report them by name rather than folding them into Others.
              </p>
              {table(retired)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
