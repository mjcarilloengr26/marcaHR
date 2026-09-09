const { logEvent } = require("./services/auditLog");

let warnedMissingConfig = false;

// Render blocks outbound SMTP entirely on this plan — confirmed by two distinct
// failure modes back to back (IPv6 ENETUNREACH, then a plain connection timeout
// once IPv6 was ruled out on a literal IPv4 address). No SMTP configuration can
// work around a blocked port, so email now goes through Resend's HTTPS API
// instead, which uses port 443 like every other outbound request this app makes.
const RESEND_API_URL = "https://api.resend.com/emails";

// Resend takes attachments as base64 in the JSON body. Kept to a sane ceiling
// because the whole request is held in memory and most mailboxes reject large
// messages anyway — a rejected invoice email is worse than a link.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function encodeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const out = [];
  let total = 0;
  for (const a of attachments) {
    if (!a?.content || !a?.filename) continue;
    const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
    total += buf.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
    }
    out.push({ filename: a.filename, content: buf.toString("base64") });
  }
  return out.length ? out : null;
}

async function sendOne(recipient, subject, text, html, attachments) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM || "onboarding@resend.dev",
        to: [recipient],
        subject,
        // Both parts when there is an HTML body: the client picks, and a
        // text-only reader is never left with nothing.
        text,
        ...(html ? { html } : {}),
        ...(attachments ? { attachments } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend API ${res.status}: ${body.slice(0, 300)}`);
    }

    console.log(`[mailer] Sent "${subject}" to ${recipient}`);
    await logEvent({
      action: "email_sent",
      entityType: "email",
      details: {
        to: recipient,
        subject,
        ...(attachments ? { attachments: attachments.map((a) => a.filename).join(", ") } : {}),
      },
    });
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}" to ${recipient}:`, err.message);
    await logEvent({ action: "email_failed", entityType: "email", details: { to: recipient, subject, error: err.message } });
  }
}

// Fire-and-forget: never throws, so a broken/missing email config can't break the request that
// triggered it. Sends to each recipient in its own API call — a broadcast (e.g. every HR/admin
// user) must not let one bad/blocklisted address (Resend rejects reserved domains like
// example.com) sink delivery to everyone else, and it keeps recipients from seeing each other's
// addresses in a shared To: header.
async function sendMail({ to, subject, text, html, attachments }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) return;

  let encoded = null;
  try {
    encoded = encodeAttachments(attachments);
  } catch (err) {
    // Silently dropping the attachment would send an invoice email with no
    // invoice on it, which reads as a mistake to the customer and is worse
    // than not sending at all.
    console.error(`[mailer] Not sending "${subject}": ${err.message}`);
    await logEvent({ action: "email_failed", entityType: "email", details: { to: recipients.join(", "), subject, error: err.message } });
    return;
  }

  const { RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) {
    if (!warnedMissingConfig) {
      console.log("[mailer] Resend not configured (set RESEND_API_KEY in .env) — emails will be skipped.");
      warnedMissingConfig = true;
    }
    console.log(`[mailer] Skipped "${subject}" to ${recipients.join(", ")}`);
    await logEvent({
      action: "email_skipped",
      entityType: "email",
      details: {
        to: recipients.join(", "),
        subject,
        reason: "Resend not configured",
        ...(encoded ? { attachments: encoded.map((a) => a.filename).join(", ") } : {}),
      },
    });
    return;
  }

  await Promise.all(recipients.map((r) => sendOne(r, subject, text, html, encoded)));
}

module.exports = { sendMail };
