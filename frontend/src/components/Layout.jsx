import { useEffect, useState, useMemo } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import { NAV_ITEMS, applyNavOrder } from "../config/navItems";
import { useAppSettings } from "../context/AppSettingsContext";
import ThemeToggle from "./ThemeToggle";

// Built per timezone rather than once at module load, so changing the setting
// re-renders the clock in the new zone instead of needing a page reload.
const makeClockFormatter = (tz) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

// The offset label beside the clock, derived rather than hardcoded — it used
// to read GMT+8 always, which would have quietly lied in any other zone.
const offsetLabel = (tz) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
};

// Shows the company's own timezone regardless of the viewer's device — it
// matches how attendance and expense timestamps are anchored server-side, so
// what's on screen agrees with what got recorded.
function TopbarClock() {
  const { timezone } = useAppSettings();
  const [now, setNow] = useState(() => new Date());
  const clockFormatter = useMemo(() => makeClockFormatter(timezone), [timezone]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="topbar-clock">
      {clockFormatter.format(now)} <span className="topbar-clock-tz">{offsetLabel(timezone)}</span>
    </div>
  );
}

// Reference FX rate beside the clock — USD against the app's currency by
// default. Rendering nothing (rather than an error) when the rate provider is
// unreachable keeps a third-party outage from putting a broken element in the
// header of every page.
function TopbarRate() {
  const [fx, setFx] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get("/exchange-rate")
        .then((d) => !cancelled && setFx(d))
        .catch(() => !cancelled && setFx(null));
    load();
    // The backend caches for an hour, so polling more often than this would
    // just return the same figure.
    const id = setInterval(load, 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!fx) return null;

  const formatted = fx.rate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const asOf = new Date(fx.fetched_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div
      className="topbar-fx"
      title={`1 ${fx.base} = ${formatted} ${fx.quote}${fx.stale ? " (last known rate — provider unreachable)" : ""}\nAs of ${asOf}`}
    >
      <span className="topbar-fx-pair">
        {fx.base}/{fx.quote}
      </span>{" "}
      <span className="topbar-fx-value">{formatted}</span>
      {fx.stale && <span className="topbar-fx-stale"> ·</span>}
    </div>
  );
}

export default function Layout({ children }) {
  const { user, employee, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const { t } = useAppSettings();
  const [logoData, setLogoData] = useState(null);
  const [companyName, setCompanyName] = useState("MARCA GROUP");
  const [navOrder, setNavOrder] = useState({});

  // Admin-defined menu order (Administration > Menu Order). Re-fetched on
  // "menu-order-updated" so a save is reflected in this sidebar immediately
  // rather than only after a full page reload.
  useEffect(() => {
    const loadOrder = () =>
      api
        .get("/nav-order")
        .then((rows) => setNavOrder(Object.fromEntries(rows.map((r) => [r.item_key, r.position]))))
        .catch(() => {});
    loadOrder();
    window.addEventListener("menu-order-updated", loadOrder);
    return () => window.removeEventListener("menu-order-updated", loadOrder);
  }, []);

  // Editable at Administration > Branding (frontend/src/pages/BrandingSettings.jsx).
  // That page fires "branding-updated" after a save so this header swaps to the
  // new logo immediately, instead of showing the stale one until a full reload.
  useEffect(() => {
    const loadLogo = () =>
      api
        .get("/branding")
        .then((data) => {
          setLogoData(data.logo_data);
          if (data.company_name) setCompanyName(data.company_name);
        })
        .catch(() => {});
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

  // A temporary page-access grant (Administration > Page Access) surfaces the
  // link even when role/department rules would hide it, and stops surfacing it
  // the moment the grant expires — page_grants only ever holds active ones.
  const pageGrants = user?.page_grants || [];
  const grantedLinks = NAV_ITEMS.filter((i) => i.pageKey && pageGrants.includes(i.pageKey));

  const linkIsVisible = (item) =>
    (item.roles.includes(user?.role) &&
      (!item.salesOnly || isSalesEmployee) &&
      (!item.financeOnly || canSeeReportsPage)) ||
    (item.pageKey && pageGrants.includes(item.pageKey));

  // Section headers are pure labels with no route of their own, so they follow
  // their own role rules — except that a section must also appear when a grant
  // has unlocked one of the links beneath it, or that link would render with
  // no heading above it.
  const sectionHasGrantedLink = (sectionName) => {
    const startIdx = NAV_ITEMS.findIndex((i) => i.section === sectionName);
    if (startIdx === -1) return false;
    for (let i = startIdx + 1; i < NAV_ITEMS.length && !NAV_ITEMS[i].section; i++) {
      if (grantedLinks.includes(NAV_ITEMS[i])) return true;
    }
    return false;
  };

  // Ordering is applied before visibility filtering so a hidden link doesn't
  // change how the ones around it are arranged.
  const orderedNavItems = applyNavOrder(NAV_ITEMS, navOrder);

  const visibleNavItems = orderedNavItems.filter((item) =>
    item.section
      ? (item.roles.includes(user?.role) &&
          (!item.salesOnly || isSalesEmployee) &&
          (!item.financeOnly || canSeeReportsPage)) ||
        sectionHasGrantedLink(item.section)
      : linkIsVisible(item)
  );

  return (
    <div className="app-shell">
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          {logoData ? (
            <img src={logoData} alt={companyName} className="brand-mark brand-mark-img" />
          ) : (
            <span className="brand-mark">{companyName.trim().charAt(0).toUpperCase() || "M"}</span>
          )}
          <span>{companyName}</span>
        </div>
        <nav>
          {visibleNavItems.map((item) =>
            item.section ? (
              <div className="nav-section" key={`section-${item.section}`}>
                <span className="nav-section-icon">{item.icon}</span>
                {t(item.section)}
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
                <span>{t(item.label)}</span>
              </NavLink>
            )
          )}
        </nav>
        {/* Which build this page is running. On a phone there is no console to
            check, and "did the fix reach me?" is otherwise unanswerable. */}
        <div
          style={{
            marginTop: "auto",
            paddingTop: 12,
            fontSize: 10.5,
            color: "#5c6172",
            letterSpacing: "0.02em",
            userSelect: "text",
          }}
          title={`Built ${__BUILD_TIME__}`}
        >
          build {__BUILD_ID__}
        </div>
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
          <TopbarRate />
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
              {t("Log out")}
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
