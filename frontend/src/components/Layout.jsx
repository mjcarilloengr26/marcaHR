import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", roles: ["admin", "hr", "employee"] },

  { section: "Workforce", roles: ["admin", "hr"] },
  { to: "/employees", label: "Employees", roles: ["admin", "hr"] },
  { to: "/departments", label: "Departments", roles: ["admin", "hr"] },
  { to: "/locations", label: "Locations", roles: ["admin", "hr"] },

  { section: "HR Operations", roles: ["admin", "hr", "employee"] },
  { to: "/leave", label: "Leave", roles: ["admin", "hr", "employee"] },
  { to: "/attendance", label: "Attendance", roles: ["admin", "hr", "employee"] },
  { to: "/payroll", label: "Payroll", roles: ["admin", "hr", "employee"] },
  { to: "/performance", label: "Performance", roles: ["admin", "hr", "employee"] },

  { section: "Collaboration", roles: ["admin", "hr", "employee"] },
  { to: "/board", label: "Task Board", roles: ["admin", "hr", "employee"] },
  { to: "/expenses", label: "Expenses", roles: ["admin", "hr", "employee"] },

  { section: "Sales", roles: ["admin", "hr"] },
  { to: "/sales", label: "Sales Dashboard", roles: ["admin", "hr"] },
  { to: "/deals", label: "Sales Opportunities", roles: ["admin", "hr"] },
  { to: "/orders", label: "Orders", roles: ["admin", "hr"] },
  { to: "/billing", label: "Billing", roles: ["admin", "hr"] },

  { section: "Fulfillment", roles: ["admin", "hr", "employee"] },
  { to: "/work-orders", label: "Work Orders", roles: ["admin", "hr", "employee"] },

  { section: "Procurement", roles: ["admin", "hr"] },
  { to: "/purchase-orders", label: "Purchase Orders", roles: ["admin", "hr"] },
  { to: "/inventory", label: "Inventory", roles: ["admin", "hr"] },

  { section: "Administration", roles: ["admin"] },
  { to: "/users", label: "Users", roles: ["admin"] },
];

export default function Layout({ children }) {
  const { user, employee, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">MARCA GROUP</div>
        <nav>
          {NAV_ITEMS.filter((item) => item.roles.includes(user?.role)).map((item) =>
            item.section ? (
              <div className="nav-section" key={`section-${item.section}`}>
                {item.section}
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </NavLink>
            )
          )}
        </nav>
      </aside>
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button
            className="menu-toggle"
            aria-label="Toggle navigation menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ☰
          </button>
          <div className="user-info">
            <span>
              <span className="user-name">{employee ? `${employee.first_name} ${employee.last_name}` : user?.email}</span>
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
