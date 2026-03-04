/**
 * Uploads API: POST /api/admin/uploads (multipart), GET /api/uploads/:id (serve file from disk, no DB).
 * Static mount at /api/uploads/static serves files by filename (e.g. /api/uploads/static/{id}.png).
 */
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import express from "express";
import multer from "multer";
import {
  ensureUploadsCollection,
  listUploads,
  deleteUploadById,
} from "./uploads-db.js";
import { listTemplates } from "./db.js";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

/** Max size per file (20 MB). If using a reverse proxy (e.g. nginx), set client_max_body_size to match. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await ensureUploadsDir();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || ".png").toLowerCase();
    const id = randomUUID();
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\//i.test(file.mimetype);
    if (allowed) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

export function registerUploadsRouter(app) {
  ensureUploadsDir().catch((err) => console.error("Uploads dir init:", err));

  // Static (no API): direct file access, e.g. http://localhost:4000/uploads/0a894356-...-97226.png
  app.use("/uploads", express.static(UPLOADS_DIR, {
    maxAge: "1d",
    immutable: true,
  }));

  // Static: serve uploads by filename, e.g. GET /api/uploads/static/{id}.png
  app.use("/api/uploads/static", express.static(UPLOADS_DIR, {
    maxAge: "1d",
    immutable: true,
  }));

  // GET /api/uploads/:id or /api/uploads/:id.png – serve from disk (no DB)
  // Supports both http://localhost:4000/api/uploads/{uuid} and .../api/uploads/{uuid}.png
  app.get("/api/uploads/:id", async (req, res) => {
    const param = (req.params.id || "").trim();
    if (!param) return res.status(400).json({ error: "Missing id" });
    const lastDot = param.lastIndexOf(".");
    let id = param;
    if (lastDot > 0) {
      const ext = param.slice(lastDot).toLowerCase();
      id = param.slice(0, lastDot);
      const filePath = path.join(UPLOADS_DIR, `${id}${ext}`);
      try {
        await fs.access(filePath);
        res.setHeader("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.sendFile(path.resolve(filePath));
        return;
      } catch {
        // Fallback below: try any extension if exact one was not found.
      }
    }
    try {
      const names = await fs.readdir(UPLOADS_DIR);
      const match = names.find((name) => path.parse(name).name === id);
      if (!match) {
        return res.status(404).json({ error: "Not found" });
      }
      const ext = path.extname(match).toLowerCase();
      const filePath = path.join(UPLOADS_DIR, match);
      res.setHeader("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.sendFile(path.resolve(filePath));
      return;
    } catch {
      return res.status(404).json({ error: "Not found" });
    }
  });

  app.post("/api/admin/uploads", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file (field: file)" });
    }
    const id = path.parse(req.file.filename).name;
    res.status(201).json({ id, originalName: req.file.originalname || req.file.filename, mimeType: req.file.mimetype });
  });

  app.get("/api/admin/uploads", async (_req, res) => {
    try {
      const list = await listUploads();
      res.json(list.map((d) => ({ id: d.id, originalName: d.originalName, mimeType: d.mimeType })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to list uploads" });
    }
  });

  app.delete("/api/admin/uploads/:id", async (req, res) => {
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });
    try {
      const all = await listTemplates();
      const isReferenced = all.some((rec) => {
        const slots = [
          rec?.template?.thumbnailImage,
          rec?.template?.front?.backgroundImage,
          rec?.template?.back?.backgroundImage,
        ];
        return slots.some((v) => typeof v === "string" && v.trim() === id);
      });
      if (isReferenced) {
        return res.status(409).json({ error: "Upload is referenced by a template" });
      }

      const removed = await deleteUploadById(id);
      if (!removed) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true, id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete upload" });
    }
  });
}

export { ensureUploadsDir, UPLOADS_DIR, MAX_UPLOAD_BYTES };
