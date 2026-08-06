import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", roles: ["admin", "hr", "employee"] },
  { to: "/employees", label: "Employees", roles: ["admin", "hr"] },
  { to: "/departments", label: "Departments", roles: ["admin", "hr"] },
  { to: "/leave", label: "Leave", roles: ["admin", "hr", "employee"] },
  { to: "/attendance", label: "Attendance", roles: ["admin", "hr", "employee"] },
  { to: "/payroll", label: "Payroll", roles: ["admin", "hr", "employee"] },
  { to: "/performance", label: "Performance", roles: ["admin", "hr", "employee"] },
  { to: "/board", label: "Task Board", roles: ["admin", "hr", "employee"] },
  { to: "/expenses", label: "Expenses", roles: ["admin", "hr", "employee"] },
  { to: "/users", label: "Users", roles: ["admin"] },
];

export default function Layout({ children }) {
  const { user, employee, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">MARCA Group HR</div>
        <nav>
          {NAV_ITEMS.filter((item) => item.roles.includes(user?.role)).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div />
          <div className="user-info">
            <span>
              {employee ? `${employee.first_name} ${employee.last_name}` : user?.email}
              <span className="role-badge">{user?.role}</span>
            </span>
            <button className="btn btn-secondary" onClick={handleLogout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
