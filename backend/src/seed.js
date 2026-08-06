const bcrypt = require("bcryptjs");
const db = require("./db");

function hash(pw) {
  return bcrypt.hashSync(pw, 10);
}

const insertDept = db.prepare("INSERT INTO departments (name, description) VALUES (?, ?)");
const insertLocation = db.prepare("INSERT INTO locations (name, lat, lng, radius_meters, address) VALUES (?, ?, ?, ?, ?)");
const insertEmployee = db.prepare(`
  INSERT INTO employees (first_name, last_name, email, phone, department_id, location_id, position, manager_id, hire_date, status, base_salary, address)
  VALUES (@first_name, @last_name, @email, @phone, @department_id, @location_id, @position, @manager_id, @hire_date, @status, @base_salary, @address)
`);
const insertUser = db.prepare(
  "INSERT INTO users (email, password_hash, role, employee_id) VALUES (?, ?, ?, ?)"
);
const insertLeaveType = db.prepare("INSERT INTO leave_types (name, default_days_per_year) VALUES (?, ?)");
const insertBalance = db.prepare(
  "INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES (?, ?, ?, ?, ?)"
);
const insertLeaveRequest = db.prepare(`
  INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertAttendance = db.prepare(`
  INSERT INTO attendance (employee_id, date, status, clock_in, clock_out) VALUES (?, ?, ?, ?, ?)
`);
const insertPayroll = db.prepare(`
  INSERT INTO payroll_records (employee_id, period_month, period_year, base_salary, bonuses, deductions, net_pay, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertCycle = db.prepare("INSERT INTO review_cycles (name, start_date, end_date, status) VALUES (?, ?, ?, ?)");
const insertReview = db.prepare(`
  INSERT INTO performance_reviews (cycle_id, employee_id, reviewer_id, rating, goals, strengths, improvements, comments, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertColumn = db.prepare("INSERT INTO board_columns (name, position) VALUES (?, ?)");
const insertCard = db.prepare(`
  INSERT INTO board_cards (column_id, title, description, employee_id, due_date, position, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertExpenseReport = db.prepare(`
  INSERT INTO expense_reports (employee_id, title, cash_advance_amount, status, notes, reviewed_by, submitted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertExpenseItem = db.prepare(`
  INSERT INTO expense_items (report_id, expense_date, category, description, amount, receipt_ref)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  // Wipe existing data
  for (const table of [
    "expense_items",
    "expense_reports",
    "board_cards",
    "board_columns",
    "performance_reviews",
    "review_cycles",
    "payroll_records",
    "attendance",
    "leave_requests",
    "leave_balances",
    "leave_types",
    "users",
    "employees",
    "departments",
    "locations",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }

  const deptIds = {};
  for (const [name, description] of [
    ["Engineering", "Builds and maintains products"],
    ["Human Resources", "People operations and hiring"],
    ["Sales", "Revenue and customer acquisition"],
    ["Finance", "Accounting and payroll"],
  ]) {
    const info = insertDept.run(name, description);
    deptIds[name] = info.lastInsertRowid;
  }

  const locationIds = {};
  for (const [name, lat, lng, radius, address] of [
    ["Manila HQ", 14.5995, 120.9842, 500, "Ermita, Manila"],
    ["Cebu Branch", 10.3157, 123.8854, 500, "Cebu City"],
  ]) {
    const info = insertLocation.run(name, lat, lng, radius, address);
    locationIds[name] = info.lastInsertRowid;
  }

  function addEmployee(e) {
    const info = insertEmployee.run({
      manager_id: null,
      status: "active",
      base_salary: 0,
      phone: null,
      address: null,
      location_id: null,
      ...e,
    });
    return info.lastInsertRowid;
  }

  const ceoId = addEmployee({
    first_name: "Avery",
    last_name: "Reyes",
    email: "avery.reyes@example.com",
    department_id: deptIds["Human Resources"],
    location_id: locationIds["Manila HQ"],
    position: "CEO",
    hire_date: "2019-01-15",
    base_salary: 15000,
    phone: "555-0100",
  });

  const hrManagerId = addEmployee({
    first_name: "Priya",
    last_name: "Natarajan",
    email: "priya.natarajan@example.com",
    department_id: deptIds["Human Resources"],
    location_id: locationIds["Manila HQ"],
    position: "HR Manager",
    manager_id: ceoId,
    hire_date: "2020-03-01",
    base_salary: 8500,
    phone: "555-0101",
  });

  const engManagerId = addEmployee({
    first_name: "Diego",
    last_name: "Martinez",
    email: "diego.martinez@example.com",
    department_id: deptIds["Engineering"],
    location_id: locationIds["Manila HQ"],
    position: "Engineering Manager",
    manager_id: ceoId,
    hire_date: "2020-06-15",
    base_salary: 9500,
    phone: "555-0102",
  });

  const empIds = {
    ceo: ceoId,
    hrManager: hrManagerId,
    engManager: engManagerId,
  };

  const staff = [
    { first_name: "Jamie", last_name: "Chen", email: "jamie.chen@example.com", department_id: deptIds["Engineering"], location_id: locationIds["Manila HQ"], position: "Senior Software Engineer", manager_id: engManagerId, hire_date: "2021-02-10", base_salary: 7200, phone: "555-0103" },
    { first_name: "Morgan", last_name: "Lee", email: "morgan.lee@example.com", department_id: deptIds["Engineering"], location_id: locationIds["Manila HQ"], position: "Software Engineer", manager_id: engManagerId, hire_date: "2022-05-20", base_salary: 6100, phone: "555-0104" },
    { first_name: "Sam", last_name: "Okafor", email: "sam.okafor@example.com", department_id: deptIds["Engineering"], location_id: locationIds["Manila HQ"], position: "QA Engineer", manager_id: engManagerId, hire_date: "2023-01-09", base_salary: 5400, phone: "555-0105" },
    { first_name: "Taylor", last_name: "Kim", email: "taylor.kim@example.com", department_id: deptIds["Sales"], location_id: locationIds["Cebu Branch"], position: "Sales Lead", manager_id: ceoId, hire_date: "2021-09-01", base_salary: 6800, phone: "555-0106" },
    { first_name: "Riley", last_name: "Brooks", email: "riley.brooks@example.com", department_id: deptIds["Sales"], location_id: locationIds["Cebu Branch"], position: "Account Executive", manager_id: ceoId, hire_date: "2022-11-14", base_salary: 5200, phone: "555-0107" },
    { first_name: "Casey", last_name: "Nguyen", email: "casey.nguyen@example.com", department_id: deptIds["Finance"], location_id: locationIds["Manila HQ"], position: "Financial Analyst", manager_id: hrManagerId, hire_date: "2022-04-04", base_salary: 5900, phone: "555-0108" },
    { first_name: "Jordan", last_name: "Patel", email: "jordan.patel@example.com", department_id: deptIds["Human Resources"], location_id: locationIds["Manila HQ"], position: "HR Generalist", manager_id: hrManagerId, hire_date: "2023-07-18", base_salary: 4800, phone: "555-0109" },
  ];

  const staffIds = staff.map(addEmployee);

  // Users / logins
  insertUser.run("admin@example.com", hash("admin123"), "admin", ceoId);
  insertUser.run("hr@example.com", hash("hr123"), "hr", hrManagerId);
  insertUser.run("jamie.chen@example.com", hash("employee123"), "employee", staffIds[0]);
  insertUser.run("morgan.lee@example.com", hash("employee123"), "employee", staffIds[1]);

  // Leave types
  const vacationId = insertLeaveType.run("Vacation", 15).lastInsertRowid;
  const sickId = insertLeaveType.run("Sick", 10).lastInsertRowid;
  const personalId = insertLeaveType.run("Personal", 5).lastInsertRowid;

  const year = new Date().getFullYear();
  const allEmployeeIds = [ceoId, hrManagerId, engManagerId, ...staffIds];
  for (const id of allEmployeeIds) {
    insertBalance.run(id, vacationId, year, 15, 0);
    insertBalance.run(id, sickId, year, 10, 0);
    insertBalance.run(id, personalId, year, 5, 0);
  }

  // Sample leave requests
  insertLeaveRequest.run(staffIds[0], vacationId, `${year}-08-10`, `${year}-08-14`, 5, "Family trip", "pending");
  insertLeaveRequest.run(staffIds[1], sickId, `${year}-07-02`, `${year}-07-02`, 1, "Flu", "approved");
  insertLeaveRequest.run(staffIds[3], personalId, `${year}-09-01`, `${year}-09-01`, 1, "Personal errand", "pending");
  db.prepare("UPDATE leave_balances SET used_days = 1 WHERE employee_id = ? AND leave_type_id = ? AND year = ?").run(
    staffIds[1],
    sickId,
    year
  );

  // Sample attendance for the past 5 days. Deliberately starts at i=1 (yesterday), not
  // today (i=0) — leaving today's record unseeded so the Clock in/out buttons work
  // immediately for anyone trying the app, instead of showing "already punched" on day one.
  const today = new Date();
  for (let i = 1; i <= 5; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    for (const id of allEmployeeIds) {
      const isLate = Math.random() < 0.1;
      insertAttendance.run(id, dateStr, isLate ? "late" : "present", isLate ? "09:20:00" : "09:00:00", "18:00:00");
    }
  }

  // Sample payroll for current month
  const month = today.getMonth() + 1;
  for (const id of allEmployeeIds) {
    const emp = db.prepare("SELECT base_salary FROM employees WHERE id = ?").get(id);
    const bonus = Math.random() < 0.3 ? 500 : 0;
    const net = emp.base_salary + bonus;
    insertPayroll.run(id, month, year, emp.base_salary, bonus, 0, net, "finalized");
  }

  // Performance review cycle
  const cycleId = insertCycle.run(`${year} Mid-Year Review`, `${year}-06-01`, `${year}-06-30`, "closed").lastInsertRowid;
  insertReview.run(
    cycleId,
    staffIds[0],
    engManagerId,
    5,
    "Lead the API redesign project",
    "Strong technical skills, great mentor to juniors",
    "Could delegate more",
    "Outstanding performance this cycle.",
    "acknowledged"
  );
  insertReview.run(
    cycleId,
    staffIds[1],
    engManagerId,
    4,
    "Improve test coverage on core modules",
    "Reliable, good communicator",
    "Needs more ownership on ambiguous tasks",
    "Solid performance, room to grow.",
    "submitted"
  );

  // HR task board
  const todoId = insertColumn.run("To Do", 0).lastInsertRowid;
  const inProgressId = insertColumn.run("In Progress", 1).lastInsertRowid;
  const doneId = insertColumn.run("Done", 2).lastInsertRowid;

  insertCard.run(todoId, "Set up onboarding for new hire", "Prepare laptop, accounts, and welcome packet", staffIds[2], `${year}-08-15`, 0, hrManagerId);
  insertCard.run(todoId, "Renew Q3 benefits enrollment", "Confirm vendor rates before the enrollment window opens", null, `${year}-08-20`, 1, hrManagerId);
  insertCard.run(inProgressId, "Draft updated remote work policy", "Incorporate feedback from last town hall", staffIds[6], `${year}-08-12`, 0, hrManagerId);
  insertCard.run(doneId, "Finish mid-year review cycle", "All reviews submitted and acknowledged", engManagerId, `${year}-06-30`, 0, hrManagerId);

  // Liquidation / expense reports
  const clientTripReportId = insertExpenseReport.run(
    staffIds[3],
    "Client site visit - Cebu",
    5000,
    "submitted",
    "Cash advance for 2-day client visit",
    null,
    `${year}-07-20 09:00:00`
  ).lastInsertRowid;
  insertExpenseItem.run(clientTripReportId, `${year}-07-18`, "Transportation", "Round-trip airfare", 3200, "OR-1042");
  insertExpenseItem.run(clientTripReportId, `${year}-07-18`, "Meals", "Dinner with client", 850, "OR-1043");
  insertExpenseItem.run(clientTripReportId, `${year}-07-19`, "Lodging", "Hotel, 1 night", 2100, "OR-1044");

  const suppliesReportId = insertExpenseReport.run(
    staffIds[0],
    "Office supplies - Q3",
    1500,
    "approved",
    "Replenish team supplies",
    hrManagerId,
    `${year}-07-05 14:00:00`
  ).lastInsertRowid;
  insertExpenseItem.run(suppliesReportId, `${year}-07-03`, "Supplies", "Notebooks and pens", 620, "OR-0991");
  insertExpenseItem.run(suppliesReportId, `${year}-07-04`, "Supplies", "Whiteboard markers", 340, "OR-0992");

  const draftReportId = insertExpenseReport.run(
    staffIds[4],
    "Sales conference - Manila",
    8000,
    "draft",
    "Awaiting remaining receipts",
    null,
    null
  ).lastInsertRowid;
  insertExpenseItem.run(draftReportId, `${year}-08-01`, "Registration", "Conference ticket", 4500, "OR-1102");

  console.log("Seed complete.");
  console.log("Login with:");
  console.log("  admin@example.com / admin123");
  console.log("  hr@example.com / hr123");
  console.log("  jamie.chen@example.com / employee123");
});

if (require.main === module) {
  seed();
}

module.exports = seed;
