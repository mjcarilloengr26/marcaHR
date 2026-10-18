// The quick guide's catalog: short tours that point a hand at the real button,
// and the fixed list the "ask in your own words" helper chooses from.
//
// The help happens on the screen somebody is already on, rather than in a
// manual they would have to go and find. One tour runs by itself, the first
// time a person lands in the portal after signing in; the rest answer a
// question when it comes up.
//
// Nothing here runs before sign-in. An earlier version walked through the
// login form itself, which meant the portal described its own insides — which
// roles exist, which page each one lands on — to anybody who opened the URL.
// A guide is for people who are already in.
//
// `target` is a CSS selector for something already on the page. Sidebar links
// are addressed by href because they are there on every screen and the sidebar
// already hides what a role may not open. The handful of buttons that had no
// stable selector carry a `data-tour` attribute, added at the button itself.
//
// `roles` keeps a step out of a tour for somebody who would never find it —
// an employee has no Users page, and pointing at a link their sidebar does not
// draw would be worse than saying nothing.

const ASK = {
  title: "Ask me anything else",
  text: "Type what you are trying to do — “how do I file my leave?” — and I will take you to it.",
  ask: true,
};

export const GUIDES = [
  {
    id: "tour",
    title: "Find your way around",
    summary: "The sidebar: attendance, leave, payslips, expenses and where your own records live.",
    keywords: ["around", "overview", "menu", "sidebar", "where is", "what can i do", "navigate", "home", "dashboard", "first time", "new"],
    steps: [
      {
        title: "Welcome to the portal",
        text: "This is where you land when you sign in. Let me point out the parts of the sidebar you will use most.",
      },
      { target: 'a[href="/attendance"]', title: "Attendance", text: "Clock in when you start and out when you finish. Your location is recorded with each punch." },
      { target: 'a[href="/leave"]', title: "Leave", text: "File leave and follow whether it was approved. Your remaining balance is shown as you file." },
      { target: 'a[href="/payroll"]', title: "Payroll", text: "Your payslips, period by period." },
      { target: 'a[href="/expenses"]', title: "Expenses", text: "Claim what you spent, and liquidate a cash advance with receipts." },
      { target: 'a[href="/cash-advances"]', title: "Cash Advances", text: "Ask for money up front for a job, and see what is still to account for." },
      { target: 'a[href="/board"]', title: "Task Board", text: "What you and the team are working on." },
      {
        target: 'a[href="/snapshot"]',
        roles: ["admin", "hr"],
        title: "Snapshot",
        text: "The company at a glance — headcount, money in and out, what is overdue.",
      },
      ASK,
    ],
  },
  {
    id: "attendance",
    title: "Clock in and out",
    summary: "Record the start and end of a working day, with location and photo.",
    keywords: ["clock", "clock in", "clock out", "time in", "time out", "attendance", "late", "present", "punch", "dtr", "timesheet"],
    steps: [
      { route: "/attendance", target: '[data-tour="clock-in"]', title: "Clock in", text: "One press when you start. Your GPS location is recorded with it, so do it where you actually are." },
      { title: "And at the end of the day", text: "The same button becomes Clock out. A day with no clock-out stays open, and HR sees it as unfinished rather than absent." },
    ],
  },
  {
    id: "leave",
    title: "File a leave request",
    summary: "Request leave, see your remaining balance, and follow the approval.",
    keywords: ["leave", "vacation", "sick", "absent", "day off", "holiday", "time off", "vl", "sl", "balance", "approval"],
    steps: [
      { route: "/leave", target: '[data-tour="new-leave"]', title: "Request leave", text: "Pick the type and the dates. Your remaining balance for that type is shown as you fill it in." },
      { title: "After you send it", text: "It sits as pending until admin or HR decides. You are e-mailed either way, and a rejected request can be corrected and resubmitted rather than retyped." },
    ],
  },
  {
    id: "expenses",
    title: "Claim an expense",
    summary: "File an expense report with receipts, or liquidate a cash advance.",
    keywords: ["expense", "expenses", "claim", "receipt", "reimburse", "reimbursement", "liquidate", "liquidation", "spent", "meal", "transport", "fare", "out of pocket"],
    steps: [
      {
        route: "/expenses",
        target: '[data-tour="new-report"]',
        title: "Start a report",
        text: "One report holds the lines for one trip or one period. Add a line per receipt: date, category, supplier and amount.",
      },
      {
        title: "Against an advance, or out of pocket",
        text: "If the money came from a cash advance, pick that advance and the report liquidates it. If you paid yourself, leave it out and the company owes you the total.",
      },
      {
        title: "Receipts, and claiming twice",
        text: "Attach the receipt photo, or mark the line as having none. If a line matches one you already claimed, the form says so while you type it.",
      },
    ],
  },
  {
    id: "cash_advance",
    title: "Request a cash advance",
    summary: "Ask for money up front, then account for it with an expense report.",
    keywords: ["cash advance", "advance", "ca", "money up front", "float", "petty cash", "borrow", "due to company", "settle", "return cash"],
    steps: [
      { route: "/cash-advances", target: '[data-tour="new-advance"]', title: "Ask for an advance", text: "Say how much and what it is for. It stays as requested until admin or HR releases the money." },
      {
        title: "Accounting for it afterwards",
        text: "File an expense report against the advance for what you spent, and hand back whatever is left. Spend more than you were given and the company owes you the difference.",
      },
    ],
  },
  {
    id: "payroll",
    title: "See your payslips",
    summary: "Open a payslip for a pay period and download it.",
    keywords: ["payslip", "payslips", "payroll", "salary", "pay", "wage", "net pay", "deduction", "sss", "philhealth", "pagibig", "13th month"],
    steps: [{ route: "/payroll", title: "Your payslips", text: "Each pay period shows your gross, the deductions and your net. Older periods are under Past records." }],
  },
  {
    id: "assets",
    title: "Company assets",
    summary: "What is issued to you, how to request something and how to return it.",
    keywords: ["asset", "assets", "laptop", "equipment", "issued", "return", "borrow", "tool", "company property", "accountability"],
    steps: [{ route: "/assets", title: "Assets", text: "What is signed out to you, with a request form for something new and a return when you hand it back." }],
  },
  {
    id: "board",
    title: "Use the task board",
    summary: "See and move the work assigned to you.",
    keywords: ["task", "tasks", "board", "kanban", "todo", "to do", "assignment", "work on", "project task"],
    steps: [{ route: "/board", title: "Task Board", text: "Cards are work; the columns are how far along it is. Drag a card to move it, or open it to add a note." }],
  },
  {
    id: "reports",
    title: "Export reports",
    summary: "Download Excel and PDF reports for a period.",
    roles: ["admin", "hr"],
    keywords: ["report", "reports", "export", "excel", "xlsx", "pdf", "download", "period", "summary", "finance"],
    steps: [
      {
        route: "/reports",
        roles: ["admin", "hr"],
        title: "Export Reports",
        text: "Choose a period and a report. Expenses, payroll and cash advances each come out as a workbook you can hand to finance.",
      },
    ],
  },
  {
    id: "admin",
    title: "Set the portal up (admin)",
    summary: "Accounts, who may open which page, categories, branding and security.",
    roles: ["admin"],
    keywords: ["admin", "administration", "user", "users", "account", "permission", "access", "role", "setting", "settings", "branding", "security", "category"],
    steps: [
      { route: "/users", roles: ["admin"], title: "Users", text: "Create an account for a member of staff and choose their role: admin, HR or employee." },
      { route: "/users", roles: ["admin"], target: 'a[href="/page-access"]', title: "Page Access", text: "Open one page to one person for a while, without changing their role." },
      { route: "/users", roles: ["admin"], target: 'a[href="/events"]', title: "Events", text: "Who did what, and when. Deletions and approvals are all recorded here." },
    ],
  },
];

export const GUIDE_IDS = GUIDES.map((g) => g.id);
export const guideById = (id) => GUIDES.find((g) => g.id === id) || null;

/** The steps of a guide that this role can actually follow. */
export function stepsFor(guide, role) {
  if (!guide) return [];
  return guide.steps.filter((s) => !s.roles || s.roles.includes(role));
}

/** The guides worth offering to this role. */
export function guidesFor(role) {
  return GUIDES.filter((g) => (!g.roles || g.roles.includes(role)) && stepsFor(g, role).length > 0);
}
