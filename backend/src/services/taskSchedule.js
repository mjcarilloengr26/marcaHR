const db = require("../db");
const { currentCalendar } = require("./workingWeek");

// Dependencies between tasks, and what they do to the dates when one moves.
//
// The rule is finish-to-start with a lag: a task may not begin until the day
// after everything it waits on has finished, plus whatever gap the lag records.
//
//     earliest start = max(predecessor end + lag + 1)
//
// Rescheduling only ever pushes work later, never earlier. A predecessor
// finishing ahead of time does not drag the next crew's mobilisation date
// backwards — that is a decision somebody makes, not one a chart makes for
// them at two in the morning. Pulling dates in automatically is also how a
// plan quietly loses the float that was put there on purpose.
//
// Two different units are in play, on purpose:
//   - a task's DURATION is working days, because that is what the work takes;
//   - a link's LAG is calendar days, because that is what a lag represents —
//     concrete cures on a Sunday and a delivery lead time does not pause for
//     the weekend.
// Both are labelled as such wherever they are entered.

const DAY_MS = 86400000;
const toUTC = (iso) => Date.parse(`${iso}T00:00:00Z`);
const addDays = (iso, n) => new Date(toUTC(iso) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((toUTC(a) - toUTC(b)) / DAY_MS);

async function loadPlan(projectId) {
  const [tasks, deps] = await Promise.all([
    db.prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY position, start_date, id").all(projectId),
    db
      .prepare(
        `SELECT d.* FROM project_task_dependencies d
         JOIN project_tasks t ON t.id = d.task_id
         WHERE t.project_id = ?`
      )
      .all(projectId),
  ]);
  return { tasks, deps };
}

// Predecessors of each task, as a plain adjacency map.
function predecessorMap(deps) {
  const map = new Map();
  for (const d of deps) {
    const list = map.get(d.task_id) || [];
    list.push({ id: d.depends_on_id, lag: Number(d.lag_days) || 0 });
    map.set(d.task_id, list);
  }
  return map;
}

// Would adding taskId -> dependsOnId close a loop? Walk back from the proposed
// predecessor through everything it already waits on; arriving at taskId means
// the task would end up waiting on itself.
function wouldCycle(deps, taskId, dependsOnId) {
  if (Number(taskId) === Number(dependsOnId)) return true;
  const preds = predecessorMap(deps);
  const seen = new Set();
  const stack = [Number(dependsOnId)];
  while (stack.length) {
    const at = stack.pop();
    if (Number(at) === Number(taskId)) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const p of preds.get(at) || []) stack.push(Number(p.id));
  }
  return false;
}

// Predecessors first. Kahn's algorithm, so a task is only visited once every
// task it waits on has already been given its final dates — otherwise a chain
// of three would need three passes to settle.
//
// Anything left over is part of a cycle. That should be impossible (links are
// refused at the point of creation), but a plan that cannot be ordered is
// returned rather than looped over forever: a schedule nobody can compute is a
// bug to surface, not a hang.
function topoOrder(tasks, preds) {
  const remaining = new Map(tasks.map((t) => [t.id, (preds.get(t.id) || []).filter((p) => tasks.some((x) => x.id === p.id)).length]));
  const dependents = new Map();
  for (const t of tasks) {
    for (const p of preds.get(t.id) || []) {
      const list = dependents.get(p.id) || [];
      list.push(t.id);
      dependents.set(p.id, list);
    }
  }
  const queue = tasks.filter((t) => remaining.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const d of dependents.get(id) || []) {
      remaining.set(d, remaining.get(d) - 1);
      if (remaining.get(d) === 0) queue.push(d);
    }
  }
  return { order, unresolved: tasks.filter((t) => !order.includes(t.id)).map((t) => t.id) };
}

// The date a task could start at the earliest, given what it waits on. Null
// when it waits on nothing.
//
// The lag is counted in calendar days from the predecessor's end, and only
// then is the result moved onto a working day — so a two-day cure that lands
// on a Saturday under a Monday-Friday week starts the job on the Monday, not
// on the Saturday and not two working days later.
function earliestStart(taskId, preds, byId, cal) {
  let earliest = null;
  for (const p of preds.get(taskId) || []) {
    const pred = byId.get(p.id);
    if (!pred) continue;
    const candidate = cal.nextWorkingDay(addDays(pred.end_date, p.lag + 1));
    if (earliest === null || candidate > earliest) earliest = candidate;
  }
  return earliest;
}

// Move everything that now starts too early, in dependency order, and write the
// changes. `pinnedId` is the task the user just edited by hand: it keeps the
// dates they typed, whatever its predecessors say. Snapping it back would throw
// away the edit they had just made and look like the save had failed — the
// contradiction is reported as a conflict instead.
//
// Durations are preserved. A task that is pushed keeps its length; it does not
// get compressed to hit a date nobody has agreed to work faster for.
async function reschedule(projectId, { pinnedId = null } = {}) {
  const { tasks, deps } = await loadPlan(projectId);
  if (deps.length === 0) return { moved: [], unresolved: [] };

  const cal = await currentCalendar();
  const preds = predecessorMap(deps);
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const { order, unresolved } = topoOrder(tasks, preds);

  const moved = [];
  for (const id of order) {
    if (pinnedId && Number(id) === Number(pinnedId)) continue;
    const task = byId.get(id);
    const earliest = earliestStart(id, preds, byId, cal);
    if (!earliest || task.start_date >= earliest) continue;

    const from = { start: task.start_date, end: task.end_date };
    // The end is rebuilt from the new start and the task's own length in
    // working days, not slid by the same number of calendar days. Sliding
    // both ends equally is what silently lengthens or shortens a task that
    // gets pushed across a weekend.
    const length = task.is_milestone ? 1 : cal.workingDaysBetween(task.start_date, task.end_date) || 1;
    task.start_date = earliest;
    task.end_date = task.is_milestone ? earliest : cal.endAfterWorkingDays(earliest, length);
    moved.push({
      id: task.id,
      name: task.name,
      days: dayDiff(task.start_date, from.start),
      from,
      to: { start: task.start_date, end: task.end_date },
    });
  }

  for (const m of moved) {
    const t = byId.get(m.id);
    await db.prepare("UPDATE project_tasks SET start_date = ?, end_date = ? WHERE id = ?").run(t.start_date, t.end_date, t.id);
  }

  return { moved, unresolved };
}

// Tasks whose dates contradict what they wait on. After a reschedule the only
// one that can be in this state is the task somebody pinned by editing it, and
// saying so plainly is the point: the plan records what was asked for and the
// chart shows that it does not add up.
async function conflicts(projectId) {
  const { tasks, deps } = await loadPlan(projectId);
  if (deps.length === 0) return [];
  const cal = await currentCalendar();
  const preds = predecessorMap(deps);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  for (const t of tasks) {
    const earliest = earliestStart(t.id, preds, byId, cal);
    if (earliest && t.start_date < earliest) {
      out.push({ id: t.id, name: t.name, starts: t.start_date, earliest, daysEarly: dayDiff(earliest, t.start_date) });
    }
  }
  return out;
}

// Every dependency in the app, for the chart to draw. Read in one query rather
// than per project: the Gantt already fetches every task at once, and one more
// round trip per project row is the thing that makes a timeline assemble itself
// in front of the reader.
async function allDependencies() {
  return db.prepare("SELECT id, task_id, depends_on_id, lag_days FROM project_task_dependencies").all();
}

module.exports = {
  loadPlan,
  predecessorMap,
  wouldCycle,
  reschedule,
  conflicts,
  allDependencies,
  addDays,
  dayDiff,
};
