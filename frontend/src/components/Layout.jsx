import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: "🏠", roles: ["admin", "hr", "employee"] },

  { section: "Workforce", icon: "👥", roles: ["admin", "hr"] },
  { to: "/employees", label: "Employees", icon: "🧑‍💼", roles: ["admin", "hr"] },
  { to: "/departments", label: "Departments", icon: "🏢", roles: ["admin", "hr"] },
  { to: "/locations", label: "Locations", icon: "📍", roles: ["admin", "hr"] },

  { section: "HR Operations", icon: "🗂️", roles: ["admin", "hr", "employee"] },
  { to: "/leave", label: "Leave", icon: "🌴", roles: ["admin", "hr", "employee"] },
  { to: "/attendance", label: "Attendance", icon: "⏱️", roles: ["admin", "hr", "employee"] },
  { to: "/payroll", label: "Payroll", icon: "💵", roles: ["admin", "hr", "employee"] },
  { to: "/performance", label: "Performance", icon: "📈", roles: ["admin", "hr", "employee"] },

  { section: "Collaboration", icon: "🤝", roles: ["admin", "hr", "employee"] },
  { to: "/board", label: "Task Board", icon: "🗒️", roles: ["admin", "hr", "employee"] },
  { to: "/expenses", label: "Expenses", icon: "🧾", roles: ["admin", "hr", "employee"] },

  { section: "Sales", icon: "💹", roles: ["admin", "hr"] },
  { to: "/sales", label: "Sales Dashboard", icon: "📊", roles: ["admin", "hr"] },
  { to: "/deals", label: "Sales Opportunities", icon: "🎯", roles: ["admin", "hr"] },
  { to: "/orders", label: "Orders", icon: "🛍️", roles: ["admin", "hr"] },
  { to: "/billing", label: "Billing", icon: "💳", roles: ["admin", "hr"] },

  { section: "Fulfillment", icon: "🚚", roles: ["admin", "hr", "employee"] },
  { to: "/work-orders", label: "Work Orders", icon: "🔧", roles: ["admin", "hr", "employee"] },

  { section: "Procurement", icon: "🛒", roles: ["admin", "hr"] },
  { to: "/purchase-orders", label: "Purchase Orders", icon: "📝", roles: ["admin", "hr"] },
  { to: "/inventory", label: "Inventory", icon: "📦", roles: ["admin", "hr"] },

  { section: "Administration", icon: "⚙️", roles: ["admin"] },
  { to: "/users", label: "Users", icon: "👤", roles: ["admin"] },
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
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>MARCA GROUP</span>
        </div>
        <nav>
          {NAV_ITEMS.filter((item) => item.roles.includes(user?.role)).map((item) =>
            item.section ? (
              <div className="nav-section" key={`section-${item.section}`}>
                <span className="nav-section-icon">{item.icon}</span>
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
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
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
            {employee?.photo ? (
              <img className="topbar-avatar" src={employee.photo} alt="" />
            ) : (
              <div className="topbar-avatar topbar-avatar-fallback">
                {employee ? `${employee.first_name[0]}${employee.last_name[0]}` : (user?.email?.[0] || "?").toUpperCase()}
              </div>
            )}
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
