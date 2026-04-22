import jwt from "jsonwebtoken";

function pdfTokenSecret() {
  return String(process.env.ORDER_CARD_PDF_JWT_SECRET || process.env.JWT_SECRET || "").trim();
}

/** Short-lived JWT for the headless PDF worker (never send to browsers for customers). */
export function signOrderCardPdfToken(orderId) {
  const secret = pdfTokenSecret();
  if (!secret || !orderId) return null;
  return jwt.sign({ orderId: String(orderId), typ: "order-card-pdf" }, secret, { expiresIn: "12m" });
}

/**
 * Opens the storefront worker page in headless Chrome and returns the same multi-page “full card” PDF
 * as admin Download (html2canvas + jsPDF). Requires PUBLIC_APP_URL (or ORDER_CARD_PDF_PAGE_URL) and puppeteer.
 * @param {string} orderId Mongo order id
 * @returns {Promise<Buffer | null>}
 */
export async function buildFullOrderCardPdfBufferHeadless(orderId) {
  if (process.env.DISABLE_HEADLESS_ORDER_PDF === "1") return null;
  const secret = pdfTokenSecret();
  if (!secret) {
    console.warn("[orderCardPdfHeadless] ORDER_CARD_PDF_JWT_SECRET or JWT_SECRET not set — skip headless PDF");
    return null;
  }
  const token = signOrderCardPdfToken(orderId);
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
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(
      () => Boolean(window.__ORDER_CARD_PDF_BASE64__ || window.__ORDER_CARD_PDF_ERR__),
      { timeout: 180000 }
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
