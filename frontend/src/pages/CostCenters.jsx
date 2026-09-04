import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import DecimalInput from "../components/DecimalInput";

const EMPTY = { name: "", code: "", notes: "" };

export default function CostCenters() {
  const { moneyPrecise: money, moneyWhole } = useAppSettings();
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  // Allocations are edited in place: opening a modal per figure to type one
  // number is more ceremony than the task deserves.
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = (y = year) =>
    api
      .get(`/cost-centers?year=${y}`)
      .then((d) => {
        setData(d);
        setDrafts(Object.fromEntries(d.centers.map((c) => [c.id, String(c.budget || "")])));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    load(year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const openNew = () => {
    setForm(EMPTY);
    setEditingId(null);
    setError("");
    setShowForm(true);
  };

  const openEdit = (c) => {
    setForm({ name: c.name, code: c.code || "", notes: c.notes || "" });
    setEditingId(c.id);
    setError("");
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editingId) await api.put(`/cost-centers/${editingId}`, form);
      else await api.post("/cost-centers", form);
      setShowForm(false);
      setNotice(editingId ? "Cost center updated." : `"${form.name}" added — it is now selectable on expense reports.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveBudget = async (c) => {
    setBusyId(c.id);
    setError("");
    try {
      await api.put(`/cost-centers/${c.id}/budget`, { year, amount: Number(drafts[c.id] || 0) });
      setNotice(`${c.name}: ${money(Number(drafts[c.id] || 0))} allocated for ${year}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (c) => {
    setBusyId(c.id);
    setError("");
    try {
      await api.put(`/cost-centers/${c.id}`, { active: !c.active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (c) => {
    if (!confirm(`Delete "${c.name}"? Only possible while nothing is booked against it.`)) return;
    setBusyId(c.id);
    setError("");
    try {
      await api.del(`/cost-centers/${c.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const years = [];
  for (let y = new Date().getFullYear() + 1; y >= new Date().getFullYear() - 3; y -= 1) years.push(y);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Cost Centers</h1>
          <p className="subtitle">
            The cost centers expenses can be booked to, and what each may spend in a year. Only these
            names appear on the expense form — staff choose from the list rather than typing their own.
          </p>
        </div>
        <button className="btn" onClick={openNew}>+ New cost center</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-inline">
          <div className="form-row">
            <label>Allocation year</label>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          {data && (
            <div className="form-row" style={{ flex: 1 }}>
              <label>&nbsp;</label>
              <div className="subtitle" style={{ margin: 0 }}>
                {moneyWhole(data.totals.budget)} allocated across {data.centers.length} cost center
                {data.centers.length === 1 ? "" : "s"} · {moneyWhole(data.totals.spent)} spent so far in {year}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="page-loading">Loading…</div>
      ) : (
        <>
          <div className="card">
            {data.centers.length === 0 ? (
              <div className="empty-state">
                No cost centers yet. Add one and it becomes selectable on every expense report.
              </div>
            ) : (
              <div className="table-scroll">
                <table className="sticky-head">
                  <thead>
                    <tr>
                      <th className="th-plain">Cost center</th>
                      <th className="th-plain">Code</th>
                      <th className="th-plain">{year} allocation</th>
                      <th className="th-plain">Spent</th>
                      <th className="th-plain">Remaining</th>
                      <th className="th-plain">Used</th>
                      <th className="th-plain">Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.centers.map((c) => (
                      <tr key={c.id} className={c.overBudget ? "row-selected" : undefined}>
                        <td>
                          {c.name}
                          {c.notes && (
                            <div className="subtitle" style={{ fontSize: 12, margin: 0 }}>{c.notes}</div>
                          )}
                        </td>
                        <td>{c.code || "—"}</td>
                        <td style={{ minWidth: 190 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <DecimalInput
                              value={drafts[c.id] ?? ""}
                              onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
                              placeholder="0.00"
                              style={{ width: 120 }}
                            />
                            <button
                              className="btn btn-sm btn-secondary"
                              disabled={busyId === c.id || String(drafts[c.id] ?? "") === String(c.budget || "")}
                              onClick={() => saveBudget(c)}
                            >
                              Set
                            </button>
                          </div>
                        </td>
                        <td className="col-nowrap">{money(c.spent)}</td>
                        <td className="col-nowrap" style={{ color: c.remaining < 0 ? "var(--danger)" : undefined }}>
                          {c.budget > 0 ? money(c.remaining) : "—"}
                        </td>
                        <td className="col-nowrap">
                          {/* Nothing allocated is not the same as nothing used — a
                              cost centre with no budget is unwatched, not healthy. */}
                          {c.usedPercent === null ? (
                            <span className="subtitle">no allocation</span>
                          ) : (
                            <span style={{ color: c.overBudget ? "var(--danger)" : c.usedPercent >= 80 ? "var(--warning)" : undefined }}>
                              {c.usedPercent}%
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`badge badge-${c.active ? "active" : "inactive"}`}>
                            {c.active ? "active" : "retired"}
                          </span>
                        </td>
                        <td>
                          <div className="col-actions">
                            <button className="btn btn-sm btn-secondary" onClick={() => openEdit(c)}>Edit</button>
                            <button className="btn btn-sm btn-secondary" disabled={busyId === c.id} onClick={() => toggleActive(c)}>
                              {c.active ? "Retire" : "Reinstate"}
                            </button>
                            {c.reports === 0 && (
                              <button className="btn btn-sm btn-danger" disabled={busyId === c.id} onClick={() => remove(c)}>
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
            )}
          </div>

          {/* Spend booked to a name that is not on the list — an older report, or
              one filed before a rename. Real money that no budget is watching, so
              it is shown rather than quietly dropped from the totals. */}
          {data.unassigned.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2>Spend not matched to a cost center</h2>
              <p className="subtitle" style={{ marginTop: 0 }}>
                These names appear on {year} reports but are not on the list above, so no allocation is
                watching them. Adding a cost center with the same name adopts the spend.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="th-plain">Name on the report</th>
                      <th className="th-plain">Reports</th>
                      <th className="th-plain">Spent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unassigned.map((u) => (
                      <tr key={u.name}>
                        <td>{u.name}</td>
                        <td>{u.reports}</td>
                        <td className="col-nowrap">{money(u.spent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? "Edit cost center" : "New cost center"}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {editingId
                ? "Spend is matched by name, so renaming this detaches every report still filed under the old one."
                : "It becomes selectable on expense reports as soon as it is saved."}
            </p>
            <form onSubmit={save}>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>Name</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Engineering"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Code (optional)</label>
                  <input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="e.g. CC-100"
                  />
                </div>
              </div>
              <div className="form-row">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add cost center"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
