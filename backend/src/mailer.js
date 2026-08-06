const nodemailer = require("nodemailer");

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
  });
  return transporter;
}

// Fire-and-forget: never throws, so a broken/missing SMTP config can't break the request that triggered it.
async function sendMail({ to, subject, text }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : to;
  if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) return;

  const t = getTransporter();
  if (!t) {
    if (!warnedMissingConfig) {
      console.log("[mailer] SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS in .env) — emails will be skipped.");
      warnedMissingConfig = true;
    }
    console.log(`[mailer] Skipped "${subject}" to ${Array.isArray(recipients) ? recipients.join(", ") : recipients}`);
    return;
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: Array.isArray(recipients) ? recipients.join(", ") : recipients,
      subject,
      text,
    });
    console.log(`[mailer] Sent "${subject}" to ${Array.isArray(recipients) ? recipients.join(", ") : recipients}`);
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}":`, err.message);
  }
}

module.exports = { sendMail };
