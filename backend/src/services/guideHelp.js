// "Ask the guide": somebody types what they are trying to do, in their own
// words, and gets pointed at the tour that shows them.
//
// The model's only job is to choose an id from this catalog and write one line
// about it. It never writes the help itself — the steps live in the app, and a
// model answering freely about payroll, leave balances or what an advance owes
// would eventually invent a rule this company does not have. An id that is not
// in the catalog is thrown away, so the worst a bad answer can do is fall
// through to the keyword matcher.
//
// That matcher is not a fallback in the usual sense: with no ANTHROPIC_API_KEY
// set it answers every question, and the guide works exactly as well. The key
// only changes who picks.
//
// The titles and keywords below are the shortened half of
// frontend/src/config/guides.js, which owns the steps. They are duplicated
// rather than shared because the backend deploys on its own, without the
// frontend tree beside it. Nothing breaks if they drift: an id this side knows
// and the app does not is simply not offered, because the app looks it up in
// its own catalog before showing the button.

const GUIDES = [
  {
    id: "tour",
    title: "Find your way around",
    summary: "The sidebar: attendance, leave, payslips, expenses and where your own records live.",
    keywords: ["around", "overview", "menu", "sidebar", "where is", "what can i do", "navigate", "home", "dashboard", "first time", "new", "guide", "tour", "help", "how does this work"],
  },
  {
    id: "attendance",
    title: "Clock in and out",
    summary: "Record the start and end of a working day, with location.",
    keywords: ["clock", "clock in", "clock out", "time in", "time out", "attendance", "late", "present", "punch", "dtr", "timesheet"],
  },
  {
    id: "leave",
    title: "File a leave request",
    summary: "Request leave, see the balance left, follow the approval.",
    keywords: ["leave", "vacation", "sick", "absent", "day off", "holiday", "time off", "vl", "sl", "balance", "approval"],
  },
  {
    id: "expenses",
    title: "Claim an expense",
    summary: "File an expense report with receipts, or liquidate an advance.",
    keywords: ["expense", "expenses", "claim", "receipt", "reimburse", "reimbursement", "liquidate", "liquidation", "spent", "meal", "transport", "fare", "out of pocket"],
  },
  {
    id: "cash_advance",
    title: "Request a cash advance",
    summary: "Ask for money up front, then account for it afterwards.",
    keywords: ["cash advance", "advance", "money up front", "float", "petty cash", "borrow", "due to company", "settle", "return cash"],
  },
  {
    id: "payroll",
    title: "See your payslips",
    summary: "Open a payslip for a pay period.",
    keywords: ["payslip", "payslips", "payroll", "salary", "pay", "wage", "net pay", "deduction", "sss", "philhealth", "pagibig", "13th month"],
  },
  {
    id: "assets",
    title: "Company assets",
    summary: "What is issued to you, requesting one, returning it.",
    keywords: ["asset", "assets", "laptop", "equipment", "issued", "return", "borrow", "tool", "company property", "accountability"],
  },
  {
    id: "board",
    title: "Use the task board",
    summary: "See and move the work assigned to you.",
    keywords: ["task", "tasks", "board", "kanban", "todo", "to do", "assignment", "work on", "project task"],
  },
  {
    id: "reports",
    title: "Export reports",
    summary: "Download Excel and PDF reports for a period.",
    keywords: ["report", "reports", "export", "excel", "xlsx", "pdf", "download", "period", "summary", "finance"],
  },
  {
    id: "admin",
    title: "Set the portal up (admin)",
    summary: "Accounts, page access, categories, branding and security.",
    keywords: ["admin", "administration", "user", "users", "account", "permission", "access", "role", "setting", "settings", "branding", "security", "category"],
  },
];

const GUIDE_IDS = GUIDES.map((g) => g.id);
const byId = (id) => GUIDES.find((g) => g.id === id) || null;

// Scored on whole words, not substrings: "pay" must not match inside
// "company", and a two-word phrase is worth more than a single word because it
// is far less likely to be a coincidence.
function matchGuide(question) {
  const q = ` ${String(question).toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ")} `;
  let best = null;
  for (const g of GUIDES) {
    let score = 0;
    for (const k of g.keywords) if (q.includes(` ${k} `) || q.includes(` ${k}`)) score += k.includes(" ") ? 3 : 2;
    for (const w of g.title.toLowerCase().split(" ")) if (w.length > 3 && q.includes(` ${w}`)) score += 1;
    if (score > (best?.score ?? 0)) best = { id: g.id, score };
  }
  return best?.id ?? null;
}

function byKeywords(question) {
  const id = matchGuide(question);
  const guide = id ? byId(id) : null;
  return {
    guide_id: id,
    answer: guide
      ? `Let me show you: ${guide.title.toLowerCase()}.`
      : "I could not find that one. Try asking about clocking in, filing leave, your payslip, an expense claim or a cash advance.",
    source: "rules",
  };
}

const SYSTEM = `You are the quick guide inside the MARCA GROUP staff portal, a company system where employees clock in and out, file leave, read their payslips, claim expenses and account for cash advances, and where admin and HR run payroll, sales, projects and reports.

A member of staff asks how to do something. Choose the ONE guide from the catalog that best answers it, and write a short, warm reply (at most 25 words) saying what you are about to show them. If nothing in the catalog fits, use guide_id "none" and say in one line what the portal can help with.

Never invent a feature, a figure, an entitlement, a deadline or a company policy. You do not know this person's leave balance, salary or records, and must not guess at them — point at the page where they can see it. Reply in the language of the question, Filipino included. Reply with JSON only: {"guide_id": "...", "answer": "..."}.

CATALOG:
${GUIDES.map((g) => `- ${g.id}: ${g.title} — ${g.summary}`).join("\n")}`;

async function askClaude(question) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    // Plain fetch rather than the SDK: one request, one shape, and no new
    // dependency on a backend that has no AI client otherwise. A slow answer is
    // worse than a keyword one, so it gives up after eight seconds.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        // Haiku is right for this: it picks one id out of ten and writes a
        // line, which is a routing job, not a writing one. The current Haiku
        // is also about a tenth the price of the one this first named.
        model: process.env.GUIDE_MODEL || "claude-haiku-5-5",
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: "user", content: String(question).slice(0, 300) }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const body = await res.json();
    const text = (body.content || []).find((b) => b.type === "text")?.text || "";
    // Tolerate a model that wraps its JSON in prose or a code fence.
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const answer = String(parsed.answer || "").trim();
    if (!answer || answer.length > 400) throw new Error("unusable answer");
    const id = parsed.guide_id === "none" ? null : parsed.guide_id;
    if (id && !byId(id)) throw new Error(`unknown guide ${id}`);
    return { guide_id: id ?? null, answer, source: "ai" };
  } catch (err) {
    // Logged, never surfaced: the person gets a keyword answer either way, and
    // "the AI is down" is not a useful thing to read when you wanted the leave form.
    console.error("[guide] falling back to keywords:", err.message);
    return null;
  }
}

async function answerGuideQuestion(question) {
  return (await askClaude(question)) || byKeywords(question);
}

module.exports = { GUIDES, GUIDE_IDS, matchGuide, answerGuideQuestion };
