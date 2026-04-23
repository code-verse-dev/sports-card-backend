import PDFDocument from "pdfkit";
import imageSize from "image-size";
import { collectOrderCardCaptureJpegEntries } from "./orderCardCaptureHeadless.js";

const PT_PER_IN = 72;
/** Fixed print page (inches) — admin full-card PDF matches standard tall card sheet sizing. */
const PAGE_W_IN = 2.75;
const PAGE_H_IN = 3.75;

/** Fit image in page with uniform scale (no stretch); letterbox on white. */
function containImageRect(iw, ih, pw, ph) {
  const ar = Math.max(1, iw) / Math.max(1, ih);
  const pageAr = pw / ph;
  let dw;
  let dh;
  let x;
  let y;
  if (ar > pageAr) {
    dw = pw;
    dh = pw / ar;
    x = 0;
    y = (ph - dh) / 2;
  } else {
    dh = ph;
    dw = ph * ar;
    x = (pw - dw) / 2;
    y = 0;
  }
  return { x, y, dw, dh };
}

/**
 * Multipage PDF: each page is one Chrome screenshot of `#pdf-export-card` (same pipeline as card-images.zip).
 * @param {{ items?: unknown[]; _id?: import("mongoose").Types.ObjectId; id?: string; orderCode?: string }|null} order
 * @returns {Promise<Buffer | null>}
 */
export async function buildFullOrderCardPdfFromCaptureScreenshots(order) {
  if (process.env.DISABLE_HEADLESS_ORDER_CAPTURE === "1") return null;
  const collected = await collectOrderCardCaptureJpegEntries(order);
  if (!collected?.entries?.length) return null;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    try {
      const pw = PAGE_W_IN * PT_PER_IN;
      const ph = PAGE_H_IN * PT_PER_IN;
      for (const { buffer } of collected.entries) {
        const dims = imageSize(buffer);
        const iw = dims.width ?? 1;
        const ih = dims.height ?? 1;
        doc.addPage({ size: [pw, ph], margin: 0 });
        doc.fillColor("#ffffff").rect(0, 0, pw, ph).fill();
        const { x, y, dw, dh } = containImageRect(iw, ih, pw, ph);
        doc.image(buffer, x, y, { width: dw, height: dh });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
