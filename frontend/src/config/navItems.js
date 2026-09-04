// Single source of truth for the sidebar menu, shared by the sidebar itself
// (components/Layout.jsx) and the admin reordering screen
// (pages/MenuOrder.jsx) so the two can never drift.
//
// `to` doubles as each link's stable key for saved ordering — it's already
// unique and, unlike the label, it won't change if the wording is reworded.
export const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "🏠", roles: ["admin", "hr", "employee"] },

  { section: "Workforce", icon: "👥", roles: ["admin", "hr"] },
  { to: "/employees", label: "Employees", icon: "🧑‍💼", roles: ["admin", "hr"], pageKey: "employees" },
  { to: "/departments", label: "Departments", icon: "🏢", roles: ["admin", "hr"], pageKey: "departments" },
  { to: "/locations", label: "Locations", icon: "📍", roles: ["admin", "hr"], pageKey: "locations" },

  { section: "HR Operations", icon: "🗂️", roles: ["admin", "hr", "employee"] },
  { to: "/leave", label: "Leave", icon: "🌴", roles: ["admin", "hr", "employee"] },
  { to: "/attendance", label: "Attendance", icon: "⏱️", roles: ["admin", "hr", "employee"] },
  { to: "/payroll", label: "Payroll", icon: "💵", roles: ["admin", "hr", "employee"] },
  { to: "/performance", label: "Performance", icon: "📈", roles: ["admin", "hr", "employee"] },
  { to: "/assets", label: "Company Assets", icon: "💼", roles: ["admin", "hr", "employee"] },

  { section: "Collaboration", icon: "🤝", roles: ["admin", "hr", "employee"] },
  { to: "/board", label: "Task Board", icon: "🗒️", roles: ["admin", "hr", "employee"] },
  { to: "/cash-advances", label: "Cash Advances", icon: "💵", roles: ["admin", "hr", "employee"] },
  { to: "/expenses", label: "Expenses", icon: "🧾", roles: ["admin", "hr", "employee"] },

  { section: "Sales", icon: "💹", roles: ["admin", "hr", "employee"], salesOnly: true },
  { to: "/sales", label: "Dashboard", icon: "📊", roles: ["admin", "hr"], pageKey: "sales" },
  { to: "/deals", label: "Opportunities", icon: "🎯", roles: ["admin", "hr", "employee"], salesOnly: true, pageKey: "deals" },
  { to: "/billing", label: "Billing", icon: "💳", roles: ["admin", "hr"], pageKey: "billing" },
  { to: "/orders", label: "Orders", icon: "🛍️", roles: ["admin", "hr"], pageKey: "orders" },

  { section: "Fulfillment", icon: "🚚", roles: ["admin", "hr", "employee"] },
  { to: "/work-orders", label: "Work Orders", icon: "🔧", roles: ["admin", "hr", "employee"], pageKey: "work-orders" },

  { section: "Procurement", icon: "🛒", roles: ["admin", "hr"] },
  { to: "/purchase-orders", label: "Purchase Orders", icon: "📝", roles: ["admin", "hr"], pageKey: "purchase-orders" },
  { to: "/inventory", label: "Inventory", icon: "📦", roles: ["admin", "hr"], pageKey: "inventory" },

  { section: "Reports", icon: "📤", roles: ["admin", "hr", "employee"], financeOnly: true },
  { to: "/business-review", label: "Business Review", icon: "🧭", roles: ["admin"] },
  { to: "/reports", label: "Export Reports", icon: "📤", roles: ["admin", "hr", "employee"], financeOnly: true, pageKey: "reports" },

  { section: "Administration", icon: "⚙️", roles: ["admin"] },
  { to: "/users", label: "Users", icon: "👤", roles: ["admin"] },
  { to: "/events", label: "Events", icon: "📜", roles: ["admin"] },
  { to: "/page-access", label: "Page Access", icon: "🕒", roles: ["admin"] },
  { to: "/menu-order", label: "Menu Order", icon: "↕️", roles: ["admin"] },
  { to: "/terms-settings", label: "Terms & Conditions", icon: "📄", roles: ["admin"] },
  { to: "/security-settings", label: "Security", icon: "🔒", roles: ["admin"] },
  { to: "/branding-settings", label: "Branding", icon: "🖼️", roles: ["admin"] },
  { to: "/localization", label: "Localization", icon: "🌐", roles: ["admin"] },
  { to: "/review-schedule", label: "Review Schedule", icon: "🗓️", roles: ["admin"] },
];

// Splits the flat list into [{ section, links: [...] }]. The leading
// "Overview" link has no section above it, so it lands in a headerless first
// group (section: null) that renders bare and isn't reorderable.
export function groupNavItems(items = NAV_ITEMS) {
  const groups = [{ section: null, sectionItem: null, links: [] }];
  for (const item of items) {
    if (item.section) groups.push({ section: item.section, sectionItem: item, links: [] });
    else groups[groups.length - 1].links.push(item);
  }
  return groups.filter((g) => g.links.length > 0 || g.section);
}

// Applies a saved order (a map of link key -> position) *within each section*
// only. Reordering is deliberately scoped this way: a link's section decides
// which heading it sits under, so allowing a cross-section move would silently
// re-file it under a heading that no longer describes it. Anything without a
// saved position keeps its original relative place, after the ordered ones, so
// a newly added menu item still appears rather than vanishing.
export function applyNavOrder(items = NAV_ITEMS, orderByKey = {}) {
  const groups = groupNavItems(items);
  const out = [];
  for (const g of groups) {
    if (g.sectionItem) out.push(g.sectionItem);
    const sorted = [...g.links].sort((a, b) => {
      const pa = orderByKey[a.to];
      const pb = orderByKey[b.to];
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });
    out.push(...sorted);
  }
  return out;
}
