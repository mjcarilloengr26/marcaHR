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
  // [{ id, lag_days }] — what has to finish before this can start.
  predecessors: [],
  duration_days: 1,
  // Whether the links were actually touched this time round. Sending them
  // unchanged makes the server assume the schedule might have moved, and it
  // then reloads and re-solves the whole plan for a save that only nudged a
  // percentage — the same reason duration is only sent when it was the field
  // being asserted.
  predsDirty: false,
  // Which of End and Duration the user touched last, so the save knows which
  // one it is being asked to honour. Stripped before the request goes out.
  durationDriven: false,
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
  // Bulk assignment. Off until asked for: checkboxes down a chart nobody is
  // reassigning are just clutter in the column that holds the names.
  const [assignMode, setAssignMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [assigning, setAssigning] = useState(false);

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
    setForm({
      ...EMPTY_TASK,
      predecessors: [],
      start_date: data.today,
      end_date: data.today,
      duration_days: 1,
      // A brand new task has no stored links to compare against, so its list is
      // always worth sending.
      predsDirty: true,
    });
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
      predecessors: (data.dependencies || [])
        .filter((d) => d.task_id === task.id)
        .map((d) => ({ id: d.depends_on_id, lag_days: d.lag_days })),
      // Sent by the server with the task, so the count shown is the one the
      // server would compute rather than a second opinion.
      duration_days: task.duration_days ?? 1,
      durationDriven: false,
      predsDirty: false,
    });
    setEditing({ task, projectId: task.project_id });
    setError("");
  };

  const canEditSchedule = isHr;

  const toggleSelect = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAllVisible = () => setSelected(new Set(visible.tasks.map((t) => t.id)));
  const clearSelection = () => setSelected(new Set());

  const applyAssignment = async () => {
    setAssigning(true);
    setError("");
    try {
      const r = await api.post("/projects/bulk-assign-tasks", {
        task_ids: [...selected],
        assignee_id: bulkAssignee || "",
      });
      setNotice(
        `${r.assigned} task${r.assigned === 1 ? "" : "s"} assigned to ${r.assignee || "nobody"}.` +
          (r.missing ? ` ${r.missing} could not be found and were skipped.` : "")
      );
      clearSelection();
      setAssignMode(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  };

  // Progress belongs to whoever is doing the work, and to nobody else. Mirrors
  // the check the server makes; the server stays the one that enforces it.
  const editingTask = editing?.task || null;
  const isAssignee = Boolean(
    editingTask && user.employee_id && Number(editingTask.assignee_id) === Number(user.employee_id)
  );
  // A new task has no assignee yet, so there is nobody to be but its author —
  // only the people who own the schedule can create one anyway.
  const canEditProgress = isHr || isAssignee;
  const canSave = canEditSchedule || canEditProgress;

  // A live preview of what the server will work out. The server recomputes
  // both from the same rule and its answer is what gets stored, so the worst a
  // disagreement here could do is flash for a moment before the reload
  // corrects it — the arithmetic is not duplicated as a source of truth.
  const workDays = data?.workingWeek?.days || [0, 1, 2, 3, 4, 5, 6];
  const DAY = 86400000;
  const addCal = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const isWorkDay = (d) => workDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  const nextWorkDay = (d) => {
    let out = d;
    for (let i = 0; i < 7 && !isWorkDay(out); i += 1) out = addCal(out, 1);
    return out;
  };
  const durationBetween = (start, end) => {
    if (!start || !end || end < start) return 1;
    let n = 0;
    for (let d = start; d <= end; d = addCal(d, 1)) if (isWorkDay(d)) n += 1;
    return n || 1;
  };
  const endFromDuration = (start, days) => {
    if (!start) return "";
    const from = nextWorkDay(start);
    let left = Math.max(1, days) - 1;
    let d = from;
    for (let guard = 0; left > 0 && guard < 4000; guard += 1) {
      d = addCal(d, 1);
      if (isWorkDay(d)) left -= 1;
    }
    return d;
  };

  const saveTask = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { durationDriven, duration_days, predsDirty, predecessors, ...rest } = form;
      const body = canEditSchedule
        ? {
            ...rest,
            percent_complete: Number(form.percent_complete) || 0,
            ...(predsDirty ? { predecessors } : {}),
            // Duration and end date are two ways of saying the same thing, and
            // sending both leaves the server guessing which one changed. Only
            // the one just edited is sent.
            ...(durationDriven ? { duration_days: Number(duration_days) || 1 } : {}),
          }
        : { percent_complete: Number(form.percent_complete) || 0 };
      const saved = editing.task
        ? await api.put(`/projects/${editing.projectId}/tasks/${editing.task.id}`, body)
        : await api.post(`/projects/${editing.projectId}/tasks`, body);
      setEditing(null);
      const moved = saved?.moved || [];
      const clash = (saved?.conflicts || []).find((c) => c.id === saved.id);
      setNotice(
        [
          editing.task ? `"${form.name}" updated.` : `"${form.name}" added to the plan.`,
          moved.length
            ? `${moved.length} later task${moved.length === 1 ? "" : "s"} moved to keep the sequence: ` +
              moved.slice(0, 3).map((m) => `${m.name} +${m.days}d`).join(", ") +
              (moved.length > 3 ? `, and ${moved.length - 3} more` : "") + "."
            : "",
          saved?.snappedFrom
            ? `${saved.snappedFrom} is not a working day, so it starts ${saved.start_date} instead.`
            : "",
          clash
            ? `It still starts ${clash.daysEarly} day${clash.daysEarly === 1 ? "" : "s"} before what it waits on finishes — saved as asked, but the plan does not add up.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      if (editing.task && saved?.id) {
        setData((d) =>
          d ? { ...d, tasks: d.tasks.map((t) => (t.id === saved.id ? { ...t, ...saved } : t)) } : d
        );
        // Not awaited: the chart is already showing the new value, and the
        // refresh only has to catch what this one row cannot know about.
        load();
      } else {
        await load();
      }
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

  // Anything downstream of the task being edited is left out: the server
  // refuses a link that would close a loop, and offering a choice that can only
  // be rejected is worse than not offering it at all.
  const predecessorOptions = (() => {
    if (!editing) return [];
    const deps = data.dependencies || [];
    const downstream = new Set();
    if (editing.task) {
      const stack = [editing.task.id];
      while (stack.length) {
        const at = stack.pop();
        for (const d of deps.filter((x) => x.depends_on_id === at)) {
          if (downstream.has(d.task_id)) continue;
          downstream.add(d.task_id);
          stack.push(d.task_id);
        }
      }
    }
    return data.tasks.filter(
      (t) => t.project_id === editing.projectId && t.id !== editing.task?.id && !downstream.has(t.id)
    );
  })();

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

      {isHr && (
        <div className="card" style={{ marginBottom: 16 }}>
          {!assignMode ? (
            <button className="btn btn-secondary btn-sm" onClick={() => setAssignMode(true)}>
              Assign tasks to someone
            </button>
          ) : (
            <div className="form-inline" style={{ margin: 0, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Assign {selected.size} selected task{selected.size === 1 ? "" : "s"} to</label>
                <select value={bulkAssignee} onChange={(e) => setBulkAssignee(e.target.value)}>
                  <option value="">Nobody — clear the assignment</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>&nbsp;</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" disabled={selected.size === 0 || assigning} onClick={applyAssignment}>
                    {assigning ? "Assigning…" : "Apply"}
                  </button>
                  <button className="btn btn-secondary" onClick={selectAllVisible}>
                    Select all {visible.tasks.length} shown
                  </button>
                  <button className="btn btn-secondary" onClick={clearSelection} disabled={selected.size === 0}>
                    Clear
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      clearSelection();
                      setAssignMode(false);
                    }}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
          {assignMode && (
            <p className="subtitle" style={{ margin: "10px 0 0", fontSize: 12 }}>
              Tick the tasks in the chart below. The filter above decides what is on offer, so narrowing to one
              project first is usually quicker than scrolling. Choosing nobody clears the assignment instead.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <GanttChart
          projects={visible.projects}
          tasks={visible.tasks}
          dependencies={data.dependencies || []}
          conflicts={data.conflicts || []}
          workingWeek={data.workingWeek}
          selectable={assignMode}
          selected={selected}
          onToggleSelect={toggleSelect}
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

              <div className="grid grid-3">
                <div className="form-row">
                  <label>Start</label>
                  <input
                    type="date"
                    value={form.start_date}
                    onChange={(e) => {
                      const start = e.target.value;
                      // Moving the start keeps the length of the work and
                      // carries the end with it. Holding the end still instead
                      // would silently make the task shorter, which is not what
                      // anyone means by moving a job later.
                      setForm({
                        ...form,
                        start_date: start,
                        end_date: start ? endFromDuration(start, form.duration_days) : form.end_date,
                        durationDriven: true,
                      });
                    }}
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
                    onChange={(e) =>
                      setForm({
                        ...form,
                        end_date: e.target.value,
                        duration_days: durationBetween(form.start_date, e.target.value),
                        durationDriven: false,
                      })
                    }
                    required={!form.is_milestone}
                    disabled={!canEditSchedule || form.is_milestone}
                  />
                </div>
                <div className="form-row">
                  <label>Duration</label>
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={form.is_milestone ? 1 : form.duration_days}
                    onChange={(e) => {
                      const days = Math.max(1, Number(e.target.value) || 1);
                      setForm({
                        ...form,
                        duration_days: days,
                        end_date: endFromDuration(form.start_date, days),
                        durationDriven: true,
                      });
                    }}
                    disabled={!canEditSchedule || form.is_milestone}
                  />
                  <span className="subtitle" style={{ fontSize: 12 }}>
                    {form.is_milestone
                      ? "a single date"
                      : `working days · ${data.workingWeek?.label || "every day"}`}
                  </span>
                </div>
              </div>

              {editingTask?.updated_at && (
                <p className="subtitle" style={{ margin: "0 0 12px", fontSize: 12 }}>
                  Last changed {editingTask.updated_at}
                  {editingTask.updated_by_name ? ` by ${editingTask.updated_by_name}` : " by the schedule shifting"}.
                </p>
              )}

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
                    disabled={!canEditProgress}
                  />
                  {!canEditProgress && (
                    <span className="subtitle" style={{ fontSize: 12 }}>
                      {editingTask?.assignee_name
                        ? `Only ${editingTask.assignee_name} or an administrator can move this.`
                        : "Nobody is assigned to this task yet, so only an administrator can move it."}
                    </span>
                  )}
                </div>
                <div className="form-row">
                  <label>Assigned to</label>
                  {canEditSchedule ? (
                    <select
                      value={form.assignee_id}
                      onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}
                    >
                      <option value="">Unassigned</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ padding: "8px 0", fontSize: 14 }}>
                      {editingTask?.assignee_name || "Nobody yet"}
                    </div>
                  )}
                </div>
              </div>

              {canEditSchedule && (
                <div className="grid grid-2">
                  <div className="form-row" style={{ gridColumn: "1 / -1" }}>
                    <label>Waits for</label>
                    {predecessorOptions.length === 0 ? (
                      <span className="subtitle" style={{ fontSize: 12, margin: 0 }}>
                        Nothing else is scheduled on this project yet.
                      </span>
                    ) : (
                      <>
                        <div className="gantt-pred-list">
                          {predecessorOptions.map((t) => {
                            const chosen = form.predecessors.find((x) => Number(x.id) === t.id);
                            return (
                              <div key={t.id} className={chosen ? "gantt-pred is-on" : "gantt-pred"}>
                                <label className="gantt-pred-pick">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(chosen)}
                                    onChange={(e) =>
                                      setForm({
                                        ...form,
                                        predsDirty: true,
                                        predecessors: e.target.checked
                                          ? [...form.predecessors, { id: t.id, lag_days: 0 }]
                                          : form.predecessors.filter((x) => Number(x.id) !== t.id),
                                      })
                                    }
                                  />
                                  <span className="gantt-pred-name" title={t.name}>{t.name}</span>
                                  <span className="gantt-pred-when">ends {t.end_date}</span>
                                </label>
                                {chosen && (
                                  <span className="gantt-pred-lag">
                                    then wait
                                    <input
                                      type="number"
                                      min="0"
                                      max="3650"
                                      value={chosen.lag_days}
                                      onChange={(e) =>
                                        setForm({
                                          ...form,
                                          predsDirty: true,
                                          predecessors: form.predecessors.map((x) =>
                                            Number(x.id) === t.id
                                              ? { ...x, lag_days: Math.max(0, Number(e.target.value) || 0) }
                                              : x
                                          ),
                                        })
                                      }
                                    />
                                    days
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <span className="subtitle" style={{ fontSize: 12 }}>
                          This starts the day after the last of these finishes, plus any lag. Work downstream
                          shifts out of the way on its own — nothing is ever pulled earlier.
                        </span>
                      </>
                    )}
                  </div>

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
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
                  {canSave ? "Cancel" : "Close"}
                </button>
                {canSave && (
                  <button type="submit" className="btn" disabled={saving}>
                    {saving ? "Saving…" : editing.task ? "Save changes" : "Add task"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
