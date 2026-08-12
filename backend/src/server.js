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
const dealsRoutes = require("./routes/deals.routes");
const ordersRoutes = require("./routes/orders.routes");
const salesRoutes = require("./routes/sales.routes");
const workOrdersRoutes = require("./routes/workorders.routes");
const invoicesRoutes = require("./routes/invoices.routes");
const purchaseOrdersRoutes = require("./routes/purchaseorders.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const reportsRoutes = require("./routes/reports.routes");
const eventsRoutes = require("./routes/events.routes");
const termsRoutes = require("./routes/terms.routes");
const securityRoutes = require("./routes/security.routes");
const brandingRoutes = require("./routes/branding.routes");
const pageAccessRoutes = require("./routes/pageaccess.routes");
const navOrderRoutes = require("./routes/navorder.routes");
const { router: appSettingsRoutes } = require("./routes/appsettings.routes");
const exchangeRateRoutes = require("./routes/exchangerate.routes");

const app = express();
app.use(cors());
// Raised from Express's 100kb default so clock-in/out photo attachments
// (base64-encoded, compressed client-side) fit in the request body.
app.use(express.json({ limit: "8mb" }));

app.get("/", (req, res) => {
  res.json({ message: "MARCA GROUP API is running. See /api/health for status." });
});

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
app.use("/api/deals", dealsRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/work-orders", workOrdersRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/purchase-orders", purchaseOrdersRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/terms", termsRoutes);
app.use("/api/security-settings", securityRoutes);
app.use("/api/branding", brandingRoutes);
app.use("/api/page-access", pageAccessRoutes);
app.use("/api/nav-order", navOrderRoutes);
app.use("/api/app-settings", appSettingsRoutes);
app.use("/api/exchange-rate", exchangeRateRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await db.migrate();

  // First-boot convenience for fresh deployments where there's no interactive
  // shell to run `npm run seed` manually: seed automatically, but only when
  // the database is genuinely empty, so it never touches real data. Now that
  // storage is Supabase Postgres (persistent) rather than Render's ephemeral
  // disk, this should only ever fire on a truly first-ever boot.
  const employeeCount = (await db.prepare("SELECT COUNT(*) AS c FROM employees").get()).c;
  if (employeeCount === 0) {
    console.log("No employees found — running first-boot seed...");
    await seed();
  }

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`HR app backend listening on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
