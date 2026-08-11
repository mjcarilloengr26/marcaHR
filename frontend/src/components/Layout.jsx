import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import ThemeToggle from "./ThemeToggle";

const MANILA_TZ = "Asia/Manila";
const clockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MANILA_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// Always Philippine time regardless of the viewer's own device timezone —
// matches how attendance/leave/expense timestamps are anchored server-side,
// so what's on screen agrees with what got recorded.
function TopbarClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="topbar-clock">
      {clockFormatter.format(now)} <span className="topbar-clock-tz">GMT+8</span>
    </div>
  );
}

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "🏠", roles: ["admin", "hr", "employee"] },

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

  { section: "Sales", icon: "💹", roles: ["admin", "hr", "employee"], salesOnly: true },
  { to: "/sales", label: "Dashboard", icon: "📊", roles: ["admin", "hr"] },
  { to: "/deals", label: "Opportunities", icon: "🎯", roles: ["admin", "hr", "employee"], salesOnly: true },
  { to: "/billing", label: "Billing", icon: "💳", roles: ["admin", "hr"] },
  { to: "/orders", label: "Orders", icon: "🛍️", roles: ["admin", "hr"] },

  { section: "Fulfillment", icon: "🚚", roles: ["admin", "hr", "employee"] },
  { to: "/work-orders", label: "Work Orders", icon: "🔧", roles: ["admin", "hr", "employee"] },

  { section: "Procurement", icon: "🛒", roles: ["admin", "hr"] },
  { to: "/purchase-orders", label: "Purchase Orders", icon: "📝", roles: ["admin", "hr"] },
  { to: "/inventory", label: "Inventory", icon: "📦", roles: ["admin", "hr"] },

  { section: "Reports", icon: "📤", roles: ["admin", "hr", "employee"], financeOnly: true },
  { to: "/reports", label: "Export Reports", icon: "📤", roles: ["admin", "hr", "employee"], financeOnly: true },

  { section: "Administration", icon: "⚙️", roles: ["admin"] },
  { to: "/users", label: "Users", icon: "👤", roles: ["admin"] },
  { to: "/events", label: "Events", icon: "📜", roles: ["admin"] },
  { to: "/terms-settings", label: "Terms & Conditions", icon: "📄", roles: ["admin"] },
  { to: "/security-settings", label: "Security", icon: "🔒", roles: ["admin"] },
  { to: "/branding-settings", label: "Branding", icon: "🖼️", roles: ["admin"] },
];

export default function Layout({ children }) {
  const { user, employee, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoData, setLogoData] = useState(null);

  // Editable at Administration > Branding (frontend/src/pages/BrandingSettings.jsx).
  // That page fires "branding-updated" after a save so this header swaps to the
  // new logo immediately, instead of showing the stale one until a full reload.
  useEffect(() => {
    const loadLogo = () =>
      api.get("/branding").then((data) => setLogoData(data.logo_data)).catch(() => {});
    loadLogo();
    window.addEventListener("branding-updated", loadLogo);
    return () => window.removeEventListener("branding-updated", loadLogo);
  }, []);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  // Sales Opportunities is HR/admin territory plus reps who are actually in
  // Sales (by department or job title) — an employee outside Sales shouldn't
  // even see the link, matching what the backend will let them access.
  const isSalesEmployee =
    user?.role !== "employee" ||
    (employee?.department_name || "").toLowerCase().includes("sales") ||
    (employee?.position || "").toLowerCase().includes("sales");

  // The Sales & Finance export is Admin/Finance territory specifically —
  // unlike Sales above, HR doesn't get blanket access here, only admin or an
  // employee (of any role) who's actually in Finance by department or job
  // title. The Reports page itself is visible more broadly (also to HR, since
  // it now hosts the payroll export too) — the page decides section-by-section
  // which of its exports each visitor can actually use.
  const isFinanceOrAdmin =
    user?.role === "admin" ||
    (employee?.department_name || "").toLowerCase().includes("finance") ||
    (employee?.position || "").toLowerCase().includes("finance");
  const canSeeReportsPage = isFinanceOrAdmin || user?.role === "hr";

  const visibleNavItems = NAV_ITEMS.filter(
    (item) =>
      item.roles.includes(user?.role) &&
      (!item.salesOnly || isSalesEmployee) &&
      (!item.financeOnly || canSeeReportsPage)
  );

  return (
    <div className="app-shell">
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          {logoData ? (
            <img src={logoData} alt="MARCA GROUP" className="brand-mark brand-mark-img" />
          ) : (
            <span className="brand-mark">M</span>
          )}
          <span>MARCA GROUP</span>
        </div>
        <nav>
          {visibleNavItems.map((item) =>
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
          <TopbarClock />
          <div className="user-info">
            <ThemeToggle />
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
