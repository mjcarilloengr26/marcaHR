const db = require("./db");
const { companyName } = require("./services/branding");
const { sendMail } = require("./mailer");

async function getEmployee(employeeId) {
  if (!employeeId) return null;
  return (await db.prepare("SELECT id, first_name, last_name, email FROM employees WHERE id = ?").get(employeeId)) || null;
}

async function getHrEmails() {
  const rows = await db.prepare("SELECT email FROM users WHERE role IN ('admin','hr')").all();
  return rows.map((r) => r.email);
}

// The person this employee reports to, when there is one. An asset request is
// usually theirs to judge before HR sees it, so they are copied in rather than
// finding out once the kit has already been handed over.
async function getManagerEmail(employeeId) {
  if (!employeeId) return null;
  const row = await db
    .prepare("SELECT m.email FROM employees e JOIN employees m ON m.id = e.manager_id WHERE e.id = ?")
    .get(employeeId);
  return (row && row.email) || null;
}

function fullName(emp) {
  return `${emp.first_name} ${emp.last_name}`;
}

// These are called fire-and-forget from route handlers (never awaited), so every
// notifier swallows its own errors — a DB hiccup or SMTP failure here must never
// surface as an unhandled rejection or break the request that triggered it.
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error("Notification failed:", err);
    }
  };
}

const notifyLeaveSubmitted = guarded(async ({ employee_id, leave_type_name, start_date, end_date, days }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: await getHrEmails(),
    subject: `New leave request — ${fullName(emp)}`,
    text: `${fullName(emp)} requested ${days} day(s) of ${leave_type_name} leave, ${start_date} to ${end_date}.\n\nReview it in ${await companyName()}.`,
  });
});

const notifyLeaveStatusChanged = guarded(async ({ employee_id, leave_type_name, start_date, end_date, status }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `Your leave request was ${status}`,
    text: `Hi ${emp.first_name},\n\nYour ${leave_type_name} leave request (${start_date} to ${end_date}) was ${status}.`,
  });
});

const notifyExpenseSubmitted = guarded(async ({ employee_id, title }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: await getHrEmails(),
    subject: `New expense report submitted — ${fullName(emp)}`,
    text: `${fullName(emp)} submitted an expense report: "${title}".\n\nReview it in ${await companyName()}.`,
  });
});

const notifyExpenseStatusChanged = guarded(async ({ employee_id, title, status }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `Your expense report was ${status}`,
    text: `Hi ${emp.first_name},\n\nYour expense report "${title}" was ${status}.`,
  });
});

const notifyCardAssigned = guarded(async ({ employee_id, title }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `You were assigned a task: ${title}`,
    text: `Hi ${emp.first_name},\n\nYou were assigned to the task "${title}" on the HR task board.`,
  });
});

const notifyReviewSubmitted = guarded(async ({ employee_id, cycle_name }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: "Your performance review is ready",
    text: `Hi ${emp.first_name},\n\nYour performance review for "${cycle_name}" has been submitted and is ready for your acknowledgement.`,
  });
});

const notifyWorkOrderAssigned = guarded(async ({ employee_id, title }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `You were assigned a work order: ${title}`,
    text: `Hi ${emp.first_name},\n\nYou were assigned to the work order "${title}".`,
  });
});

const notifyLowStockAlarm = guarded(async ({ sku, name, quantity_on_hand, unit, reorder_level }) => {
  sendMail({
    to: await getHrEmails(),
    subject: `Low stock alarm — ${name}`,
    text: `${name} (SKU ${sku}) has dropped into the alarm zone: ${quantity_on_hand} ${unit} on hand (reorder level ${reorder_level} ${unit}).\n\nReview it in ${await companyName()} Inventory.`,
  });
});

const notifyAssetRequested = guarded(async ({ employee_id, asset_type, quantity, reason, needed_by }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  const managerEmail = await getManagerEmail(employee_id);
  // One address may be both HR and somebody's manager; sending twice would just
  // look like the system stuttering.
  const to = [...new Set([...(await getHrEmails()), managerEmail].filter(Boolean))];
  if (to.length === 0) return;

  const lines = [
    `${fullName(emp)} requested ${quantity} × ${asset_type}.`,
    reason ? `Reason: ${reason}` : null,
    needed_by ? `Needed by: ${needed_by}` : null,
    "",
    `Approve or turn it down in ${await companyName()} under Company Assets.`,
  ].filter((l) => l !== null);

  sendMail({
    to,
    subject: `New asset request — ${fullName(emp)}`,
    text: lines.join("\n"),
  });
});

const notifyAssetRequestDecision = guarded(async ({ employee_id, asset_type, status, review_note }) => {
  const emp = await getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `Your asset request was ${status}`,
    text:
      `Hi ${emp.first_name},\n\nYour request for ${asset_type} was ${status}.` +
      (review_note ? `\n\nNote: ${review_note}` : ""),
  });
});

module.exports = {
  notifyLeaveSubmitted,
  notifyLeaveStatusChanged,
  notifyExpenseSubmitted,
  notifyExpenseStatusChanged,
  notifyCardAssigned,
  notifyReviewSubmitted,
  notifyWorkOrderAssigned,
  notifyLowStockAlarm,
  notifyAssetRequested,
  notifyAssetRequestDecision,
};
