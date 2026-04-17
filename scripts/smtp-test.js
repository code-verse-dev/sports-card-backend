/**
 * Test SMTP (e.g. Outlook / Microsoft 365). Run from sports-card-backend:
 *   node scripts/smtp-test.js
 */
import "../load-env.js";
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT) || 587;
const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!host || !user || !pass) {
  console.error("Missing SMTP_HOST, SMTP_USER, or SMTP_PASS in .env");
  process.exit(1);
}

const isMicrosoftSmtp = /office365|outlook\.com|microsoft\.com/i.test(String(host));
const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
  ...(isMicrosoftSmtp && !secure
    ? {
        requireTLS: true,
        tls: { minVersion: "TLSv1.2" },
      }
    : {}),
});

const testTo = process.argv[2] || user;

async function main() {
  console.log("Verifying SMTP connection…", { host, port, secure, user });
  await transporter.verify();
  console.log("OK: SMTP connection verified.");

  console.log(`Sending test message to ${testTo}…`);
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || user,
    to: testTo,
    subject: "[Custom Sports Cards] SMTP test",
    text: "If you received this, Outlook SMTP is configured correctly.",
    html: "<p>If you received this, Outlook SMTP is configured correctly.</p>",
  });
  console.log("OK: Message sent.", info.messageId);
}

main().catch((err) => {
  console.error("SMTP test failed:", err.message || err);
  process.exit(1);
});
