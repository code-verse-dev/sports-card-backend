import jwt from "jsonwebtoken";
import { Order } from "../models/Order.js";
import { getPuppeteerLaunchOptions } from "./puppeteerLaunchConfig.js";
import { workerApiBaseForHeadlessWorker } from "./workerJwtApiBase.js";
import { buildFullOrderCardPdfFromCaptureScreenshots } from "./orderCardPdfFromCaptureHeadless.js";

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
  const workerApiBase = workerApiBaseForHeadlessWorker();
  const payload = {
    orderId: String(orderId),
    typ: "order-card-pdf",
    purpose: p,
    ...(workerApiBase ? { workerApiBase } : {}),
  };
  return jwt.sign(payload, secret, { expiresIn: "12m" });
}

/**
 * Headless full-card PDF.
 * - **admin-download:** same Chrome screenshots as `card-images.zip`, assembled with PDFKit (matches zip visually).
 * - **email-admin / email-customer:** storefront worker `/__order-card-pdf` (html2canvas + jsPDF) for nominal print sizes.
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

  if (purpose === "admin-download") {
    try {
      const order = await Order.findById(orderId).lean();
      if (!order) return null;
      const fromCapture = await buildFullOrderCardPdfFromCaptureScreenshots(order);
      if (fromCapture?.length) return fromCapture;
    } catch (e) {
      console.error("[orderCardPdfHeadless] admin-download capture PDF failed:", e?.message || e);
      throw e;
    }
    return null;
  }

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

  const launchOpts = getPuppeteerLaunchOptions();
  console.info(
    "[orderCardPdfHeadless] chromium executable:",
    launchOpts.executablePath || "(puppeteer bundled — needs OS libs, see puppeteerLaunchConfig.js)"
  );
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true).catch(() => {});
    page.setDefaultNavigationTimeout(gotoMs);
    page.setDefaultTimeout(waitFnMs);
    page.on("pageerror", (err) => {
      console.error("[orderCardPdfHeadless] pageerror:", err?.message || err);
    });
    page.on("response", (res) => {
      const u = res.url();
      if (u.includes("order-items-for-pdf") && res.status() >= 400) {
        console.warn("[orderCardPdfHeadless] PDF items API HTTP", res.status(), u.slice(0, 200));
      }
    });
    let safeLog = url;
    try {
      const u = new URL(url);
      safeLog = `${u.origin}${u.pathname}?token=(redacted)`;
    } catch {
      /* keep */
    }
    console.info("[orderCardPdfHeadless] goto", safeLog);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoMs });
    try {
      await page.waitForFunction(
        () => Boolean(window.__ORDER_CARD_PDF_BASE64__ || window.__ORDER_CARD_PDF_ERR__),
        { timeout: waitFnMs }
      );
    } catch (waitErr) {
      const snap = await page.evaluate(() => ({
        href: window.location.href,
        err: window.__ORDER_CARD_PDF_ERR__,
        b64Len: typeof window.__ORDER_CARD_PDF_BASE64__ === "string" ? window.__ORDER_CARD_PDF_BASE64__.length : 0,
        text: document.body?.innerText ? document.body.innerText.slice(0, 800) : "",
        title: document.title,
      }));
      console.error("[orderCardPdfHeadless] waitForFunction failed", { snap, waitErr: waitErr?.message || waitErr });
      throw new Error(
        `PDF worker did not signal ready: ${waitErr?.message || waitErr}. workerErr=${snap.err ?? "(none)"} title=${snap.title} textPreview=${JSON.stringify((snap.text || "").slice(0, 200))}`
      );
    }
    const err = await page.evaluate(() => window.__ORDER_CARD_PDF_ERR__);
    if (err) throw new Error(String(err));
    const b64 = await page.evaluate(() => window.__ORDER_CARD_PDF_BASE64__);
    if (!b64 || typeof b64 !== "string") return null;
    return Buffer.from(b64, "base64");
  } finally {
    await browser.close().catch(() => {});
  }
}
