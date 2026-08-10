import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Employees from "./pages/Employees";
import EmployeeDetail from "./pages/EmployeeDetail";
import Departments from "./pages/Departments";
import Locations from "./pages/Locations";
import Leave from "./pages/Leave";
import Attendance from "./pages/Attendance";
import Payroll from "./pages/Payroll";
import Performance from "./pages/Performance";
import Board from "./pages/Board";
import Expenses from "./pages/Expenses";
import SalesDashboard from "./pages/SalesDashboard";
import Deals from "./pages/Deals";
import Orders from "./pages/Orders";
import WorkOrders from "./pages/WorkOrders";
import Billing from "./pages/Billing";
import PurchaseOrders from "./pages/PurchaseOrders";
import Inventory from "./pages/Inventory";
import Users from "./pages/Users";
import Reports from "./pages/Reports";
import Events from "./pages/Events";

function Protected({ children, roles }) {
  return (
    <ProtectedRoute roles={roles}>
      <Layout>{children}</Layout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
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
      <Route path="/reports" element={<Protected><Reports /></Protected>} />
    </Routes>
  );
}
