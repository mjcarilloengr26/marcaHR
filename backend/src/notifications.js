const db = require("./db");
const { sendMail } = require("./mailer");

function getEmployee(employeeId) {
  if (!employeeId) return null;
  return db.prepare("SELECT id, first_name, last_name, email FROM employees WHERE id = ?").get(employeeId) || null;
}

function getHrEmails() {
  return db.prepare("SELECT email FROM users WHERE role IN ('admin','hr')").all().map((r) => r.email);
}

function fullName(emp) {
  return `${emp.first_name} ${emp.last_name}`;
}

function notifyLeaveSubmitted({ employee_id, leave_type_name, start_date, end_date, days }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: getHrEmails(),
    subject: `New leave request — ${fullName(emp)}`,
    text: `${fullName(emp)} requested ${days} day(s) of ${leave_type_name} leave, ${start_date} to ${end_date}.\n\nReview it in MARCA GROUP.`,
  });
}

function notifyLeaveStatusChanged({ employee_id, leave_type_name, start_date, end_date, status }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `Your leave request was ${status}`,
    text: `Hi ${emp.first_name},\n\nYour ${leave_type_name} leave request (${start_date} to ${end_date}) was ${status}.`,
  });
}

function notifyExpenseSubmitted({ employee_id, title }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: getHrEmails(),
    subject: `New expense report submitted — ${fullName(emp)}`,
    text: `${fullName(emp)} submitted an expense report: "${title}".\n\nReview it in MARCA GROUP.`,
  });
}

function notifyExpenseStatusChanged({ employee_id, title, status }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `Your expense report was ${status}`,
    text: `Hi ${emp.first_name},\n\nYour expense report "${title}" was ${status}.`,
  });
}

function notifyCardAssigned({ employee_id, title }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `You were assigned a task: ${title}`,
    text: `Hi ${emp.first_name},\n\nYou were assigned to the task "${title}" on the HR task board.`,
  });
}

function notifyReviewSubmitted({ employee_id, cycle_name }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: "Your performance review is ready",
    text: `Hi ${emp.first_name},\n\nYour performance review for "${cycle_name}" has been submitted and is ready for your acknowledgement.`,
  });
}

function notifyWorkOrderAssigned({ employee_id, title }) {
  const emp = getEmployee(employee_id);
  if (!emp) return;
  sendMail({
    to: emp.email,
    subject: `You were assigned a work order: ${title}`,
    text: `Hi ${emp.first_name},\n\nYou were assigned to the work order "${title}".`,
  });
}

module.exports = {
  notifyLeaveSubmitted,
  notifyLeaveStatusChanged,
  notifyExpenseSubmitted,
  notifyExpenseStatusChanged,
  notifyCardAssigned,
  notifyReviewSubmitted,
  notifyWorkOrderAssigned,
};
