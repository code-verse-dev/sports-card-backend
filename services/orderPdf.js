import PDFDocument from "pdfkit";

const UPLOAD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUploadIdOrIdWithExt(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  if (UPLOAD_ID_REGEX.test(s)) return true;
  const base = s.split(".")[0];
  return !!base && UPLOAD_ID_REGEX.test(base) && /\.[a-z0-9]+$/i.test(s);
}

function isImageSource(value) {
  if (!value || typeof value !== "string") return false;
  if (value.startsWith("data:image")) return true;
  if (value.startsWith("http://") || value.startsWith("https://")) return true;
  return isUploadIdOrIdWithExt(value);
}

/**
 * @param {string} src
 * @param {string} apiBase e.g. http://localhost:4043
 * @returns {Promise<Buffer | null>}
 */
async function fetchImageBuffer(src, apiBase) {
  const s = String(src).trim();
  if (!s) return null;

  if (s.startsWith("data:image")) {
    const m = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(s);
    if (!m) return null;
    try {
      return Buffer.from(m[1], "base64");
    } catch {
      return null;
    }
  }

  let url = s;
  if (!s.startsWith("http")) {
    if (!isUploadIdOrIdWithExt(s) || !apiBase) return null;
    url = `${apiBase}/api/uploads/${encodeURIComponent(s)}`;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/**
 * Collect printable images from order line items (designSnapshot image fields).
 * @param {object} order Mongoose doc or plain object with items[]
 * @param {string} apiBase
 */
async function collectPrintImages(order, apiBase) {
  const items = order.items || [];
  /** @type {{ label: string, buffer: Buffer }[]} */
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const templateLabel = item.templateName || item.templateId || `Item ${i + 1}`;
    const snap = item.designSnapshot;
    if (!snap || typeof snap !== "object") continue;
    for (const [key, value] of Object.entries(snap)) {
      if (!isImageSource(value)) continue;
      const buffer = await fetchImageBuffer(value, apiBase);
      if (buffer && buffer.length > 0) {
        out.push({ label: `${templateLabel} — ${key}`, buffer });
      }
    }
  }
  return out;
}

/**
 * PDF for production: one page per embedded design image (or a summary page if none).
 * @param {object} order
 * @returns {Promise<Buffer>}
 */
export async function buildOrderPrintPdfBuffer(order) {
  const apiBase = (process.env.API_PUBLIC_URL || process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  const images = apiBase ? await collectPrintImages(order, apiBase) : [];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, autoFirstPage: false, size: "LETTER" });
    /** @type {Buffer[]} */
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const orderId = order._id?.toString?.() ?? order.id ?? "";

    (async () => {
      try {
        if (images.length === 0) {
          doc.addPage();
          doc.fontSize(16).fillColor("#043264").text("Custom Sports Cards — print pack", { align: "center" });
          doc.moveDown();
          doc.fontSize(11).fillColor("#333").text(
            `Order ${orderId}\n\nNo embedded images were found in this order (uploaded photos appear in the creator snapshot). Use the admin order page for live card preview, or ensure customer images are saved in the design.`,
            { align: "left" }
          );
        } else {
          for (const { label, buffer } of images) {
            doc.addPage();
            doc.fontSize(10).fillColor("#444").text(label, 36, 36, { width: 540 });
            doc.image(buffer, 36, 56, { fit: [540, 700], align: "center", valign: "center" });
          }
        }
        doc.end();
      } catch (e) {
        reject(e);
      }
    })();
  });
}
