/**
 * Sends the admin "new order" email for the most recent order in MongoDB (same template + PDF as production:
 * headless 2.75″×3.75″ admin email PDF when PUBLIC_APP_URL + Puppeteer work).
 *
 * Usage (from sports-card-backend):
 *   npm run email:test-admin-last-order -- your@email.com
 *
 * Delivers to **your** address only (does not use ADMIN_EMAIL). Comma-separated addresses are ok.
 * The generated PDF is also saved to scripts/last-order-admin-email-preview.pdf when headless succeeds.
 *
 * If you get no mail: check Spam/Promotions, run `npm run smtp:test -- your@email.com`, and ensure
 * MAIL_FROM (if set) is allowed for your SMTP account (Gmail often requires it to match SMTP_USER or an alias).
 *
 * Headless PDF can take several minutes (templates + html2canvas). Override outer cap with TEST_ORDER_EMAIL_PDF_MS (ms);
 * inner wait uses ORDER_CARD_PDF_WAIT_TIMEOUT_MS (default 10m in orderCardPdfHeadless.js).
 */
import "../load-env.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import mongoose from "mongoose";
import { connectDB } from "../db.js";
import { Order } from "../models/Order.js";
import "../models/CustomerUser.js";
import { buildFullOrderCardPdfBufferHeadless } from "../services/orderCardPdfHeadless.js";
import { sendOrderPlacedAdminEmail } from "../services/orderEmails.js";
import { isMailConfigured, getMailFrom } from "../services/mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfOutPath = path.join(__dirname, "last-order-admin-email-preview.pdf");

/** Must exceed Puppeteer goto + waitForFunction (see orderCardPdfHeadless ORDER_CARD_PDF_*_TIMEOUT_MS). Default 12 min. */
const PDF_BUILD_MS = Number(process.env.TEST_ORDER_EMAIL_PDF_MS || 720000);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — email will send without full-card PDF if possible`)), ms)
    ),
  ]);
}

const recipient = (process.argv[2] || "").trim();
if (!recipient) {
  console.error(
    "Usage: npm run email:test-admin-last-order -- <your-email>\n\n" +
      "Sends the admin order notification (with PDF) to that address — not ADMIN_EMAIL.\n" +
      "Example: npm run email:test-admin-last-order -- you@gmail.com"
  );
  process.exit(1);
}

async function main() {
  console.log("[test-email] Recipient:", recipient);
  console.log("[test-email] SMTP_HOST set:", Boolean(process.env.SMTP_HOST), "SMTP_USER set:", Boolean(process.env.SMTP_USER));
  console.log("[test-email] MAIL_FROM will be:", getMailFrom() || "(empty — falls back to SMTP_USER)");

  const connected = await connectDB().catch((e) => {
    console.error("MongoDB connection failed:", e?.message || e);
    return false;
  });
  if (!connected) {
    console.error("Set MONGODB_URI in .env and ensure MongoDB is reachable.");
    process.exit(1);
  }

  const full = await Order.findOne()
    .sort({ createdAt: -1 })
    .populate({
      path: "customerId",
      select: "email firstName lastName phone address addressLine2 city state zip country publicId",
    })
    .lean();

  if (!full?._id) {
    console.error("No orders found in the database.");
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  const id = full._id.toString();
  const merged = { ...full, id };
  console.log("[test-email] Latest order:", id, "createdAt:", full.createdAt, "status:", full.status);

  let adminPdf = null;
  try {
    console.log(`[test-email] Building headless admin PDF (max ${PDF_BUILD_MS / 1000}s)…`);
    adminPdf = await withTimeout(
      buildFullOrderCardPdfBufferHeadless(id, { purpose: "email-admin" }),
      PDF_BUILD_MS,
      "Headless PDF"
    );
  } catch (e) {
    console.warn("[test-email]", e?.message || e);
  }

  if (adminPdf?.length) {
    await fs.writeFile(pdfOutPath, adminPdf);
    console.log("[test-email] Wrote PDF preview to:", pdfOutPath, `(${Math.round(adminPdf.length / 1024)} KB)`);
  } else {
    console.warn(
      "[test-email] No full-card PDF (PUBLIC_APP_URL / ORDER_CARD_PDF_PAGE_URL, Puppeteer, JWT_SECRET). Email may attach snapshot PDF or none."
    );
  }

  if (!isMailConfigured()) {
    console.error("[test-email] SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env).");
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  const mailResult = await sendOrderPlacedAdminEmail(merged, {
    fullCardPdfBuffer: adminPdf,
    subjectPrefix: "[TEST]",
    sendTo: recipient,
  });

  if (mailResult?.skipped) {
    console.error("[test-email] Mail was skipped (see logs above).");
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  console.log("[test-email] Done. messageId:", mailResult?.messageId);
  console.log("[test-email] If inbox is empty: check Spam/Promotions, and run: npm run smtp:test -- " + recipient);
  await mongoose.disconnect().catch(() => {});
}

main().catch((e) => {
  console.error("[test-email] Failed:", e?.message || e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
