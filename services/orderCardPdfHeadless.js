import jwt from "jsonwebtoken";
import { getPuppeteerLaunchOptions } from "./puppeteerLaunchConfig.js";

function pdfTokenSecret() {
  return String(process.env.ORDER_CARD_PDF_JWT_SECRET || process.env.JWT_SECRET || "").trim();
}

/**
 * Short-lived JWT for the headless PDF worker (never send to browsers for customers).
 * @param {"email-admin" | "email-customer" | "admin-download"} [purpose] — item filter + layout (see orderCardPdfExportMeta + internal route).
 */
export function signOrderCardPdfToken(orderId, purpose = "email-admin") {
  const secret = pdfTokenSecret();
  if (!secret || !orderId) return null;
  const p =
    purpose === "email-customer"
      ? "email-customer"
      : purpose === "admin-download"
        ? "admin-download"
        : "email-admin";
  return jwt.sign({ orderId: String(orderId), typ: "order-card-pdf", purpose: p }, secret, { expiresIn: "12m" });
}

/**
 * Opens the storefront worker page in headless Chrome and returns a multi-page full-card PDF (html2canvas + jsPDF).
 * Page sizing depends on `purpose`: admin notification email uses a 2.75″×3.75″ canvas; customer email uses ordered sizes
 * on PDF add-on lines only. Admin in-app “Download card PDF” does not use this path. Requires PUBLIC_APP_URL (or ORDER_CARD_PDF_PAGE_URL) and puppeteer.
 * @param {string} orderId Mongo order id
 * @param {{ purpose?: "email-admin" | "email-customer" | "admin-download" }} [opts]
 * @returns {Promise<Buffer | null>}
 */
export async function buildFullOrderCardPdfBufferHeadless(orderId, opts = {}) {
  if (process.env.DISABLE_HEADLESS_ORDER_PDF === "1") return null;
  const secret = pdfTokenSecret();
  if (!secret) {
    console.warn("[orderCardPdfHeadless] ORDER_CARD_PDF_JWT_SECRET or JWT_SECRET not set — skip headless PDF");
    return null;
  }
  const purpose =
    opts.purpose === "email-customer"
      ? "email-customer"
      : opts.purpose === "admin-download"
        ? "admin-download"
        : "email-admin";
  const token = signOrderCardPdfToken(orderId, purpose);
  if (!token) return null;

  const explicit = String(process.env.ORDER_CARD_PDF_PAGE_URL || "").trim().replace(/\/+$/, "");
  const origin = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  const pageBase = explicit || (origin ? `${origin}/__order-card-pdf` : "");
  if (!pageBase) {
    console.warn(
      "[orderCardPdfHeadless] Set PUBLIC_APP_URL (storefront) or ORDER_CARD_PDF_PAGE_URL (full URL to /__order-card-pdf, no query)"
    );
    return null;
  }

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (e) {
    console.warn("[orderCardPdfHeadless] puppeteer import failed:", e?.message || e);
    return null;
  }

  const url = `${pageBase}?token=${encodeURIComponent(token)}`;
  const gotoMs = Math.max(30000, Number(process.env.ORDER_CARD_PDF_GOTO_TIMEOUT_MS || 180000));
  const waitFnMs = Math.max(60000, Number(process.env.ORDER_CARD_PDF_WAIT_TIMEOUT_MS || 300000));

  const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoMs });
    await page.waitForFunction(
      () => Boolean(window.__ORDER_CARD_PDF_BASE64__ || window.__ORDER_CARD_PDF_ERR__),
      { timeout: waitFnMs }
    );
    const err = await page.evaluate(() => window.__ORDER_CARD_PDF_ERR__);
    if (err) throw new Error(String(err));
    const b64 = await page.evaluate(() => window.__ORDER_CARD_PDF_BASE64__);
    if (!b64 || typeof b64 !== "string") return null;
    return Buffer.from(b64, "base64");
  } finally {
    await browser.close().catch(() => {});
  }
}
