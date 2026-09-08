import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// A timeline of scheduled project work: one row per project, one bar per task.
//
// Hand-rolled rather than pulled from a charting library, for the same reason
// the revenue trend and the funnel are: every chart in this app is plain
// SVG/CSS on the app's own tokens, and a library would arrive with its own
// palette, its own dark mode and 200KB of bundle for one screen.
//
// The whole chart is a single horizontal scroller. The label column is sticky
// inside it, so scrolling to November never leaves you looking at unlabelled
// bars — which is the failure that makes most Gantt charts unreadable the
// moment the plan is longer than the screen.

const DAY_MS = 86400000;
const LABEL_W = 240;

const toUTC = (iso) => Date.parse(`${iso}T00:00:00Z`);
const daysBetween = (from, to) => Math.round((toUTC(to) - toUTC(from)) / DAY_MS);
const addDays = (iso, n) => new Date(toUTC(iso) + n * DAY_MS).toISOString().slice(0, 10);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Zoom is a pixel width per day. Fixed steps rather than a slider: the useful
// question is "the whole job, this quarter or this week", not an arbitrary
// magnification. "Fit" has no fixed width — it is worked out from the space the
// chart actually has, so a plan opens whole rather than opening on January.
export const ZOOM = {
  fit: { label: "Fit to screen", px: null },
  day: { label: "Days", px: 26 },
  week: { label: "Weeks", px: 7 },
  month: { label: "Months", px: 2.6 },
};

// A bar's colour says what state the work is in, never how far along it is —
// progress is already the fill width, and encoding it twice means a task that
// is 60% done and a task that is late look like different kinds of thing when
// they are the same kind in different states.
function stateOf(task, today) {
  if (task.percent_complete >= 100) return "done";
  if (task.end_date < today) return "overdue";
  if (task.start_date > today) return "planned";
  return "active";
}

function monthBands(start, end) {
  const bands = [];
  let cursor = `${start.slice(0, 7)}-01`;
  while (cursor <= end) {
    const [y, m] = cursor.split("-").map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const from = cursor < start ? start : cursor;
    const to = nextMonth > end ? end : addDays(nextMonth, -1);
    bands.push({
      key: cursor,
      label: `${MONTHS[m - 1]} ${String(y).slice(2)}`,
      offset: daysBetween(start, from),
      span: daysBetween(from, to) + 1,
    });
    cursor = nextMonth;
  }
  return bands;
}

export default function GanttChart({ projects, tasks, today, zoom = "fit", onTaskClick }) {
  // The scroller's own width, so "Fit to screen" can work out a scale. A
  // callback ref rather than useRef + useEffect: on the first render the page
  // is still a spinner and the element does not exist yet, so an effect with an
  // empty dependency list would measure nothing and the chart would keep the
  // placeholder scale for good.
  const [viewW, setViewW] = useState(0);
  const scroller = useRef(null);
  const observer = useRef(null);
  const attach = useCallback((node) => {
    scroller.current = node;
    observer.current?.disconnect();
    if (!node || typeof ResizeObserver === "undefined") return;
    setViewW(node.clientWidth);
    observer.current = new ResizeObserver(([e]) => setViewW(Math.round(e.contentRect.width)));
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const { start, end, rows } = useMemo(() => {
    const dates = [];
    for (const p of projects) {
      if (p.start_date) dates.push(p.start_date);
      if (p.target_end_date) dates.push(p.target_end_date);
      if (p.actual_end_date) dates.push(p.actual_end_date);
    }
    for (const t of tasks) dates.push(t.start_date, t.end_date);
    dates.push(today);

    const min = dates.reduce((a, d) => (d < a ? d : a), dates[0]);
    const max = dates.reduce((a, d) => (d > a ? d : a), dates[0]);
    // A week of air either side, so a bar that starts on the first day of the
    // range is not glued to the axis.
    const from = addDays(min, -7);
    const to = addDays(max, 7);

    const byProject = new Map();
    for (const t of tasks) {
      const list = byProject.get(t.project_id) || [];
      list.push(t);
      byProject.set(t.project_id, list);
    }

    // Which tasks are phases — that is, which have anything filed under them.
    // A phase is not a separate kind of row in the database, it is just a task
    // somebody made a parent, so the chart has to work it out rather than being
    // told.
    const parents = new Set(tasks.map((t) => t.parent_id).filter(Boolean));

    const out = [];
    for (const p of projects) {
      out.push({ kind: "project", project: p });
      for (const t of byProject.get(p.id) || []) {
        out.push({ kind: "task", project: p, task: t, isPhase: parents.has(t.id) });
      }
    }
    return { start: from, end: to, rows: out };
  }, [projects, tasks, today]);

  const totalDays = daysBetween(start, end) + 1;
  // "Fit" divides the space that is actually left after the label column, so
  // the whole plan lands on one screen with no horizontal scrolling at all.
  // Floored, because below about a pixel a day a bar stops being a bar.
  const px =
    ZOOM[zoom].px ??
    (viewW > LABEL_W + 40 ? Math.max(0.9, (viewW - LABEL_W - 2) / totalDays) : ZOOM.month.px);
  const width = Math.round(totalDays * px);
  const bands = monthBands(start, end);
  const todayX = Math.round(daysBetween(start, today) * px);

  // A plan that starts in January opens showing January, which is almost never
  // what anyone came to look at. Scroll so today sits about a third in — near
  // enough to the left edge that most of what is visible is what happens next,
  // far enough in that the last few weeks are still on screen.
  const scrollToToday = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const target = LABEL_W + todayX - (el.clientWidth - LABEL_W) / 3;
    el.scrollLeft = Math.max(0, target);
  }, [todayX]);

  useEffect(scrollToToday, [scrollToToday, zoom]);

  const place = (from, to) => ({
    left: Math.round(daysBetween(start, from) * px),
    width: Math.max(3, Math.round((daysBetween(from, to) + 1) * px)),
  });

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        No projects to plot yet. Add a project with a start and target date, then give it tasks.
      </div>
    );
  }

  return (
    <div className="gantt">
      <div className="gantt-legend">
        <span><i className="gantt-key gantt-key-active" /> In progress</span>
        <span><i className="gantt-key gantt-key-planned" /> Planned</span>
        <span><i className="gantt-key gantt-key-done" /> Complete</span>
        <span><i className="gantt-key gantt-key-overdue" /> Past its end date</span>
        <span><i className="gantt-key gantt-key-milestone" /> Milestone</span>
        <span><i className="gantt-key gantt-key-today" /> Today</span>
        <button type="button" className="link-btn" onClick={scrollToToday}>Jump to today</button>
      </div>

      <div className="gantt-scroll" ref={attach}>
        <div className="gantt-inner" style={{ width: LABEL_W + width }}>
          <div className="gantt-head">
            <div className="gantt-label gantt-head-label">Project / task</div>
            <div className="gantt-track" style={{ width }}>
              {bands.map((b) => (
                <div
                  key={b.key}
                  className="gantt-month"
                  style={{ left: Math.round(b.offset * px), width: Math.round(b.span * px) }}
                >
                  <span>{b.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="gantt-body">
            {/* One line for today across the whole chart rather than one per
                row: it is a single fact about the calendar, and repeating it
                per row makes it break wherever a row has no bar. */}
            <div className="gantt-today-line" style={{ left: LABEL_W + todayX }} />

            {rows.map((row) => {
              if (row.kind === "project") {
                const p = row.project;
                const from = p.start_date || p.tasks.firstStart;
                const to = p.actual_end_date || p.target_end_date || p.tasks.lastEnd;
                const pos = from && to ? place(from, to) : null;
                return (
                  <div className="gantt-row gantt-row-project" key={`p${p.id}`}>
                    <div className="gantt-label">
                      <strong title={p.name}>{p.code}</strong>
                      <span className="gantt-label-sub" title={p.name}>{p.name}</span>
                    </div>
                    <div className="gantt-track" style={{ width }}>
                      {bands.map((b) => (
                        <div key={b.key} className="gantt-gridline" style={{ left: Math.round(b.offset * px) }} />
                      ))}
                      {pos ? (
                        <div
                          className={`gantt-bar gantt-bar-summary${p.schedule.tone === "bad" ? " is-bad" : ""}`}
                          style={pos}
                          title={`${p.code} · ${from} to ${to} · ${p.progressPercent === null ? "no tasks" : `${p.progressPercent}% complete`} · ${p.schedule.label}`}
                        >
                          <div
                            className="gantt-bar-fill"
                            style={{ width: `${p.progressPercent === null ? 0 : p.progressPercent}%` }}
                          />
                        </div>
                      ) : (
                        <div className="gantt-nodates" style={{ left: todayX + 8 }}>No dates set</div>
                      )}
                      {/* Where the project was promised for. Drawn even when the
                          plan already runs past it, which is the case worth
                          seeing. */}
                      {p.target_end_date && (
                        <div
                          className="gantt-target"
                          style={{ left: Math.round(daysBetween(start, p.target_end_date) * px) }}
                          title={`Target end ${p.target_end_date}`}
                        />
                      )}
                    </div>
                  </div>
                );
              }

              const t = row.task;
              const state = stateOf(t, today);
              const pos = place(t.start_date, t.end_date);
              const detail = `${t.name} · ${t.start_date}${t.is_milestone ? "" : ` to ${t.end_date}`} · ${t.percent_complete}% complete${t.assignee_name ? ` · ${t.assignee_name}` : ""}`;

              return (
                <div className="gantt-row" key={`t${t.id}`}>
                  <div
                    className={`gantt-label gantt-label-task${row.isPhase ? " is-phase" : ""}${
                      t.parent_id ? " is-child" : ""
                    }`}
                  >
                    <span title={t.name}>{t.name}</span>
                    {t.assignee_name && <span className="gantt-label-sub">{t.assignee_name}</span>}
                  </div>
                  <div className="gantt-track" style={{ width }}>
                    {bands.map((b) => (
                      <div key={b.key} className="gantt-gridline" style={{ left: Math.round(b.offset * px) }} />
                    ))}
                    {t.is_milestone ? (
                      <div
                        className={`gantt-milestone is-${state}`}
                        style={{ left: pos.left }}
                        title={detail}
                        onClick={onTaskClick ? () => onTaskClick(t) : undefined}
                      />
                    ) : (
                      <div
                        className={`gantt-bar is-${state}`}
                        style={pos}
                        title={detail}
                        onClick={onTaskClick ? () => onTaskClick(t) : undefined}
                      >
                        <div className="gantt-bar-fill" style={{ width: `${t.percent_complete}%` }} />
                      </div>
                    )}
                    {/* The percentage sits beside the bar, not on every one of
                        them: at week zoom most bars are too narrow to hold a
                        number, and a label that only sometimes fits reads as
                        missing data. */}
                    {!t.is_milestone && t.percent_complete > 0 && (
                      <span className="gantt-pct" style={{ left: pos.left + pos.width + 6 }}>
                        {t.percent_complete}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
