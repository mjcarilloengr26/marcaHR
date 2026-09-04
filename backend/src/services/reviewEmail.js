// The emailed form of a business review.
//
// Email is not a browser: no external stylesheets, no flexbox or grid, no
// script, and no images we would have to host. So the layout is tables with
// inline styles, and the one chart is drawn with table cells that have
// background colours and percentage widths — which every mail client since
// the 1990s renders correctly.
//
// Both parts are sent. The HTML leads with the figures and the summary so the
// review can be read on a phone without scrolling; the plain-text alternative
// carries the same content for clients that refuse HTML.

// Categorical hues for the three cost categories. Checked for adjacent-pair
// separation in OKLab under normal vision and protan/deutan/tritan simulation,
// and for contrast against white — not chosen by eye.
const COST_COLOURS = {
  procurement: "#1f6feb",
  payroll: "#c2410c",
  operatingExpenses: "#0f766e",
};
const RETAINED = "#4b5563";
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const CARD = "#ffffff";
const PAGE = "#f4f5f7";
const GOOD = "#15803d";
const BAD = "#b91c1c";
const WARN_BG = "#fef3c7";
const WARN_INK = "#92400e";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function peso(n) {
  const v = Number(n || 0);
  const rounded = Math.round(v * 100) / 100;
  return (
    "PHP " +
    rounded.toLocaleString("en-PH", {
      minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

// Percentage change, or null when there is no meaningful base to compare to.
// A move from zero is not "infinite growth", it is a first occurrence.
function change(now, before) {
  const a = Number(now || 0);
  const b = Number(before || 0);
  if (b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function deltaHtml(now, before) {
  const d = change(now, before);
  if (d === null) {
    return `<span style="color:${MUTED};font-size:11px;">no prior figure</span>`;
  }
  const up = d >= 0;
  // The arrow carries the direction, so the colour is reinforcement rather
  // than the only signal.
  return (
    `<span style="color:${MUTED};font-size:11px;">was ${esc(peso(before))} </span>` +
    `<span style="color:${up ? GOOD : BAD};font-size:11px;white-space:nowrap;">` +
    `${up ? "&#9650;" : "&#9660;"} ${Math.abs(d).toFixed(0)}%</span>`
  );
}

// Splits the narrative into its "## " sections, preserving order.
function sections(narrative) {
  const found = [];
  let current = null;
  for (const raw of String(narrative || "").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3), lines: [] };
      found.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return found.map((s) => ({ heading: s.heading, body: s.lines.join("\n").trim() }));
}

const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// Markdown paragraphs and bullets to email-safe HTML.
function bodyHtml(text, { compact = false } = {}) {
  const out = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    out.push(
      `<ul style="margin:0 0 12px;padding-left:18px;color:${INK};font-size:${compact ? 13 : 14}px;line-height:1.6;">` +
        list.map((li) => `<li style="margin-bottom:6px;">${bold(li)}</li>`).join("") +
        `</ul>`
    );
    list = [];
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) list.push(line.slice(2));
    else if (line === "") flush();
    else {
      flush();
      out.push(
        `<p style="margin:0 0 12px;color:${INK};font-size:${compact ? 13 : 14}px;line-height:1.65;">${bold(line)}</p>`
      );
    }
  }
  flush();
  return out.join("");
}

// One headline figure.
function figureCell(label, value, previous) {
  return (
    `<td width="50%" style="padding:10px 12px;border:1px solid ${LINE};border-radius:6px;background:${CARD};" valign="top">` +
    `<div style="font-size:18px;font-weight:700;color:${INK};line-height:1.25;">${esc(peso(value))}</div>` +
    `<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;margin:3px 0 2px;">${esc(label)}</div>` +
    `<div>${deltaHtml(value, previous)}</div>` +
    `</td>`
  );
}

// The one chart: revenue as a full-width bar, divided into where it went.
// Segments below about 2% are given a floor width so they stay visible, and
// every segment is named with its own amount in the legend underneath — the
// colours are never the only way to read it.
function moneyBar(pl) {
  const revenue = Number(pl.totals.totalRevenue || 0);
  if (revenue <= 0) return "";

  const parts = [
    { key: "procurement", label: "Procurement", value: Number(pl.costs.procurement || 0), colour: COST_COLOURS.procurement },
    { key: "payroll", label: "Payroll", value: Number(pl.costs.payroll || 0), colour: COST_COLOURS.payroll },
    { key: "operatingExpenses", label: "Operating expenses", value: Number(pl.costs.operatingExpenses || 0), colour: COST_COLOURS.operatingExpenses },
    { key: "retained", label: "Retained as profit", value: Number(pl.totals.netProfit || 0), colour: RETAINED },
  ].filter((p) => p.value > 0);

  if (!parts.length) return "";

  const total = parts.reduce((a, p) => a + p.value, 0);
  // A segment worth a fraction of a percent would otherwise be zero pixels
  // wide and read as absent rather than as small. The floor is kept low —
  // about four pixels on the printed sheet — because every point given to a
  // tiny segment is taken from a true one, and the legend beside it carries
  // the exact figure either way.
  const widths = parts.map((p) => Math.max(0.6, (p.value / total) * 100));
  const scale = 100 / widths.reduce((a, w) => a + w, 0);

  const segments = parts
    .map(
      (p, i) =>
        `<td class="seg" width="${(widths[i] * scale).toFixed(2)}%" height="22" style="background:${p.colour};` +
        `font-size:1px;line-height:22px;">&nbsp;</td>`
    )
    .join("");

  const legend = parts
    .map(
      (p) =>
        `<tr>` +
        `<td width="14" style="padding:4px 8px 4px 0;" valign="middle">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="swatch" width="10" height="10" style="background:${p.colour};border-radius:2px;font-size:1px;line-height:10px;">&nbsp;</td>` +
        `</tr></table></td>` +
        `<td style="padding:4px 0;font-size:13px;color:${INK};">${esc(p.label)}</td>` +
        `<td align="right" style="padding:4px 0;font-size:13px;color:${INK};white-space:nowrap;">${esc(peso(p.value))}</td>` +
        `<td align="right" width="52" style="padding:4px 0 4px 10px;font-size:13px;color:${MUTED};white-space:nowrap;">` +
        `${((p.value / total) * 100).toFixed(1)}%</td>` +
        `</tr>`
    )
    .join("");

  return (
    `<h3 style="margin:26px 0 4px;font-size:14px;color:${INK};">Where the revenue went</h3>` +
    `<p style="margin:0 0 10px;font-size:12px;color:${MUTED};">` +
    `${esc(peso(revenue))} of revenue, divided into what it paid for and what was left.</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-radius:4px;overflow:hidden;"><tr>${segments}</tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">${legend}</table>`
  );
}

function statRows(rows) {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">` +
    rows
      .map(
        ([label, value], i) =>
          `<tr>` +
          `<td style="padding:7px 0;font-size:13px;color:${MUTED};border-top:${i ? `1px solid ${LINE}` : "none"};">${esc(label)}</td>` +
          `<td align="right" style="padding:7px 0;font-size:13px;color:${INK};border-top:${i ? `1px solid ${LINE}` : "none"};">${esc(value)}</td>` +
          `</tr>`
      )
      .join("") +
    `</table>`
  );
}

// Print rules, added only for the printable copy. Email clients treat <style>
// inconsistently, and none of this matters in an inbox.
//
// print-color-adjust is the important one: without it browsers drop background
// colours when printing, which would reduce the revenue bar to four blank
// cells. The legend names and amounts mean the report still reads correctly if
// a printer ignores it, but the bar is worth keeping.
const PRINT_CSS = `
  @page { size: A4; margin: 14mm 12mm; }
  @media print {
    html, body { background: #ffffff !important; }
    .sheet { border: none !important; border-radius: 0 !important; width: 100% !important; }
    .page-pad { padding: 0 !important; }
    td[style*="background"], .swatch, .seg {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .block { page-break-inside: avoid; break-inside: avoid; }
    h1, h3 { page-break-after: avoid; break-after: avoid; }
    .no-print { display: none !important; }
  }
  @media screen {
    .print-hint { display: block; }
  }
`;

function buildHtml({ factSheet, narrative, narrativeError, company }, { forPrint = false } = {}) {
  const cur = factSheet.current;
  const prev = factSheet.previous;
  const p = factSheet.period;
  const st = factSheet.standing;
  const pl = cur.profitAndLoss;
  const thin = factSheet.dataVolume.eventsThisPeriod < 15;

  const parts = sections(narrative);
  const summary = parts.find((s) => /^summary$/i.test(s.heading));
  const attention = parts.find((s) => /needs attention/i.test(s.heading));
  const rest = parts.filter((s) => s !== summary && s !== attention);

  // Shown in the inbox preview line, before anything is opened.
  const preheader = summary
    ? summary.body.replace(/\*\*/g, "").split(/(?<=\.)\s/)[0].slice(0, 140)
    : `${peso(pl.totals.totalRevenue)} revenue, ${peso(pl.totals.netProfit)} net for ${p.label}.`;

  const block = (inner) =>
    `<tr><td class="block" style="padding:0 24px;">${inner}</td></tr>`;

  // The printed sheet is wider than the email's 600px column — A4 minus the
  // page margin is about 186mm, and a 600px column stranded in the middle of
  // it looks like a mistake rather than a design.
  const width = forPrint ? 780 : 600;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Business review — ${esc(p.label)}${forPrint ? ` — ${esc(company)}` : ""}</title>
${forPrint ? `<style>${PRINT_CSS}</style>` : ""}</head>
<body style="margin:0;padding:0;background:${forPrint ? CARD : PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
${
  forPrint
    ? `<div class="no-print" style="text-align:center;padding:14px;background:${PAGE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:${MUTED};border-bottom:1px solid ${LINE};">` +
      `Use your browser's Print dialog (Ctrl+P) and choose <strong>Save as PDF</strong> for a file, or a printer for paper. This bar is not printed.</div>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${forPrint ? CARD : PAGE};padding:${forPrint ? "0" : "20px 0"};">
<tr><td align="center" class="page-pad">
<table role="presentation" class="sheet" width="${width}" cellpadding="0" cellspacing="0" border="0"
  style="width:${width}px;max-width:100%;background:${CARD};border:${forPrint ? "none" : `1px solid ${LINE}`};border-radius:${forPrint ? "0" : "10px"};
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <tr><td style="padding:22px 24px 6px;">
    <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${MUTED};">${esc(company)}</div>
    <h1 style="margin:6px 0 2px;font-size:21px;color:${INK};">Business review &middot; ${esc(p.label)}</h1>
    <div style="font-size:12px;color:${MUTED};">
      ${esc(p.start)} to ${esc(p.end)} &middot; compared with ${esc(factSheet.comparedWith.label)}
      &middot; ${factSheet.dataVolume.eventsThisPeriod} events recorded
    </div>
  </td></tr>

  ${
    thin
      ? block(
          `<div style="margin:14px 0 0;padding:11px 14px;background:${WARN_BG};color:${WARN_INK};` +
            `border-radius:6px;font-size:13px;line-height:1.5;">` +
            `Only ${factSheet.dataVolume.eventsThisPeriod} events were recorded this period. ` +
            `Read what follows as a description of what happened, not as a trend.</div>`
        )
      : ""
  }

  ${block(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="margin-top:16px;">` +
      `<tr>${figureCell("Revenue", pl.totals.totalRevenue, prev.profitAndLoss.totals.totalRevenue)}` +
      `${figureCell("Total costs", pl.totals.totalCosts, prev.profitAndLoss.totals.totalCosts)}</tr>` +
      `<tr>${figureCell("Net profit", pl.totals.netProfit, prev.profitAndLoss.totals.netProfit)}` +
      `${figureCell("Collected", cur.revenue.collectedValue, prev.revenue.collectedValue)}</tr>` +
      `</table>`
  )}

  ${block(moneyBar(pl))}

  ${block(
    `<h3 style="margin:26px 0 0;font-size:14px;color:${INK};">Sales and cash</h3>` +
      statRows([
        ["Opportunities won", `${cur.sales.won} of ${cur.sales.opportunitiesCreated} created, worth ${peso(cur.sales.wonValue)}`],
        ["Open pipeline", `${cur.sales.openPipelineCount} worth ${peso(cur.sales.openPipelineValue)}`],
        ["Stalled " + st.staleThresholdDays + "+ days", `${st.stalledOpportunities.count} worth ${peso(st.stalledOpportunities.value)}`],
        ["Invoiced", peso(cur.revenue.invoicedValue)],
        ["Collected", `${peso(cur.revenue.collectedValue)} (${pct(cur.revenue.collectionRatePercent)} of invoiced)`],
        ["Receivables outstanding", `${peso(st.receivables.outstanding)} (${peso(st.receivables.overdue)} overdue)`],
        ["Expense liquidation", `${pct(cur.expenses.liquidationRatePercent)} of ${peso(cur.expenses.cashAdvanced)} advanced`],
        // A literal character, not an entity: statRows escapes its values, so
        // "&middot;" would reach the reader as the text "&middot;".
        ["Stock on hand", `${peso(st.inventory.stockValue)} · ${st.inventory.atReorderLevel} of ${st.inventory.items} at reorder level`],
        ["Headcount", `${st.activeHeadcount} active, ${cur.payroll.peoplePaid} paid`],
      ])
  )}

  ${
    narrative
      ? (summary
          ? block(
              `<h3 style="margin:28px 0 8px;font-size:14px;color:${INK};">Summary</h3>` + bodyHtml(summary.body)
            )
          : "") +
        (attention
          ? block(
              `<div style="margin:20px 0 0;padding:14px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;">` +
                `<h3 style="margin:0 0 8px;font-size:14px;color:${WARN_INK};">Needs attention</h3>` +
                bodyHtml(attention.body, { compact: true }) +
                `</div>`
            )
          : "") +
        (rest.length
          ? block(
              `<div style="margin:26px 0 0;padding-top:18px;border-top:1px solid ${LINE};">` +
                `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};margin-bottom:12px;">` +
                `The rest of the review</div>` +
                rest
                  .map(
                    (s) =>
                      `<h3 style="margin:18px 0 6px;font-size:13px;color:${INK};">${esc(s.heading)}</h3>` +
                      bodyHtml(s.body, { compact: true })
                  )
                  .join("") +
                `</div>`
            )
          : "")
      : block(
          `<div style="margin:22px 0 0;padding:13px 15px;background:${WARN_BG};color:${WARN_INK};border-radius:6px;font-size:13px;line-height:1.55;">` +
            `The figures above are complete, but the written review could not be generated:<br><br>` +
            `<span style="font-family:monospace;font-size:12px;">${esc(narrativeError || "unknown error")}</span></div>`
        )
  }

  <tr><td style="padding:22px 24px 24px;">
    <div style="border-top:1px solid ${LINE};padding-top:14px;font-size:11px;color:${MUTED};line-height:1.6;">
      Figures cover ${esc(p.start)} to ${esc(p.end)} and come from ${esc(company)}'s own records.
      Open ${esc(company)} and go to Business Review to read this alongside the numbers behind it.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// The plain-text alternative carries the same content, in the same order, so
// a client that refuses HTML is not given a worse review.
function buildText({ factSheet, narrative, narrativeError, company }) {
  const cur = factSheet.current;
  const p = factSheet.period;
  const st = factSheet.standing;
  const pl = cur.profitAndLoss;
  const prev = factSheet.previous;
  const L = [];

  const rule = (s) => "-".repeat(s.length);
  const head = (s) => { L.push("", s.toUpperCase(), rule(s)); };
  const was = (now, before) => {
    const d = change(now, before);
    return d === null ? " (no prior figure)" : ` (was ${peso(before)}, ${d >= 0 ? "+" : ""}${d.toFixed(0)}%)`;
  };

  L.push(`${company.toUpperCase()} — BUSINESS REVIEW`, `${p.label}`, `${p.start} to ${p.end}`);
  L.push(`Compared with ${factSheet.comparedWith.label}. ${factSheet.dataVolume.eventsThisPeriod} events recorded.`);

  if (factSheet.dataVolume.eventsThisPeriod < 15) {
    L.push("", `NOTE: only ${factSheet.dataVolume.eventsThisPeriod} events were recorded this period.`,
      "Read what follows as a description of what happened, not as a trend.");
  }

  head("Headline");
  L.push(`  Revenue      ${peso(pl.totals.totalRevenue)}${was(pl.totals.totalRevenue, prev.profitAndLoss.totals.totalRevenue)}`);
  L.push(`  Total costs  ${peso(pl.totals.totalCosts)}${was(pl.totals.totalCosts, prev.profitAndLoss.totals.totalCosts)}`);
  L.push(`  Net profit   ${peso(pl.totals.netProfit)}${was(pl.totals.netProfit, prev.profitAndLoss.totals.netProfit)}`);
  L.push(`  Collected    ${peso(cur.revenue.collectedValue)}${was(cur.revenue.collectedValue, prev.revenue.collectedValue)}`);

  const revenue = Number(pl.totals.totalRevenue || 0);
  if (revenue > 0) {
    head("Where the revenue went");
    const rows = [
      ["Procurement", pl.costs.procurement],
      ["Payroll", pl.costs.payroll],
      ["Operating expenses", pl.costs.operatingExpenses],
      ["Retained as profit", pl.totals.netProfit],
    ].filter(([, v]) => Number(v) > 0);
    const total = rows.reduce((a, [, v]) => a + Number(v), 0);
    for (const [label, v] of rows) {
      const share = (Number(v) / total) * 100;
      // A twenty-character bar, so the proportions are visible in a fixed-width client.
      const bar = "#".repeat(Math.max(1, Math.round(share / 5))).padEnd(20, ".");
      L.push(`  ${label.padEnd(20)} ${bar} ${share.toFixed(1).padStart(5)}%  ${peso(v)}`);
    }
  }

  head("Sales and cash");
  L.push(`  Opportunities won        ${cur.sales.won} of ${cur.sales.opportunitiesCreated}, worth ${peso(cur.sales.wonValue)}`);
  L.push(`  Open pipeline            ${cur.sales.openPipelineCount} worth ${peso(cur.sales.openPipelineValue)}`);
  L.push(`  Stalled ${st.staleThresholdDays}+ days          ${st.stalledOpportunities.count} worth ${peso(st.stalledOpportunities.value)}`);
  L.push(`  Invoiced                 ${peso(cur.revenue.invoicedValue)}`);
  L.push(`  Collected                ${peso(cur.revenue.collectedValue)} (${pct(cur.revenue.collectionRatePercent)} of invoiced)`);
  L.push(`  Receivables outstanding  ${peso(st.receivables.outstanding)} (${peso(st.receivables.overdue)} overdue)`);
  L.push(`  Expense liquidation      ${pct(cur.expenses.liquidationRatePercent)} of ${peso(cur.expenses.cashAdvanced)} advanced`);
  L.push(`  Stock on hand            ${peso(st.inventory.stockValue)}, ${st.inventory.atReorderLevel} of ${st.inventory.items} at reorder level`);
  L.push(`  Headcount                ${st.activeHeadcount} active, ${cur.payroll.peoplePaid} paid`);

  if (narrative) {
    const parts = sections(narrative);
    const summary = parts.find((s) => /^summary$/i.test(s.heading));
    const attention = parts.find((s) => /needs attention/i.test(s.heading));
    const rest = parts.filter((s) => s !== summary && s !== attention);
    const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, "$1");
    for (const s of [summary, attention, ...rest].filter(Boolean)) {
      head(s.heading);
      L.push(plain(s.body));
    }
  } else {
    head("Written review");
    L.push(`Could not be generated: ${narrativeError || "unknown error"}`);
    L.push("The figures above are unaffected.");
  }

  L.push("", "---",
    `Figures cover ${p.start} to ${p.end} and come from ${company}'s own records.`,
    `Open ${company} and go to Business Review to read this alongside the numbers behind it.`);

  return L.join("\n");
}

function buildReviewEmail({ factSheet, narrative, narrativeError, company }) {
  const args = { factSheet, narrative, narrativeError, company };
  return {
    subject: `Business review — ${factSheet.period.label}`,
    html: buildHtml(args),
    text: buildText(args),
  };
}

// The same document, sized for A4 and with the print rules attached. Shared
// deliberately: a printed review that differs from the emailed one is a second
// thing to keep correct.
function buildPrintableReview(args) {
  return buildHtml(args, { forPrint: true });
}

module.exports = { buildReviewEmail, buildPrintableReview, buildHtml, buildText };
