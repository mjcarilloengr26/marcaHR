import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAppSettings } from "../context/AppSettingsContext";
import { useAuth } from "../context/AuthContext";
import { useSort } from "../hooks/useSort";
import SortTh from "../components/SortTh";
import DecimalInput from "../components/DecimalInput";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodLabel(record) {
  const base = `${MONTH_NAMES[record.period_month]} ${record.period_year}`;
  if (record.period_half === 1) return `${base} (1st half)`;
  if (record.period_half === 2) return `${base} (2nd half)`;
  return base;
}

export default function Payroll() {
  const { money } = useAppSettings();
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [half, setHalf] = useState(now.getDate() <= 15 ? 1 : 2);
  const [editingRecord, setEditingRecord] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const isMonthly = settings?.pay_frequency === "monthly";

  const load = () => api.get("/payroll").then(setRecords).catch((err) => setError(err.message));

  useEffect(() => {
    load();
    if (isHr) api.get("/payroll/settings").then(setSettings).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async () => {
    if (
      !confirm(
        `Generate payroll for ${MONTH_NAMES[month]} ${year}${isMonthly ? "" : half === 1 || half === "1" ? " (1st half)" : " (2nd half)"}?\n\n` +
          "Staff paid each cut-off get this half; staff on a monthly schedule get the whole month.\n\n" +
          "Draft records are recalculated from the current salaries, attendance and payroll settings, and any draft " +
          "left over from a different schedule is removed. Finalized and paid records are left untouched."
      )
    ) {
      return;
    }
    setGenerating(true);
    setError("");
    try {
      await api.post("/payroll/generate", { period_month: Number(month), period_year: Number(year), period_half: Number(half) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // Only rows that can actually move are offered: a paid record is settled,
  // and finalizing something already finalized is a no-op the user should not
  // be invited to perform.
  const selectable = (r) => r.status !== "paid";

  const bulkStatus = async (status) => {
    const chosen = sorted.filter((r) => selectedIds.includes(r.id));
    const eligible = chosen.filter((r) => (status === "finalized" ? r.status === "draft" : r.status !== "paid"));
    if (eligible.length === 0) {
      setError(`None of the selected records can be marked ${status}.`);
      return;
    }
    const total = eligible.reduce((sum, r) => sum + Number(r.net_pay || 0), 0);
    const verb = status === "finalized" ? "Finalize" : "Mark as paid";
    if (
      !confirm(
        `${verb} ${eligible.length} payroll record${eligible.length > 1 ? "s" : ""}?\n\n` +
          `Total net pay: ${money(total)}\n\n` +
          (status === "paid"
            ? "Records marked paid can no longer be edited or changed in bulk."
            : "Finalized records can no longer be edited or recalculated by Generate.")
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setError("");
    try {
      const res = await api.post("/payroll/bulk-status", { ids: eligible.map((r) => r.id), status });
      setSelectedIds([]);
      load();
      if (res?.already_paid > 0) setError(`${res.updated} updated. ${res.already_paid} were already paid and left alone.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const setStatus = async (id, status) => {
    try {
      await api.put(`/payroll/${id}/status`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const openEdit = (record) => {
    setEditingRecord(record);
    setEditForm({
      base_salary: record.base_salary,
      bonuses: record.bonuses,
      overtime_pay: record.overtime_pay,
      night_differential_pay: record.night_differential_pay || 0,
      deduction_sss: record.deduction_sss || 0,
      deduction_hdmf: record.deduction_hdmf || 0,
      deduction_philhealth: record.deduction_philhealth || 0,
      deduction_taxes: record.deduction_taxes || 0,
      deduction_loans: record.deduction_loans || 0,
      deduction_cash_advances: record.deduction_cash_advances || 0,
      net_pay_override: "",
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/payroll", {
        employee_id: editingRecord.employee_id,
        period_month: editingRecord.period_month,
        period_year: editingRecord.period_year,
        period_half: editingRecord.period_half,
        bonuses: Number(editForm.bonuses) || 0,
        overtime_pay: Number(editForm.overtime_pay) || 0,
        night_differential_pay: Number(editForm.night_differential_pay) || 0,
        deduction_sss: Number(editForm.deduction_sss) || 0,
        deduction_hdmf: Number(editForm.deduction_hdmf) || 0,
        deduction_philhealth: Number(editForm.deduction_philhealth) || 0,
        deduction_taxes: Number(editForm.deduction_taxes) || 0,
        deduction_loans: Number(editForm.deduction_loans) || 0,
        deduction_cash_advances: Number(editForm.deduction_cash_advances) || 0,
        net_pay: editForm.net_pay_override !== "" ? Number(editForm.net_pay_override) : undefined,
      });
      setEditingRecord(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openEditSettings = () => {
    setSettingsForm({
      standard_hours_per_day: settings.standard_hours_per_day,
      overtime_multiplier: settings.overtime_multiplier,
      regular_start_time: settings.regular_start_time,
      regular_end_time: settings.regular_end_time,
      overtime_start_time: settings.overtime_start_time,
      overtime_end_time: settings.overtime_end_time,
      night_shift_multiplier: settings.night_shift_multiplier,
      pay_frequency: settings.pay_frequency || "semi_monthly",
      attendance_basis: settings.attendance_basis || "fixed",
    });
    setEditingSettings(true);
  };

  const saveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const updated = await api.put("/payroll/settings", {
        standard_hours_per_day: Number(settingsForm.standard_hours_per_day) || 8,
        overtime_multiplier: Number(settingsForm.overtime_multiplier) || 1,
        regular_start_time: settingsForm.regular_start_time,
        regular_end_time: settingsForm.regular_end_time,
        overtime_start_time: settingsForm.overtime_start_time,
        overtime_end_time: settingsForm.overtime_end_time,
        night_shift_multiplier: Number(settingsForm.night_shift_multiplier) || 1,
        pay_frequency: settingsForm.pay_frequency,
        attendance_basis: settingsForm.attendance_basis,
      });
      setSettings(updated);
      setEditingSettings(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const recordsWithSortKey = records.map((r) => ({
    ...r,
    period_sort: r.period_year * 10000 + r.period_month * 100 + r.period_half,
    period_label: periodLabel(r),
  }));
  const filteredRecords = recordsWithSortKey.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.employee_name, r.period_label, r.status].some((v) => (v || "").toLowerCase().includes(q));
  });
  const { sorted, toggleSort, arrow } = useSort(filteredRecords, "period_sort", "desc");

  // Rows a bulk action could actually move. Select-all works off this rather
  // than every row, so ticking the header never claims to have selected
  // records that are already paid and will be skipped anyway.
  const selectableRows = sorted.filter(selectable);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Payroll</h1>
          <p className="subtitle">{isHr ? "Manage payroll runs" : "View your payslips"}</p>
        </div>
        {isHr && settings && (
          <button className="btn btn-secondary" onClick={openEditSettings}>
            {settings.pay_frequency === "monthly" ? "Monthly" : "Semi-monthly"} · {settings.standard_hours_per_day}h/day ({settings.regular_start_time}–{settings.regular_end_time}) · OT ×{settings.overtime_multiplier} · Night ×{settings.night_shift_multiplier}
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {isHr && (
        <div className="card form-inline" style={{ marginBottom: 16 }}>
          <div className="form-row">
            <label>Month</label>
            <input type="number" min="1" max="12" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          {/* A monthly run covers the whole month, so there is no half to pick.
              The backend ignores period_half in that case regardless. */}
          {!isMonthly && (
            <div className="form-row">
              <label>Cut-off</label>
              <select value={half} onChange={(e) => setHalf(e.target.value)}>
                <option value={1}>1st half (1–15)</option>
                <option value={2}>2nd half (16–end)</option>
              </select>
              <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Applies to staff paid each cut-off. Anyone on a monthly schedule is generated
                for the whole month whichever you pick.
              </p>
            </div>
          )}
          <button className="btn" onClick={generate} disabled={generating}>
            {generating ? "Generating…" : "Generate payroll for period"}
          </button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by employee, period, status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isHr && selectedIds.length > 0 && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <strong>{selectedIds.length} selected</strong>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSelectedIds([])}>
            Clear selection
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" disabled={bulkBusy} onClick={() => bulkStatus("finalized")}>
            {bulkBusy ? "Working…" : "Finalize selected"}
          </button>
          <button type="button" className="btn btn-sm btn-secondary" disabled={bulkBusy} onClick={() => bulkStatus("paid")}>
            {bulkBusy ? "Working…" : "Mark selected as paid"}
          </button>
        </div>
      )}

      <div className="card">
        <table className="sticky-head">
          <thead>
            <tr>
              {isHr && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all records shown"
                    // Ticks only what is listed, so it respects the search
                    // filter rather than quietly selecting rows off screen.
                    checked={selectableRows.length > 0 && selectableRows.every((r) => selectedIds.includes(r.id))}
                    ref={(el) => {
                      if (el) {
                        const n = selectableRows.filter((r) => selectedIds.includes(r.id)).length;
                        el.indeterminate = n > 0 && n < selectableRows.length;
                      }
                    }}
                    onChange={(e) => setSelectedIds(e.target.checked ? selectableRows.map((r) => r.id) : [])}
                  />
                </th>
              )}
              {isHr && <SortTh label="Employee" sortKey="employee_name" toggleSort={toggleSort} arrow={arrow} />}
              <SortTh label="Period" sortKey="period_sort" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Base" sortKey="base_salary" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Bonuses" sortKey="bonuses" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Overtime" sortKey="overtime_pay" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Night diff" sortKey="night_differential_pay" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Deductions" sortKey="deductions" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Net pay" sortKey="net_pay" toggleSort={toggleSort} arrow={arrow} />
              <SortTh label="Status" sortKey="status" toggleSort={toggleSort} arrow={arrow} />
              {isHr && <th></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className={selectedIds.includes(r.id) ? "row-selected" : undefined}>
                {isHr && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.employee_name}`}
                      disabled={!selectable(r)}
                      title={selectable(r) ? undefined : "Already paid"}
                      checked={selectedIds.includes(r.id)}
                      onChange={(e) =>
                        setSelectedIds((prev) => (e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)))
                      }
                    />
                  </td>
                )}
                {isHr && <td>{r.employee_name}</td>}
                <td>{periodLabel(r)}</td>
                <td>{money(r.base_salary)}</td>
                <td>{money(r.bonuses)}</td>
                <td>{money(r.overtime_pay)}</td>
                <td>{money(r.night_differential_pay)}</td>
                <td>{money(r.deductions)}</td>
                <td><strong>{money(r.net_pay)}</strong></td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                {isHr && (
                  <td style={{ display: "flex", gap: 6 }}>
                    {r.status === "draft" && (
                      <>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(r)}>Edit</button>
                        <button className="btn btn-sm" onClick={() => setStatus(r.id, "finalized")}>Finalize</button>
                      </>
                    )}
                    {r.status === "finalized" && (
                      <button className="btn btn-sm" onClick={() => setStatus(r.id, "paid")}>Mark paid</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state">No payroll records yet.</div>}
        {records.length > 0 && sorted.length === 0 && <div className="empty-state">No payroll records match your search.</div>}
      </div>

      {editingRecord && (
        <div className="modal-backdrop" onClick={() => setEditingRecord(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveEdit}>
            <h2>Edit payroll — {editingRecord.employee_name}</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>{periodLabel(editingRecord)}</p>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Base salary</label>
                {/* Derived, never typed: it comes from the employee's declared
                    salary, their pay schedule and the attendance for this
                    period. Editing it here would desync the payroll from the
                    employee record and quietly break the formula. */}
                <input type="number" value={editForm.base_salary} readOnly disabled />
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  Set by the employee's base salary and pay schedule. Change it on the employee's page.
                </p>
              </div>
              <div className="form-row">
                <label>Bonuses</label>
                <DecimalInput
                  value={editForm.bonuses}
                  onChange={(e) => setEditForm({ ...editForm, bonuses: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Overtime pay</label>
                <DecimalInput
                  value={editForm.overtime_pay}
                  onChange={(e) => setEditForm({ ...editForm, overtime_pay: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Night differential pay</label>
                <DecimalInput
                  value={editForm.night_differential_pay}
                  onChange={(e) => setEditForm({ ...editForm, night_differential_pay: e.target.value })}
                />
              </div>
            </div>
            <p className="subtitle" style={{ margin: "12px 0 4px" }}>
              Deductions — carries forward to future cut-offs until changed here
            </p>
            <div className="grid grid-2">
              <div className="form-row">
                <label>SSS</label>
                <DecimalInput
                  value={editForm.deduction_sss}
                  onChange={(e) => setEditForm({ ...editForm, deduction_sss: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>HDMF (Pag-IBIG)</label>
                <DecimalInput
                  value={editForm.deduction_hdmf}
                  onChange={(e) => setEditForm({ ...editForm, deduction_hdmf: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>PhilHealth</label>
                <DecimalInput
                  value={editForm.deduction_philhealth}
                  onChange={(e) => setEditForm({ ...editForm, deduction_philhealth: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Taxes</label>
                <DecimalInput
                  value={editForm.deduction_taxes}
                  onChange={(e) => setEditForm({ ...editForm, deduction_taxes: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Loans</label>
                <DecimalInput
                  value={editForm.deduction_loans}
                  onChange={(e) => setEditForm({ ...editForm, deduction_loans: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Cash advances</label>
                <DecimalInput
                  value={editForm.deduction_cash_advances}
                  onChange={(e) => setEditForm({ ...editForm, deduction_cash_advances: e.target.value })}
                />
              </div>
            </div>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Total deductions: {money(
                (Number(editForm.deduction_sss) || 0) +
                (Number(editForm.deduction_hdmf) || 0) +
                (Number(editForm.deduction_philhealth) || 0) +
                (Number(editForm.deduction_taxes) || 0) +
                (Number(editForm.deduction_loans) || 0) +
                (Number(editForm.deduction_cash_advances) || 0)
              )}
            </p>
            <div className="form-row">
              <label>Final pay override (optional)</label>
              <input
                type="number"
                step="0.01"
                placeholder={`Leave blank to auto-calculate (${money(
                  (Number(editForm.base_salary) || 0) +
                  (Number(editForm.bonuses) || 0) +
                  (Number(editForm.overtime_pay) || 0) +
                  (Number(editForm.night_differential_pay) || 0) -
                  ((Number(editForm.deduction_sss) || 0) +
                    (Number(editForm.deduction_hdmf) || 0) +
                    (Number(editForm.deduction_philhealth) || 0) +
                    (Number(editForm.deduction_taxes) || 0) +
                    (Number(editForm.deduction_loans) || 0) +
                    (Number(editForm.deduction_cash_advances) || 0))
                )})`}
                value={editForm.net_pay_override}
                onChange={(e) => setEditForm({ ...editForm, net_pay_override: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingRecord(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </div>
      )}

      {editingSettings && (
        <div className="modal-backdrop" onClick={() => setEditingSettings(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveSettings}>
            <h2>Payroll calculation settings</h2>
            <p className="subtitle" style={{ marginTop: -8 }}>
              Used to auto-calculate base pay, overtime, and night differential from attendance when generating payroll
            </p>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Pay frequency</label>
                <select
                  value={settingsForm.pay_frequency}
                  onChange={(e) => setSettingsForm({ ...settingsForm, pay_frequency: e.target.value })}
                >
                  <option value="semi_monthly">Semi-monthly (1st–15th, 16th–end)</option>
                  <option value="monthly">Monthly (whole month)</option>
                </select>
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  How much of an employee's monthly base salary one payroll run pays out — half of it, or all of it.
                </p>
              </div>
              <div className="form-row">
                <label>Base pay basis</label>
                <select
                  value={settingsForm.attendance_basis}
                  onChange={(e) => setSettingsForm({ ...settingsForm, attendance_basis: e.target.value })}
                >
                  <option value="fixed">Fixed salary, less absences</option>
                  <option value="worked_days">Pay only for days worked</option>
                </select>
                <p className="subtitle" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  {settingsForm.attendance_basis === "worked_days"
                    ? "Attendance must be recorded, or base pay comes out as zero."
                    : "Salaried staff are paid in full unless an absence is recorded against them."}
                </p>
              </div>
            </div>
            <div className="form-row">
              <label>Standard hours per day</label>
              <DecimalInput
                value={settingsForm.standard_hours_per_day}
                onChange={(e) => setSettingsForm({ ...settingsForm, standard_hours_per_day: e.target.value })}
              />
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Regular shift start</label>
                <input
                  type="time"
                  value={settingsForm.regular_start_time}
                  onChange={(e) => setSettingsForm({ ...settingsForm, regular_start_time: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Regular shift end</label>
                <input
                  type="time"
                  value={settingsForm.regular_end_time}
                  onChange={(e) => setSettingsForm({ ...settingsForm, regular_end_time: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-2">
              <div className="form-row">
                <label>Overtime window start</label>
                <input
                  type="time"
                  value={settingsForm.overtime_start_time}
                  onChange={(e) => setSettingsForm({ ...settingsForm, overtime_start_time: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Overtime window end</label>
                <input
                  type="time"
                  value={settingsForm.overtime_end_time}
                  onChange={(e) => setSettingsForm({ ...settingsForm, overtime_end_time: e.target.value })}
                />
              </div>
            </div>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              Time actually clocked within the overtime window above is paid at the overtime multiplier, instead of
              any time beyond standard hours.
            </p>
            <div className="form-row">
              <label>Overtime pay multiplier</label>
              <DecimalInput
                value={settingsForm.overtime_multiplier}
                onChange={(e) => setSettingsForm({ ...settingsForm, overtime_multiplier: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Night shift differential multiplier</label>
              <DecimalInput
                value={settingsForm.night_shift_multiplier}
                onChange={(e) => setSettingsForm({ ...settingsForm, night_shift_multiplier: e.target.value })}
              />
              <p className="subtitle" style={{ margin: "4px 0 0" }}>
                Extra premium paid on top of the regular rate for time clocked between 10:00 PM and 6:00 AM (fixed,
                per labor law — only the multiplier is adjustable).
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingSettings(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
