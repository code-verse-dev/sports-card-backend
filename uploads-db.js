/**
 * Uploads: images stored on disk only (server/uploads/). No MongoDB.
 * Images are served statically at /uploads/{id}.png (or via GET /api/uploads/:id).
 */
import path from "path";
import fs from "fs/promises";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg", ".tif", ".tiff"];

export { UPLOADS_DIR };

/** No-op for compatibility with code that calls this at startup. */
export async function ensureUploadsCollection() {}

/** No-op; scripts that need native collection get null (e.g. migrate skips DB). */
export async function getUploadsCollection() {
  return null;
}

/** Resolve file path for an upload id (try each extension). Returns null if not found. */
export async function getUploadFilePath(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const names = await fs.readdir(UPLOADS_DIR);
    const match = names.find((name) => path.parse(name).name === key);
    if (!match) return null;
    const ext = path.extname(match).toLowerCase();
    if (ext && !IMAGE_EXTS.includes(ext)) return null;
    return path.join(UPLOADS_DIR, match);
  } catch {
    return null;
  }
}

/** List uploads by reading the uploads directory. Returns { id, originalName, mimeType } from filename. */
export async function listUploads() {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const names = await fs.readdir(UPLOADS_DIR);
    const list = [];
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) continue;
      const id = path.parse(name).name;
      const mimeType =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".bmp"
                  ? "image/bmp"
                  : ext === ".avif"
                    ? "image/avif"
                    : ext === ".svg"
                      ? "image/svg+xml"
                      : "image/tiff";
      list.push({ id, originalName: name, mimeType });
    }
    list.sort((a, b) => (b.originalName || "").localeCompare(a.originalName || ""));
    return list;
  } catch {
    return [];
  }
}

/** Delete file on disk by id (try extensions). Returns true if a file was removed. */
export async function deleteUploadById(id) {
  const filePath = await getUploadFilePath(id);
  if (!filePath) return false;
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
