/**
 * Before checkout validation, replace inline data:image/...;base64,... strings in each item's
 * designSnapshot with upload ids (same disk layout as multipart uploads).
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { ensureUploadsDir, UPLOADS_DIR, MAX_UPLOAD_BYTES } from "../uploads-router.js";

function isInlineImageDataUrlString(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.startsWith("data:image/") && t.includes(";base64,");
}

const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/tif": ".tif",
};

function extensionFromMime(mime) {
  const normalized = mime.trim().toLowerCase();
  return MIME_TO_EXT[normalized] || ".png";
}

/**
 * Decode data URL to buffer + file extension (matches browser parsing for charset in metadata).
 */
function parseImageDataUrl(dataUrl) {
  const t = dataUrl.trim();
  const b64Marker = ";base64,";
  const idx = t.indexOf(b64Marker);
  if (idx === -1 || !t.startsWith("data:image/")) {
    throw new Error("Invalid image data URL.");
  }
  const meta = t.slice("data:".length, idx);
  const base64 = t.slice(idx + b64Marker.length).replace(/\s/g, "");
  const mimeMatch = /^image\/[a-z0-9.+-]+/i.exec(meta);
  const mime = mimeMatch ? mimeMatch[0] : "image/png";
  const ext = extensionFromMime(mime);
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    throw new Error("Invalid base64 in image data URL.");
  }
  if (!buffer.length) throw new Error("Empty image data.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Design image exceeds maximum size (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`);
  }
  return { buffer, ext };
}

async function writeDataUrlToUploadId(dataUrl) {
  const { buffer, ext } = parseImageDataUrl(dataUrl);
  const id = randomUUID();
  const filename = `${id}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, buffer);
  return id;
}

/**
 * Mutates `root` in place: replaces every inline image string with a new upload id.
 */
async function materializeDesignSnapshotTree(root) {
  if (root == null || typeof root !== "object") return;
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i += 1) {
      const el = root[i];
      if (typeof el === "string" && isInlineImageDataUrlString(el)) {
        root[i] = await writeDataUrlToUploadId(el);
      } else if (el && typeof el === "object") {
        await materializeDesignSnapshotTree(el);
      }
    }
    return;
  }
  for (const key of Object.keys(root)) {
    const v = root[key];
    if (typeof v === "string" && isInlineImageDataUrlString(v)) {
      root[key] = await writeDataUrlToUploadId(v);
    } else if (v && typeof v === "object") {
      await materializeDesignSnapshotTree(v);
    }
  }
}

/**
 * Mutates `items` in place (same array/objects as `req.body.items`).
 * Call before validateCheckoutItemsPayload.
 */
export async function materializeInlineSnapshotsInItems(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  await ensureUploadsDir();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const snap = item.designSnapshot;
    if (snap && typeof snap === "object") {
      await materializeDesignSnapshotTree(snap);
    }
  }
}
