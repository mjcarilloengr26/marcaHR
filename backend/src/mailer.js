const nodemailer = require("nodemailer");
const dns = require("dns").promises;
const { logEvent } = require("./services/auditLog");

let warnedMissingConfig = false;

// Render's outbound network has no IPv6 route (same gap hit earlier with Supabase's
// direct connection host). nodemailer's own DNS resolver (lib/shared/index.js) does
// NOT read a `family` transport option at all — it always resolves both IPv4 and
// IPv6 addresses for the host and picks ONE AT RANDOM to connect to, so `family: 4`
// silently did nothing and it kept rolling an unreachable IPv6 address. Resolving to
// a single IPv4 literal ourselves and connecting to that removes the randomness.
let cachedIp = null;
let cachedIpHost = null;
let cachedIpExpiry = 0;
const IP_CACHE_MS = 5 * 60 * 1000;

async function resolveIPv4(host) {
  const now = Date.now();
  if (cachedIp && cachedIpHost === host && now < cachedIpExpiry) return cachedIp;
  const addresses = await dns.resolve4(host);
  cachedIp = addresses[Math.floor(Math.random() * addresses.length)];
  cachedIpHost = host;
  cachedIpExpiry = now + IP_CACHE_MS;
  return cachedIp;
}

async function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  const port = Number(SMTP_PORT) || 587;
  let host = SMTP_HOST;
  try {
    host = await resolveIPv4(SMTP_HOST);
  } catch (err) {
    console.warn(`[mailer] IPv4 resolution for ${SMTP_HOST} failed (${err.message}) — falling back to hostname, may hit IPv6.`);
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Keep TLS validation pointed at the real hostname since we're connecting to a raw IP.
    tls: { servername: SMTP_HOST },
  });
}

// Fire-and-forget: never throws, so a broken/missing SMTP config can't break the request that triggered it.
async function sendMail({ to, subject, text }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : to;
  if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) return;

  const recipientList = Array.isArray(recipients) ? recipients.join(", ") : recipients;

  const t = await getTransporter();
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
