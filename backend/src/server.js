require("dotenv").config();
const express = require("express");
const cors = require("cors");

const db = require("./db");
const { scheduleStaleDealDigest } = require("./services/staleDealDigest");
const { scheduleBusinessReviews } = require("./services/businessReviewSchedule");
const { firstRunSetup } = require("./firstRun");

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
// Restricted to the front ends that are meant to call this API. Left open
// when CORS_ORIGIN is unset so a fresh clone still runs locally without
// configuration — but a deployed install should always set it, and says so
// loudly at boot if it hasn't.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (corsOrigins.length === 0) {
  console.warn(
    "WARNING: CORS_ORIGIN is not set — this API will accept browser requests from any site. " +
      "Set it to your front end's URL (comma-separated for more than one)."
  );
  app.use(cors());
} else {
  console.log(`CORS restricted to: ${corsOrigins.join(", ")}`);
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header at all means a same-origin or non-browser caller
        // (curl, a health check, a mobile app) — CORS is not what guards those,
        // authentication is, so they are not the thing to block here.
        if (!origin || corsOrigins.includes(origin)) return callback(null, true);
        // Refuse by simply not sending the allow header, rather than throwing.
        // The browser blocks the response either way, but throwing turned every
        // probe from an unknown origin into a logged 500, which buries real
        // errors and misreports a working policy as a server fault.
        return callback(null, false);
      },
    })
  );
}
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
app.use("/api/assets", require("./routes/assets.routes"));
app.use("/api/asset-requests", require("./routes/assetRequests.routes"));
app.use("/api/asset-returns", require("./routes/assetReturns.routes"));
app.use("/api/business-review", require("./routes/businessreview.routes"));
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/board", boardRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/cash-advances", require("./routes/cashadvances.routes"));
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
app.use("/api/server-status", require("./routes/serverstatus.routes"));
app.use("/api/suggestions", require("./routes/suggestions.routes").router);
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

  // Sets up an empty database: one administrator by default, or the full
  // demonstration dataset when SEED_DEMO_DATA is explicitly enabled. Does
  // nothing at all once any user exists.
  await firstRunSetup();

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`HR app backend listening on http://localhost:${PORT}`));

  // Open the first Postgres connection now rather than letting the first real
  // request pay for it. The migration above already does this in practice, but
  // keeping the warm-up explicit means it survives that changing.
  db.prepare("SELECT 1 AS ok").get().catch(() => {});

  keepWarm();
  scheduleStaleDealDigest();
  scheduleBusinessReviews();
}

// Render's free plan stops the instance after ~15 minutes with no inbound
// traffic, and the next visitor then waits out a 30-60s cold boot — which
// lands squarely on whoever is trying to sign in. A request to our own public
// URL counts as inbound traffic as far as Render is concerned, so pinging
// ourselves inside that window keeps the instance up.
//
// Set KEEP_WARM_URL to the service's public URL to enable it. Leave it unset
// on any paid plan, which never sleeps, so the app is not making pointless
// requests to itself. Note that this holds the instance awake around the
// clock and so spends the monthly free instance-hour allowance.
function keepWarm() {
  const base = process.env.KEEP_WARM_URL;
  if (!base) return;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const url = trimmed + "/api/health";
  const PING_EVERY_MS = 10 * 60 * 1000; // comfortably inside the ~15 minute window
  console.log(`Keep-warm ping enabled: ${url} every ${PING_EVERY_MS / 60000} min`);
  setInterval(() => {
    fetch(url).catch((err) => console.error("Keep-warm ping failed:", err.message));
  }, PING_EVERY_MS).unref();
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
