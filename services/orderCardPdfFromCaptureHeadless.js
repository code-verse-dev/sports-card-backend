import PDFDocument from "pdfkit";
import imageSize from "image-size";
import { collectOrderCardCaptureJpegEntries } from "./orderCardCaptureHeadless.js";

/** Same long-edge rule as storefront `exportOrderCardPdf.tsx` (print-consistent multipage PDF). */
const PDF_DOWNLOAD_LONG_EDGE_IN = 3.75;
const PT_PER_IN = 72;

function pagePtsFromCapturePixels(wPx, hPx) {
  const w = Math.max(1, wPx);
  const h = Math.max(1, hPx);
  const longPx = Math.max(w, h);
  const inchesPerPx = PDF_DOWNLOAD_LONG_EDGE_IN / longPx;
  return { w: w * inchesPerPx * PT_PER_IN, h: h * inchesPerPx * PT_PER_IN };
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
      for (const { buffer } of collected.entries) {
        const dims = imageSize(buffer);
        const iw = dims.width ?? 1;
        const ih = dims.height ?? 1;
        const { w: pw, h: ph } = pagePtsFromCapturePixels(iw, ih);
        doc.addPage({ size: [pw, ph], margin: 0 });
        doc.image(buffer, 0, 0, { width: pw, height: ph });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
