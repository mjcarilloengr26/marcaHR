import { useEffect, useMemo, useState } from "react";
import { api, downloadFile } from "../api/client";
import { useAuth } from "../context/AuthContext";
import GanttChart, { ZOOM } from "../components/GanttChart";

// The schedule side of a project: what is planned, when, and how much of it is
// actually done.
//
// Deliberately not the Task Board. The board is for ad-hoc work — a card, a
// column, a due date, whatever comes up this week. This is for work that was
// planned in advance and has a span: a phase that runs for six weeks, a
// handover that happens on one date. Making one screen do both would give the
// board dates it does not want and the chart columns it cannot draw.
//
// A Gantt is only worth having if it is kept current, which is why progress is
// editable by whoever the task is assigned to and not only by an administrator.
// A plan that needs a request to HR to update is a plan that stops being true
// in about a fortnight.

const EMPTY_TASK = {
  name: "",
  start_date: "",
  end_date: "",
  percent_complete: 0,
  assignee_id: "",
  parent_id: "",
  is_milestone: false,
  notes: "",
};

export default function Gantt() {
  const { user } = useAuth();
  const isHr = user.role === "admin" || user.role === "hr";

  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [zoom, setZoom] = useState("fit");
  const [projectId, setProjectId] = useState("all");
  const [showClosed, setShowClosed] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(null); // { task, projectId }
  const [form, setForm] = useState(EMPTY_TASK);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .get("/projects/gantt")
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    if (isHr) api.get("/employees").then(setEmployees).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    if (!data) return { projects: [], tasks: [] };
    let projects = data.projects;
    if (!showClosed) projects = projects.filter((p) => p.status !== "completed" && p.status !== "cancelled");
    if (projectId !== "all") projects = projects.filter((p) => String(p.id) === String(projectId));
    const ids = new Set(projects.map((p) => p.id));
    return { projects, tasks: data.tasks.filter((t) => ids.has(t.project_id)) };
  }, [data, projectId, showClosed]);

  const openNewTask = (pid) => {
    setForm({ ...EMPTY_TASK, start_date: data.today, end_date: data.today });
    setEditing({ task: null, projectId: pid });
    setError("");
  };

  const openTask = (task) => {
    setForm({
      name: task.name,
      start_date: task.start_date,
      end_date: task.end_date,
      percent_complete: task.percent_complete,
      assignee_id: task.assignee_id || "",
      parent_id: task.parent_id || "",
      is_milestone: task.is_milestone,
      notes: task.notes || "",
    });
    setEditing({ task, projectId: task.project_id });
    setError("");
  };

  const canEditSchedule = isHr;

  const saveTask = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = canEditSchedule
        ? { ...form, percent_complete: Number(form.percent_complete) || 0 }
        : { percent_complete: Number(form.percent_complete) || 0 };
      if (editing.task) await api.put(`/projects/${editing.projectId}/tasks/${editing.task.id}`, body);
      else await api.post(`/projects/${editing.projectId}/tasks`, body);
      setEditing(null);
      setNotice(editing.task ? `"${form.name}" updated.` : `"${form.name}" added to the plan.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteTask = async () => {
    if (!confirm(`Delete "${editing.task.name}" from the plan?`)) return;
    setSaving(true);
    try {
      await api.del(`/projects/${editing.projectId}/tasks/${editing.task.id}`);
      setEditing(null);
      setNotice("Task removed from the plan.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // The chart as a spreadsheet: the register and its P&L, a week-by-week grid
  // of coloured cells, and the same tasks as flat rows to sort and filter. What
  // is exported follows the "include completed" switch above, so the file
  // matches the chart the person was looking at when they asked for it.
  const exportExcel = async () => {
    setExporting(true);
    setError("");
    try {
      await downloadFile(
        `/reports/projects-export?include_closed=${showClosed ? 1 : 0}`,
        "marca-group-projects-gantt.xlsx"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!data) return <div className="error-banner">{error || "No data"}</div>;

  // Phases available as a parent — only within the project being edited, since
  // a task cannot sit under a phase belonging to another job.
  const phaseOptions = data.tasks.filter(
    (t) => t.project_id === editing?.projectId && !t.is_milestone && t.id !== editing?.task?.id
  );

  const atRisk = visible.projects.filter((p) => p.schedule.key === "overdue" || p.schedule.key === "behind");

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Project Gantt</h1>
          <p className="subtitle">
            Scheduled project work on a timeline. Ad-hoc day-to-day work stays on the Task Board — this
            is for work with a planned span. Progress can be updated by whoever the task is assigned to,
            because a plan only anybody senior can edit is a plan that goes stale.
          </p>
        </div>
        <div className="col-actions">
          <button className="btn btn-secondary" onClick={exportExcel} disabled={exporting}>
            {exporting ? "Building…" : "Export to Excel"}
          </button>
          {isHr && visible.projects.length > 0 && (
            <button className="btn" onClick={() => openNewTask(visible.projects[0].id)}>+ New task</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-inline">
          <div className="form-row">
            <label>Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="all">All projects</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Scale</label>
            <select value={zoom} onChange={(e) => setZoom(e.target.value)}>
              {Object.entries(ZOOM).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>&nbsp;</label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={showClosed}
                onChange={(e) => setShowClosed(e.target.checked)}
                style={{ width: "auto" }}
              />
              Include completed / cancelled
            </label>
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label>&nbsp;</label>
            <div className="subtitle" style={{ margin: 0 }}>
              {visible.projects.length} project{visible.projects.length === 1 ? "" : "s"} ·{" "}
              {visible.tasks.length} task{visible.tasks.length === 1 ? "" : "s"}
              {atRisk.length > 0 && (
                <span style={{ color: "var(--danger)" }}>
                  {" "}· {atRisk.length} behind or past target
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <GanttChart
          projects={visible.projects}
          tasks={visible.tasks}
          today={data.today}
          zoom={zoom}
          onTaskClick={openTask}
        />
      </div>

      {/* The plan as a list, for the projects that have none yet — an empty
          chart row says nothing about what to do next, and this does. */}
      {isHr && visible.projects.some((p) => p.tasks.total === 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Projects with nothing scheduled</h2>
          <p className="subtitle" style={{ marginTop: 0 }}>
            These have no tasks, so the chart can only draw their overall span and their progress reads
            as unknown rather than zero.
          </p>
          <div className="col-actions" style={{ flexWrap: "wrap" }}>
            {visible.projects
              .filter((p) => p.tasks.total === 0)
              .map((p) => (
                <button key={p.id} className="btn btn-sm btn-secondary" onClick={() => openNewTask(p.id)}>
                  + Add a task to {p.code}
                </button>
              ))}
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.task ? "Edit task" : "New task"}</h2>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              {canEditSchedule
                ? "A milestone is a single dated event — a handover, an inspection, a payment point — and is drawn as a marker rather than a bar."
                : "You can update how far along this task is. The schedule itself is set by whoever owns the plan."}
            </p>
            <form onSubmit={saveTask}>
              {!editing.task && (
                <div className="form-row">
                  <label>Project</label>
                  <select
                    value={editing.projectId}
                    onChange={(e) => setEditing({ ...editing, projectId: Number(e.target.value) })}
                  >
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-row">
                <label>Task</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Site preparation"
                  required
                  disabled={!canEditSchedule}
                  autoFocus
                />
              </div>

              <div className="grid grid-2">
                <div className="form-row">
                  <label>Start</label>
                  <input
                    type="date"
                    value={form.start_date}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        start_date: e.target.value,
                        // Dragging the start past the end is a typo, not a
                        // schedule. The end follows rather than the form
                        // refusing to save later.
                        end_date: form.end_date && form.end_date < e.target.value ? e.target.value : form.end_date,
                      })
                    }
                    required
                    disabled={!canEditSchedule}
                  />
                </div>
                <div className="form-row">
                  <label>End</label>
                  <input
                    type="date"
                    value={form.is_milestone ? form.start_date : form.end_date}
                    min={form.start_date || undefined}
                    onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                    required={!form.is_milestone}
                    disabled={!canEditSchedule || form.is_milestone}
                  />
                </div>
              </div>

              <div className="grid grid-2">
                <div className="form-row">
                  <label>Progress — {form.percent_complete}%</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={form.percent_complete}
                    onChange={(e) => setForm({ ...form, percent_complete: Number(e.target.value) })}
                  />
                </div>
                <div className="form-row">
                  <label>Assigned to</label>
                  <select
                    value={form.assignee_id}
                    onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}
                    disabled={!canEditSchedule}
                  >
                    <option value="">Unassigned</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {canEditSchedule && (
                <div className="grid grid-2">
                  <div className="form-row">
                    <label>Part of phase</label>
                    <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
                      <option value="">Top level</option>
                      {phaseOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row">
                    <label>&nbsp;</label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={form.is_milestone}
                        onChange={(e) => setForm({ ...form, is_milestone: e.target.checked })}
                        style={{ width: "auto" }}
                      />
                      This is a milestone, not a span of work
                    </label>
                  </div>
                </div>
              )}

              {canEditSchedule && (
                <div className="form-row">
                  <label>Notes</label>
                  <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              )}

              <div className="modal-actions">
                {editing.task && isHr && (
                  <button type="button" className="btn btn-danger" onClick={deleteTask} disabled={saving}>
                    Delete
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? "Saving…" : editing.task ? "Save changes" : "Add task"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
