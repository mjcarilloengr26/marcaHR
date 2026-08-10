const nodemailer = require("nodemailer");
const { logEvent } = require("./services/auditLog");

let transporter;
let warnedMissingConfig = false;

function getTransporter() {
  if (transporter !== undefined) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return transporter;
  }

  const port = Number(SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Render's outbound network has no IPv6 route (same gap hit earlier with
    // Supabase's direct connection host) — smtp.gmail.com resolves dual-stack,
    // and without this the socket sometimes gets the IPv6 address and fails
    // with ENETUNREACH. Forcing IPv4 avoids that family entirely.
    family: 4,
  });
  return transporter;
}

// Fire-and-forget: never throws, so a broken/missing SMTP config can't break the request that triggered it.
async function sendMail({ to, subject, text }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : to;
  if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) return;

  const recipientList = Array.isArray(recipients) ? recipients.join(", ") : recipients;

  const t = getTransporter();
  if (!t) {
    if (!warnedMissingConfig) {
      console.log("[mailer] SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS in .env) — emails will be skipped.");
      warnedMissingConfig = true;
    }
    console.log(`[mailer] Skipped "${subject}" to ${recipientList}`);
    await logEvent({ action: "email_skipped", entityType: "email", details: { to: recipientList, subject, reason: "SMTP not configured" } });
    return;
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipientList,
      subject,
      text,
    });
    console.log(`[mailer] Sent "${subject}" to ${recipientList}`);
    await logEvent({ action: "email_sent", entityType: "email", details: { to: recipientList, subject } });
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}":`, err.message);
    await logEvent({ action: "email_failed", entityType: "email", details: { to: recipientList, subject, error: err.message } });
  }
}

module.exports = { sendMail };
