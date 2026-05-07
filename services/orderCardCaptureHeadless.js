import jwt from "jsonwebtoken";
import archiver from "archiver";
import { getOrderRef } from "./publicCodes.js";
import { filterDesignedItemsForCardCapture } from "./orderCardPdfExportMeta.js";
import { getPuppeteerLaunchOptions } from "./puppeteerLaunchConfig.js";
import { workerApiBaseForHeadlessWorker } from "./workerJwtApiBase.js";

function captureJwtSecret() {
  return String(process.env.ORDER_CARD_PDF_JWT_SECRET || process.env.JWT_SECRET || "").trim();
}

function getExportDpi() {
  const parsed = Number(process.env.ORDER_CARD_EXPORT_DPI || 300);
  if (!Number.isFinite(parsed)) return 300;
  const clamped = Math.round(parsed);
  return Math.min(65535, Math.max(1, clamped));
}

/**
 * Set JPEG JFIF density metadata without changing pixel dimensions.
 * This keeps image size the same while updating print DPI hints.
 * @param {Buffer} jpeg
 * @param {number} dpi
 * @returns {Buffer}
 */
function withJpegDpi(jpeg, dpi) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4) return jpeg;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg; // not JPEG SOI
  const out = Buffer.from(jpeg);
  let offset = 2;
  while (offset + 4 <= out.length) {
    if (out[offset] !== 0xff) break;
    const marker = out[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const segLen = out.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > out.length) break;
    if (marker === 0xe0 && segLen >= 14) {
      const idStart = offset + 4;
      const hasJfif =
        out[idStart] === 0x4a && // J
        out[idStart + 1] === 0x46 && // F
        out[idStart + 2] === 0x49 && // I
        out[idStart + 3] === 0x46 && // F
        out[idStart + 4] === 0x00; // \0
      if (hasJfif) {
        out[idStart + 7] = 0x01; // units: dpi
        out.writeUInt16BE(dpi, idStart + 8); // X density
        out.writeUInt16BE(dpi, idStart + 10); // Y density
      }
      return out;
    }
    offset += 2 + segLen;
  }
  return out;
}

/** Short-lived JWT for Puppeteer worker (same secret family as order-card-pdf). */
export function signOrderCardCaptureToken(orderId) {
  const secret = captureJwtSecret();
  if (!secret || !orderId) return null;
  const workerApiBase = workerApiBaseForHeadlessWorker();
  const payload = {
    orderId: String(orderId),
    typ: "order-card-capture",
    ...(workerApiBase ? { workerApiBase } : {}),
  };
  return jwt.sign(payload, secret, { expiresIn: "12m" });
}

/**
 * Same JPEG sequence as the zip export: one buffer per line × (front, back), in order.
 * @param {{ items?: unknown[]; _id?: import("mongoose").Types.ObjectId; id?: string; orderCode?: string }|null} order
 * @returns {Promise<{ entries: { name: string; buffer: Buffer }[]; filenameBase: string } | null>}
 */
export async function collectOrderCardCaptureJpegEntries(order) {
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
  const exportDpi = getExportDpi();
  const ref = getOrderRef(order);
  const filenameBase = `order-${ref}`;

  const launchOpts = getPuppeteerLaunchOptions();
  console.info("[orderCardCaptureHeadless] chromium executable:", launchOpts.executablePath || "(puppeteer bundled — needs OS libs, see puppeteerLaunchConfig.js)");
  const browser = await puppeteer.launch(launchOpts);

  const entries = [];
  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true).catch(() => {});
    page.setDefaultNavigationTimeout(gotoMs);
    page.setDefaultTimeout(waitFnMs);
    /** Suppress noisy third-party font-CSS failures; screenshots still succeed with fallback fonts. */
    const isNoisyFontFailure = (url, errText) =>
      /fonts\.cdnfonts\.com|fonts\.googleapis\.com/i.test(url) &&
      /NotSameOrigin|blocked.*response|ORB|ERR_BLOCKED/i.test(String(errText || ""));

    let noisyFontSkipLogged = false;
    page.on("console", (msg) => {
      const t = msg.text();
      const ty = msg.type();
      if (ty === "error" && /Failed to load resource/i.test(t) && /fonts\.cdnfonts\.com|fonts\.googleapis\.com/i.test(t)) {
        return;
      }
      if (ty === "error" || ty === "warn" || t.includes("[order-card-capture]")) {
        console.info("[orderCardCaptureHeadless] page console:", ty, t.slice(0, 800));
      }
    });
    page.on("pageerror", (err) => {
      console.error("[orderCardCaptureHeadless] pageerror:", err?.message || err);
    });
    page.on("requestfailed", (req) => {
      const f = req.failure();
      const u = req.url();
      const et = f?.errorText || "";
      if (isNoisyFontFailure(u, et)) {
        if (!noisyFontSkipLogged) {
          noisyFontSkipLogged = true;
          console.info(
            "[orderCardCaptureHeadless] (suppressed further font CSS requestfailed logs — third-party font stylesheets; capture uses system fallbacks)"
          );
        }
        return;
      }
      console.warn("[orderCardCaptureHeadless] requestfailed:", u.slice(0, 200), et);
    });
    page.on("response", (res) => {
      const u = res.url();
      if (u.includes("order-items-for-capture") && res.status() >= 400) {
        console.warn("[orderCardCaptureHeadless] capture API HTTP", res.status(), u.slice(0, 160));
      }
    });

    for (let lineIndex = 0; lineIndex < captureItemRows.length; lineIndex++) {
      const suffix = captureItemRows.length > 1 ? `-line${lineIndex + 1}` : "";
      for (const side of ["front", "back"]) {
        const url = `${pageBase}?token=${encodeURIComponent(token)}&line=${lineIndex}&side=${side}`;
        let safeLog = url;
        try {
          const u = new URL(url);
          safeLog = `${u.origin}${u.pathname}?line=${lineIndex}&side=${side}&token=(redacted)`;
        } catch {
          /* keep truncated */
        }
        console.info("[orderCardCaptureHeadless] goto", safeLog);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoMs });
        try {
          await page.waitForFunction(
            () => Boolean(window.__ORDER_CARD_CAPTURE_OK__ || window.__ORDER_CARD_CAPTURE_ERR__),
            { timeout: waitFnMs }
          );
        } catch (waitErr) {
          const snap = await page.evaluate(() => ({
            href: window.location.href,
            err: window.__ORDER_CARD_CAPTURE_ERR__,
            ok: window.__ORDER_CARD_CAPTURE_OK__,
            text: document.body?.innerText ? document.body.innerText.slice(0, 800) : "",
            title: document.title,
          }));
          console.error("[orderCardCaptureHeadless] waitForFunction failed", { side, lineIndex, snap, waitErr: waitErr?.message });
          throw new Error(
            `Capture page did not signal ready (${side}, line ${lineIndex}): ${waitErr?.message || waitErr}. ` +
              `workerErr=${snap.err ?? "(none)"} title=${snap.title} textPreview=${JSON.stringify((snap.text || "").slice(0, 200))}`
          );
        }
        const err = await page.evaluate(() => window.__ORDER_CARD_CAPTURE_ERR__);
        if (err) throw new Error(String(err));
        const handle = await page.$("#pdf-export-card");
        if (!handle) throw new Error("Card surface #pdf-export-card not found");
        const jpegBuf = await handle.screenshot({ type: "jpeg", quality: 92 });
        const jpegWithDpi = withJpegDpi(Buffer.from(jpegBuf), exportDpi);
        const name = `${filenameBase}${suffix}-${side}.jpg`;
        entries.push({ name, buffer: jpegWithDpi });
        console.info("[orderCardCaptureHeadless] shot ok", name, jpegWithDpi?.length ?? 0, "bytes", `dpi=${exportDpi}`);
      }
    }
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  return { entries, filenameBase };
}

/**
 * Zip of JPEG screenshots (Chrome layout) for each designed line item × front/back.
 * @param {{ items?: unknown[]; _id?: import("mongoose").Types.ObjectId; id?: string; orderCode?: string }|null} order
 * @returns {Promise<{ buffer: Buffer, filenameBase: string } | null>}
 */
export async function buildOrderCardImagesZipHeadless(order) {
  const collected = await collectOrderCardCaptureJpegEntries(order);
  if (!collected) return null;

  const { entries, filenameBase } = collected;
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
