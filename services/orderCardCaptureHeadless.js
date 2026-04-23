import jwt from "jsonwebtoken";
import archiver from "archiver";
import { getOrderRef } from "./publicCodes.js";
import { filterDesignedItemsForCardCapture } from "./orderCardPdfExportMeta.js";
import { getPuppeteerLaunchOptions } from "./puppeteerLaunchConfig.js";

function captureJwtSecret() {
  return String(process.env.ORDER_CARD_PDF_JWT_SECRET || process.env.JWT_SECRET || "").trim();
}

/** Short-lived JWT for Puppeteer worker (same secret family as order-card-pdf). */
export function signOrderCardCaptureToken(orderId) {
  const secret = captureJwtSecret();
  if (!secret || !orderId) return null;
  return jwt.sign({ orderId: String(orderId), typ: "order-card-capture" }, secret, { expiresIn: "12m" });
}

/**
 * Zip of JPEG screenshots (Chrome layout) for each designed line item × front/back.
 * @param {{ items?: unknown[]; _id?: import("mongoose").Types.ObjectId; id?: string; orderCode?: string }|null} order
 * @returns {Promise<{ buffer: Buffer, filenameBase: string } | null>}
 */
export async function buildOrderCardImagesZipHeadless(order) {
  if (process.env.DISABLE_HEADLESS_ORDER_CAPTURE === "1") return null;
  const secret = captureJwtSecret();
  if (!secret) {
    console.warn("[orderCardCaptureHeadless] ORDER_CARD_PDF_JWT_SECRET or JWT_SECRET not set — skip capture");
    return null;
  }
  const { captureItemRows } = filterDesignedItemsForCardCapture(order?.items || []);
  if (captureItemRows.length === 0) return null;

  const orderId = order?._id?.toString?.() ?? order?.id;
  if (!orderId) return null;
  const token = signOrderCardCaptureToken(orderId);
  if (!token) return null;

  const explicit = String(process.env.ORDER_CARD_CAPTURE_PAGE_URL || "").trim().replace(/\/+$/, "");
  const origin = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  const pageBase = explicit || (origin ? `${origin}/__order-card-capture` : "");
  if (!pageBase) {
    console.warn(
      "[orderCardCaptureHeadless] Set PUBLIC_APP_URL or ORDER_CARD_CAPTURE_PAGE_URL (full URL to /__order-card-capture, no query)"
    );
    return null;
  }

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (e) {
    console.warn("[orderCardCaptureHeadless] puppeteer import failed:", e?.message || e);
    return null;
  }

  const gotoMs = Math.max(30000, Number(process.env.ORDER_CARD_CAPTURE_GOTO_TIMEOUT_MS || 120000));
  const waitFnMs = Math.max(45000, Number(process.env.ORDER_CARD_CAPTURE_WAIT_TIMEOUT_MS || 180000));
  const ref = getOrderRef(order);
  const filenameBase = `order-${ref}`;

  const browser = await puppeteer.launch(getPuppeteerLaunchOptions());

  const entries = [];
  try {
    const page = await browser.newPage();
    for (let lineIndex = 0; lineIndex < captureItemRows.length; lineIndex++) {
      const suffix = captureItemRows.length > 1 ? `-line${lineIndex + 1}` : "";
      for (const side of ["front", "back"]) {
        const url = `${pageBase}?token=${encodeURIComponent(token)}&line=${lineIndex}&side=${side}`;
        console.info("[orderCardCaptureHeadless] goto", url.slice(0, 120) + (url.length > 120 ? "…" : ""));
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoMs });
        await page.waitForFunction(
          () => Boolean(window.__ORDER_CARD_CAPTURE_OK__ || window.__ORDER_CARD_CAPTURE_ERR__),
          { timeout: waitFnMs }
        );
        const err = await page.evaluate(() => window.__ORDER_CARD_CAPTURE_ERR__);
        if (err) throw new Error(String(err));
        const handle = await page.$("#pdf-export-card");
        if (!handle) throw new Error("Card surface #pdf-export-card not found");
        const jpegBuf = await handle.screenshot({ type: "jpeg", quality: 92 });
        const name = `${filenameBase}${suffix}-${side}.jpg`;
        entries.push({ name, buffer: Buffer.from(jpegBuf) });
        console.info("[orderCardCaptureHeadless] shot ok", name, jpegBuf?.length ?? 0, "bytes");
      }
    }
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    archive.on("data", (d) => chunks.push(d));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const { name, buffer: b } of entries) {
      archive.append(b, { name });
    }
    void archive.finalize();
  });
  return { buffer, filenameBase };
}
