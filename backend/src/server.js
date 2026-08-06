require("dotenv").config();
const express = require("express");
const cors = require("cors");

const db = require("./db");
const seed = require("./seed");

const authRoutes = require("./routes/auth.routes");
const employeeRoutes = require("./routes/employees.routes");
const departmentRoutes = require("./routes/departments.routes");
const leaveRoutes = require("./routes/leave.routes");
const attendanceRoutes = require("./routes/attendance.routes");
const payrollRoutes = require("./routes/payroll.routes");
const performanceRoutes = require("./routes/performance.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const usersRoutes = require("./routes/users.routes");
const boardRoutes = require("./routes/board.routes");
const expensesRoutes = require("./routes/expenses.routes");
const locationsRoutes = require("./routes/locations.routes");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/performance", performanceRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/board", boardRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/locations", locationsRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// First-boot convenience for fresh deployments (e.g. Render) where there's no
// interactive shell to run `npm run seed` manually: seed automatically, but only
// when the database is genuinely empty, so it never touches real data.
const employeeCount = db.prepare("SELECT COUNT(*) AS c FROM employees").get().c;
if (employeeCount === 0) {
  console.log("No employees found — running first-boot seed...");
  seed();
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HR app backend listening on http://localhost:${PORT}`));
