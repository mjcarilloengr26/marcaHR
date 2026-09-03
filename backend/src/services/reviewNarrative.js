const Anthropic = require("@anthropic-ai/sdk");
const { companyName } = require("./branding");

const Client = Anthropic.default || Anthropic;

// The narrative half of the business review. It reads only the fact sheet the
// app computed — never a raw row — so it can interpret figures the app already
// stands behind, and cannot invent a customer or misread a total.
const MODEL = "claude-opus-5";

const SYSTEM = `You are writing the business review for a small engineering and electrical
contracting firm in the Philippines. You are given a fact sheet of figures the
company's own system computed. Write the review a competent finance-literate
operations manager would write for the owner.

Rules that matter more than style:

- Every number you cite must come from the fact sheet. Never estimate, never
  extrapolate, never invent a figure, a customer name or a cause.
- The fact sheet includes eventsThisPeriod and eventsPreviousPeriod. When these
  are small (under about 15), say plainly that the period is too thin to draw
  conclusions from, and describe what happened rather than claiming a trend.
  A change from 1 to 2 is not "100% growth" — it is two events.
- Do not congratulate. Do not use "exciting", "robust", "leverage", "synergy"
  or similar filler. Write plainly, as to someone who already knows the business.
- Where a figure looks wrong rather than good or bad — a margin above 80%, costs
  that seem impossibly low, a period where payroll is zero — say so and suggest
  what might explain it. Data problems are more useful to surface than praised.
- Amounts are Philippine pesos. Write them as PHP 1,234,567.89 or PHP 1.2M for
  large round figures. Never invent a currency.

Structure the review with these markdown headings, in this order, and nothing else:

## Summary
Three or four sentences. What happened, what moved, what needs a decision.

## Revenue and profit
Revenue, costs and margin against the previous period. Say what drove the change
if the fact sheet supports it, and say you cannot tell if it does not.

## Sales and pipeline
Opportunities created and won, win rate, what is open, what has stalled.

## Cash and collections
Invoiced versus collected, what is outstanding and overdue, expense liquidation.

## Operations
Procurement, work orders, inventory position, assets, workforce.

## Needs attention
A short bulleted list, most urgent first. Each item names the figure behind it.
If nothing genuinely needs attention, say so rather than padding the list.`;

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// The fact sheet goes in whole. It is a few hundred numbers — small enough that
// trimming it would cost more in lost context than it saves in tokens.
async function writeNarrative(factSheet) {
  if (!configured()) {
    const err = new Error(
      "ANTHROPIC_API_KEY is not set, so the written review cannot be generated. The figures below are unaffected."
    );
    err.code = "NO_API_KEY";
    throw err;
  }

  const client = new Client();
  const company = await companyName();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    // Adaptive thinking is the default on Opus 5; naming it is explicit about
    // the intent, and this is analysis rather than transcription.
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content:
          `Business review for ${company}, covering ${factSheet.period.label} ` +
          `(${factSheet.period.start} to ${factSheet.period.end}), compared with ` +
          `${factSheet.comparedWith.label}.\n\nFact sheet:\n\n` +
          JSON.stringify(factSheet, null, 2),
      },
    ],
  });

  // A safety refusal returns HTTP 200 with this stop reason and no usable text,
  // so it has to be checked before reading the content.
  if (response.stop_reason === "refusal") {
    const err = new Error("The model declined to write this review.");
    err.code = "REFUSED";
    err.details = response.stop_details || null;
    throw err;
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    narrative: text,
    model: response.model,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}

module.exports = { writeNarrative, configured, MODEL };
