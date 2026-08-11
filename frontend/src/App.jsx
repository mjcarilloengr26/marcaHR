import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";

// Route-level code splitting: each page (and whatever it imports — notably
// Attendance's face-api.js/TensorFlow dependency, several hundred KB on its
// own) becomes its own chunk, fetched only when that route is actually
// visited, instead of every page's code loading upfront in one bundle on
// every first paint regardless of which page someone lands on.
const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Employees = lazy(() => import("./pages/Employees"));
const EmployeeDetail = lazy(() => import("./pages/EmployeeDetail"));
const Departments = lazy(() => import("./pages/Departments"));
const Locations = lazy(() => import("./pages/Locations"));
const Leave = lazy(() => import("./pages/Leave"));
const Attendance = lazy(() => import("./pages/Attendance"));
const Payroll = lazy(() => import("./pages/Payroll"));
const Performance = lazy(() => import("./pages/Performance"));
const Board = lazy(() => import("./pages/Board"));
const Expenses = lazy(() => import("./pages/Expenses"));
const SalesDashboard = lazy(() => import("./pages/SalesDashboard"));
const Deals = lazy(() => import("./pages/Deals"));
const Orders = lazy(() => import("./pages/Orders"));
const WorkOrders = lazy(() => import("./pages/WorkOrders"));
const Billing = lazy(() => import("./pages/Billing"));
const PurchaseOrders = lazy(() => import("./pages/PurchaseOrders"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Users = lazy(() => import("./pages/Users"));
const Reports = lazy(() => import("./pages/Reports"));
const Events = lazy(() => import("./pages/Events"));
const TermsSettings = lazy(() => import("./pages/TermsSettings"));
const SecuritySettings = lazy(() => import("./pages/SecuritySettings"));

function Protected({ children, roles }) {
  return (
    <ProtectedRoute roles={roles}>
      <Layout>{children}</Layout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Suspense fallback={<div className="page-loading">Loading…</div>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected><Dashboard /></Protected>} />
        <Route path="/employees" element={<Protected roles={["admin", "hr"]}><Employees /></Protected>} />
        <Route path="/employees/:id" element={<Protected roles={["admin", "hr"]}><EmployeeDetail /></Protected>} />
        <Route path="/departments" element={<Protected roles={["admin", "hr"]}><Departments /></Protected>} />
        <Route path="/locations" element={<Protected roles={["admin", "hr"]}><Locations /></Protected>} />
        <Route path="/leave" element={<Protected><Leave /></Protected>} />
        <Route path="/attendance" element={<Protected><Attendance /></Protected>} />
        <Route path="/payroll" element={<Protected><Payroll /></Protected>} />
        <Route path="/performance" element={<Protected><Performance /></Protected>} />
        <Route path="/board" element={<Protected><Board /></Protected>} />
        <Route path="/expenses" element={<Protected><Expenses /></Protected>} />
        <Route path="/sales" element={<Protected roles={["admin", "hr"]}><SalesDashboard /></Protected>} />
        <Route path="/deals" element={<Protected roles={["admin", "hr", "employee"]}><Deals /></Protected>} />
        <Route path="/orders" element={<Protected roles={["admin", "hr"]}><Orders /></Protected>} />
        <Route path="/work-orders" element={<Protected><WorkOrders /></Protected>} />
        <Route path="/billing" element={<Protected roles={["admin", "hr"]}><Billing /></Protected>} />
        <Route path="/purchase-orders" element={<Protected roles={["admin", "hr"]}><PurchaseOrders /></Protected>} />
        <Route path="/inventory" element={<Protected roles={["admin", "hr"]}><Inventory /></Protected>} />
        <Route path="/users" element={<Protected roles={["admin"]}><Users /></Protected>} />
        <Route path="/events" element={<Protected roles={["admin"]}><Events /></Protected>} />
        <Route path="/terms-settings" element={<Protected roles={["admin"]}><TermsSettings /></Protected>} />
        <Route path="/security-settings" element={<Protected roles={["admin"]}><SecuritySettings /></Protected>} />
        <Route path="/reports" element={<Protected><Reports /></Protected>} />
      </Routes>
    </Suspense>
  );
}
