/**
 * Standalone Node backend for template CRUD.
 * Run: npm run dev (or npm start)
 * Requires MONGODB_URI in .env
 */
import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  getTemplateById,
  listTemplates,
  upsertTemplate,
  deleteTemplateById,
  ensureDatabase,
  updateTemplateByTemplateId,
  syncTemplateImageLinks,
} from "./db.js";
import { registerUploadsRouter } from "./uploads-router.js";
import { ensureUploadsCollection, deleteUploadById } from "./uploads-db.js";
import {
  listCategories,
  upsertCategory,
  deleteCategoryById,
  getCategoryById,
  listSubcategories,
  upsertSubcategory,
  deleteSubcategoryById,
  getSubcategoryById,
  ensureCategoriesCollections,
} from "./categories-db.js";

const env = process.env.NODE_ENV || "development";

const dotenv = await import("dotenv");
dotenv.config({ path: `.env.${env}` });

const app = express();
const PORT = process.env.PORT || 4000;
const UPLOAD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_TEMPLATES_PATH = path.resolve(__dirname, "..", "src", "data", "templates", "admin-saved-templates.json");

function isUploadId(value) {
  return typeof value === "string" && UPLOAD_ID_REGEX.test(value.trim());
}

function isValidImageRef(value) {
  return isUploadId(value);
}

function slugifySegment(value, fallback = "card") {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

async function generateTemplateId({ templateId, categoryId, subcategoryId, name }) {
  const manual = String(templateId || "").trim();
  if (manual) return manual;

  const parts = [];
  if (String(categoryId || "").trim()) parts.push(slugifySegment(categoryId));
  if (String(subcategoryId || "").trim()) parts.push(slugifySegment(subcategoryId));
  parts.push(slugifySegment(name, "new-card"));

  const baseId = parts.join("/");
  const existing = await listTemplates();
  const existingIds = new Set(existing.map((t) => String(t.templateId || "")));
  if (!existingIds.has(baseId)) return baseId;

  let i = 2;
  while (existingIds.has(`${baseId}-${i}`)) i += 1;
  return `${baseId}-${i}`;
}

function generateId() {
  return crypto.randomUUID();
}

/** Group designs: strip last segment only when it looks like a variation (e.g. color), not a product slug. */
function getBaseIdFromTemplateId(templateId) {
  const segments = String(templateId || "").split("/").filter(Boolean);
  if (segments.length <= 1) return segments.join("/");
  const last = segments[segments.length - 1];
  const lastLooksLikeProduct = /\d/.test(last) || /-\d+$/.test(last);
  if (lastLooksLikeProduct) return segments.join("/");
  return segments.slice(0, -1).join("/");
}

/**
 * Ensure every template has id, parentId, isParent. Updates existing docs in place by templateId.
 * Id can be missing when: (1) DB was empty at startup so ensureTemplateIds had nothing to run on,
 * (2) MongoDB was not connected at startup (getCollection() null), (3) templates were written
 * by code paths that did not set id (now fixed: POST create, both seed paths assign id).
 */
async function ensureTemplateIds() {
  const list = await listTemplates();
  const needsId = list.filter((t) => !t.id && t.templateId);
  if (needsId.length === 0) return;

  const byBaseId = new Map();
  for (const rec of list) {
    const tid = rec.templateId || rec.id;
    if (!tid) continue;
    const baseId = getBaseIdFromTemplateId(tid);
    if (!byBaseId.has(baseId)) byBaseId.set(baseId, []);
    byBaseId.get(baseId).push(rec);
  }

  for (const [, siblings] of byBaseId.entries()) {
    const withoutIds = siblings.filter((s) => !s.id && s.templateId);
    if (withoutIds.length === 0) continue;
    const sorted = [...withoutIds].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    let parentId = null;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const id = generateId();
      const isParent = i === 0;
      if (isParent) parentId = id;
      const ok = await updateTemplateByTemplateId(r.templateId, {
        id,
        parentId: isParent ? null : parentId,
        isParent,
        "template.id": id,
      });
      if (ok) {
        r.id = id;
        r.parentId = isParent ? null : parentId;
        r.isParent = isParent;
      }
    }
  }
}

/** Set parentId and isParent for records that have id but no parentId. Updates in place by id. */
async function ensureParentIds() {
  const list = await listTemplates();
  const needsParent = list.filter(
    (t) => t.id && (t.parentId === undefined || t.isParent === undefined)
  );
  if (needsParent.length === 0) return;

  const byBaseId = new Map();
  for (const rec of list) {
    const tid = rec.templateId || rec.id;
    if (!tid) continue;
    const baseId = getBaseIdFromTemplateId(tid);
    if (!byBaseId.has(baseId)) byBaseId.set(baseId, []);
    byBaseId.get(baseId).push(rec);
  }

  for (const [, siblings] of byBaseId.entries()) {
    const withId = siblings.filter((s) => s.id);
    if (withId.length === 0) continue;
    const sorted = [...withId].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const parent = sorted[0];
    const parentId = parent.id;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const needsUpdate = r.parentId === undefined || r.isParent === undefined;
      if (!needsUpdate) continue;
      const isParent = i === 0;
      await upsertTemplate({
        ...r,
        parentId: isParent ? null : parentId,
        isParent,
      });
    }
  }
}

function getImageSlots(record) {
  if (!record?.template) return [];
  return [
    record.template?.thumbnailImage,
    record.template?.previewImage,
    record.template?.front?.backgroundImage,
    record.template?.back?.backgroundImage,
  ].filter((v) => typeof v === "string" && v.trim() !== "");
}

function getTemplateImageSlots(template) {
  return {
    thumbnailImage: template?.thumbnailImage,
    previewImage: template?.previewImage,
    frontBg: template?.front?.backgroundImage,
    backBg: template?.back?.backgroundImage,
  };
}

function validateImageSlotsForCreate(template) {
  const slots = getTemplateImageSlots(template);
  for (const key of Object.keys(slots)) {
    const value = slots[key];
    if (typeof value === "string" && value.trim() !== "" && !isValidImageRef(value)) {
      return `${key} must be an upload image id`;
    }
  }
  return null;
}

function validateImageSlotsForUpdate(template, existingTemplate) {
  const next = getTemplateImageSlots(template);
  const prev = getTemplateImageSlots(existingTemplate);
  for (const key of Object.keys(next)) {
    const nextVal = next[key];
    if (typeof nextVal !== "string" || nextVal.trim() === "") continue;
    const prevVal = prev[key];
    const unchanged = typeof prevVal === "string" && prevVal === nextVal;
    if (!unchanged && !isValidImageRef(nextVal)) {
      return `${key} must be an upload image id`;
    }
  }
  return null;
}

const DEFAULT_CATEGORIES = [
  { id: "pets", name: "Pets", order: 0 },
  { id: "birth-announcements", name: "Birth Announcements", order: 1 },
  { id: "sports", name: "Sports", order: 2 },
];

const DEFAULT_SUBCATEGORIES = [
  { id: "birth-announcement-baseball", name: "Baseball", categoryId: "birth-announcements", order: 0 },
  { id: "birth-announcement-basketball", name: "Basketball", categoryId: "birth-announcements", order: 1 },
  { id: "birth-announcement-foodball", name: "Football", categoryId: "birth-announcements", order: 2 },
  { id: "birth-announcement-hockey", name: "Hockey", categoryId: "birth-announcements", order: 3 },
  { id: "golf", name: "Golf", categoryId: "sports", order: 0 },
  { id: "gymnastics", name: "Gymnastics", categoryId: "sports", order: 1 },
  { id: "hockey", name: "Hockey", categoryId: "sports", order: 2 },
  { id: "lacrosse", name: "LaCrosse", categoryId: "sports", order: 3 },
  { id: "martial-arts", name: "Martial Arts", categoryId: "sports", order: 4 },
  { id: "pickleball", name: "Pickleball", categoryId: "sports", order: 5 },
  { id: "soccer", name: "Soccer", categoryId: "sports", order: 6 },
  { id: "softball", name: "Softball", categoryId: "sports", order: 7 },
  { id: "swimming", name: "Swimming", categoryId: "sports", order: 8 },
  { id: "track-and-field", name: "Track and Field", categoryId: "sports", order: 9 },
  { id: "horse", name: "Horse", categoryId: "pets", order: 0 },
  { id: "pigs", name: "Pigs", categoryId: "pets", order: 1 },
  { id: "cats", name: "Cats", categoryId: "pets", order: 2 },
  { id: "goats", name: "Goats", categoryId: "pets", order: 3 },
  { id: "bunny", name: "Bunny", categoryId: "pets", order: 4 },
  { id: "parrots", name: "Parrots", categoryId: "pets", order: 5 },
];

async function cleanupUploadIfUnused(uploadId) {
  if (!isUploadId(uploadId)) return;
  const all = await listTemplates();
  const stillReferenced = all.some((rec) => getImageSlots(rec).includes(uploadId));
  if (stillReferenced) return;
  await deleteUploadById(uploadId);
}

async function seedLegacyTemplatesFromFile() {
  const raw = await fs.readFile(LEGACY_TEMPLATES_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const entries = Object.entries(parsed || {});
  let seeded = 0;
  for (const [templateId, template] of entries) {
    if (!template || typeof template !== "object") continue;
    const segments = String(templateId).split("/").filter(Boolean);
    const categoryId = segments[0];
    const subcategoryId = segments[1];
    const id = generateId();
    const record = {
      id,
      templateId: String(templateId),
      name: template.name ?? String(templateId),
      template: { ...template, id },
      ...(categoryId ? { categoryId } : {}),
      ...(subcategoryId ? { subcategoryId } : {}),
      isParent: true,
      parentId: null,
    };
    await upsertTemplate(record);
    seeded += 1;
  }
  return seeded;
}

async function seedMissingTemplatesFromFile() {
  const raw = await fs.readFile(LEGACY_TEMPLATES_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const entries = Object.entries(parsed || {});
  const currentTemplates = await listTemplates();
  const byId = new Map(currentTemplates.map((t) => [String(t.templateId), t]));

  let inserted = 0;
  let relinked = 0;

  for (const [templateIdRaw, template] of entries) {
    if (!template || typeof template !== "object") continue;
    const templateId = String(templateIdRaw);
    const segments = templateId.split("/").filter(Boolean);
    const inferredCategoryId = segments[0];
    const inferredSubcategoryId = segments[1];
    const existing = byId.get(templateId);

    if (!existing) {
      const id = generateId();
      const record = {
        id,
        templateId,
        name: template.name ?? templateId,
        template: { ...template, id },
        ...(inferredCategoryId ? { categoryId: inferredCategoryId } : {}),
        ...(inferredSubcategoryId ? { subcategoryId: inferredSubcategoryId } : {}),
        isParent: true,
        parentId: null,
      };
      await upsertTemplate(record);
      inserted += 1;
      continue;
    }

    const nextCategoryId = existing.categoryId || inferredCategoryId;
    const nextSubcategoryId = existing.subcategoryId || inferredSubcategoryId;
    const needsRelink = nextCategoryId !== existing.categoryId || nextSubcategoryId !== existing.subcategoryId;

    if (needsRelink) {
      await upsertTemplate({
        ...existing,
        ...(nextCategoryId ? { categoryId: nextCategoryId } : {}),
        ...(nextSubcategoryId ? { subcategoryId: nextSubcategoryId } : {}),
      });
      relinked += 1;
    }
  }

  return { inserted, relinked, total: inserted + relinked };
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

registerUploadsRouter(app);

// GET /api/templates – list all (for template list page + admin dropdown)
app.get("/api/templates", async (req, res) => {
  try {
    const list = await listTemplates();
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list templates" });
  }
});

// GET /api/templates/:templateId – get one (creator, preview, admin load)
app.get("/api/templates/:templateId", async (req, res) => {
  const templateId = decodeURIComponent(req.params.templateId || "");
  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }
  try {
    const record = await getTemplateById(templateId);
    if (!record) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get template" });
  }
});

// POST /api/admin/templates – create
app.post("/api/admin/templates", async (req, res) => {
  const body = req.body || {};
  const {
    templateId,
    template,
    name,
    productDetailsTitle,
    productDetails,
    properties,
    categoryId,
    subcategoryId,
    parentId,
    isParent,
  } = body;
  if (!template || typeof template !== "object") {
    return res.status(400).json({ error: "Missing or invalid template" });
  }
  if (!template.front?.fields || !template.back?.fields) {
    return res.status(400).json({ error: "Template must have front.fields and back.fields" });
  }
  const createImageError = validateImageSlotsForCreate(template);
  if (createImageError) {
    return res.status(400).json({ error: createImageError });
  }
  try {
    const displayName = String(name ?? template.name ?? "Untitled").trim() || "Untitled";
    const resolvedTemplateId = await generateTemplateId({
      templateId,
      categoryId,
      subcategoryId,
      name: displayName,
    });
    const newId = generateId();
    const normalizedParentId = typeof parentId === "string" && parentId.trim() ? parentId.trim() : null;
    if (normalizedParentId) {
      const all = await listTemplates();
      const parentExists = all.some((t) => String(t.id || "").trim() === normalizedParentId);
      if (!parentExists) {
        return res.status(400).json({ error: "Invalid parentId" });
      }
    }
    const record = {
      id: newId,
      templateId: resolvedTemplateId,
      name: displayName,
      template: { ...template, id: newId },
      ...(categoryId !== undefined && { categoryId }),
      ...(subcategoryId !== undefined && { subcategoryId }),
      ...(productDetailsTitle !== undefined && { productDetailsTitle }),
      ...(productDetails !== undefined && { productDetails }),
      ...(properties !== undefined && { properties }),
      isParent: normalizedParentId ? false : Boolean(isParent ?? true),
      parentId: normalizedParentId,
    };
    const ok = await upsertTemplate(record);
    if (!ok) {
      return res.status(503).json({ error: "Database not configured (set MONGODB_URI)" });
    }
    res.json({ ok: true, id: record.id, templateId: record.templateId, autoGenerated: !String(templateId || "").trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// POST /api/admin/templates/seed-legacy
// Seeds templates from src/data/templates/admin-saved-templates.json (legacy local file).
app.post("/api/admin/templates/seed-legacy", async (_req, res) => {
  try {
    const seeded = await seedLegacyTemplatesFromFile();
    res.json({ ok: true, seeded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to seed legacy templates" });
  }
});

// POST /api/admin/templates/seed-missing
// Seeds only missing templates from legacy file and relinks missing category/subcategory fields.
app.post("/api/admin/templates/seed-missing", async (_req, res) => {
  try {
    for (const c of DEFAULT_CATEGORIES) await upsertCategory(c);
    for (const s of DEFAULT_SUBCATEGORIES) await upsertSubcategory(s);
    const result = await seedMissingTemplatesFromFile();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to seed missing templates" });
  }
});

/** Load path→uploadId mapping from scripts/image-path-to-upload-id.json (after migrate-from-path-list). */
async function loadImagePathToUploadIdMapping() {
  const mappingPath = path.resolve(__dirname, "..", "scripts", "image-path-to-upload-id.json");
  try {
    const raw = await fs.readFile(mappingPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveUploadIdFromMapping(mapping, pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) return null;
  const s = pathValue.trim().replace(/\\/g, "/");
  return mapping[s] ?? mapping[s.startsWith("/") ? s : `/${s}`] ?? mapping[s.startsWith("/") ? s.slice(1) : `/${s}`] ?? null;
}

/** Update existing DB templates: replace image paths with upload IDs using the migration mapping. */
async function migrateTemplateImageRefsInDb() {
  const mapping = await loadImagePathToUploadIdMapping();
  if (!mapping || typeof mapping !== "object") {
    return { ok: false, error: "Mapping file not found. Run scripts/migrate-from-path-list.js first." };
  }
  const list = await listTemplates();
  let updated = 0;
  for (const record of list) {
    const t = record.template;
    if (!t || typeof t !== "object") continue;
    let changed = false;
    const next = { ...t };
    const thumbUuid = resolveUploadIdFromMapping(mapping, t.thumbnailImage);
    if (thumbUuid) {
      next.thumbnailImage = thumbUuid;
      changed = true;
    }
    const previewUuid = resolveUploadIdFromMapping(mapping, t.previewImage);
    if (previewUuid) {
      next.previewImage = previewUuid;
      changed = true;
    }
    if (t.front && (t.front.backgroundImage || "").trim()) {
      const uuid = resolveUploadIdFromMapping(mapping, t.front.backgroundImage);
      if (uuid) {
        next.front = { ...t.front, backgroundImage: uuid };
        changed = true;
      }
    }
    if (t.back && (t.back.backgroundImage || "").trim()) {
      const uuid = resolveUploadIdFromMapping(mapping, t.back.backgroundImage);
      if (uuid) {
        next.back = { ...t.back, backgroundImage: uuid };
        changed = true;
      }
    }
    if (changed) {
      const ok = await updateTemplateByTemplateId(record.templateId, { template: next });
      if (ok) updated += 1;
    }
  }
  return { ok: true, updated, total: list.length };
}

/** Backfill previewImage on existing templates: set previewImage = thumbnailImage ?? front.backgroundImage when missing. */
async function backfillPreviewImageOnTemplates() {
  const list = await listTemplates();
  let updated = 0;
  for (const record of list) {
    const t = record.template;
    if (!t || typeof t !== "object") continue;
    const hasPreview = typeof t.previewImage === "string" && t.previewImage.trim() !== "";
    if (hasPreview) continue;
    const fallback = (t.thumbnailImage && t.thumbnailImage.trim()) || (t.front?.backgroundImage && t.front.backgroundImage.trim());
    if (!fallback) continue;
    const next = { ...t, previewImage: fallback };
    const ok = await updateTemplateByTemplateId(record.templateId, { template: next });
    if (ok) updated += 1;
  }
  return { ok: true, updated, total: list.length };
}

/** Reload template bodies from LEGACY_TEMPLATES_PATH for existing DB docs (by templateId). Preserves id. */
async function reloadTemplateBodiesFromFile() {
  let parsed;
  try {
    const raw = await fs.readFile(LEGACY_TEMPLATES_PATH, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: "Could not read or parse " + LEGACY_TEMPLATES_PATH };
  }
  const entries = Object.entries(parsed || {});
  const list = await listTemplates();
  const byTemplateId = new Map(list.map((r) => [String(r.templateId), r]));
  let updated = 0;
  for (const [templateId, fileTemplate] of entries) {
    if (!fileTemplate || typeof fileTemplate !== "object") continue;
    const existing = byTemplateId.get(String(templateId));
    if (!existing) continue;
    const nextTemplate = { ...fileTemplate, id: existing.template?.id ?? existing.id };
    await updateTemplateByTemplateId(templateId, { template: nextTemplate });
    updated += 1;
  }
  return { ok: true, updated, total: list.length };
}

// POST /api/admin/templates/migrate-image-refs
// Updates existing DB templates: replace image paths with upload IDs using scripts/image-path-to-upload-id.json.
app.post("/api/admin/templates/migrate-image-refs", async (_req, res) => {
  try {
    const result = await migrateTemplateImageRefsInDb();
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, updated: result.updated, total: result.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to migrate image refs" });
  }
});

// POST /api/admin/templates/reload-from-file
// Reloads template bodies from admin-saved-templates.json for existing DB docs (by templateId). Use after replacing the file with migrated JSON.
app.post("/api/admin/templates/reload-from-file", async (_req, res) => {
  try {
    const result = await reloadTemplateBodiesFromFile();
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, updated: result.updated, total: result.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reload from file" });
  }
});

// POST /api/admin/templates/backfill-preview-image
// Sets template.previewImage = thumbnailImage ?? front.backgroundImage for all templates that don't have previewImage.
app.post("/api/admin/templates/backfill-preview-image", async (_req, res) => {
  try {
    const result = await backfillPreviewImageOnTemplates();
    res.json({ ok: true, updated: result.updated, total: result.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to backfill preview image" });
  }
});

// POST /api/admin/templates/sync-preview-front-back
// Syncs top-level preview, front, back from nested template.* for every template (one-time backfill).
app.post("/api/admin/templates/sync-preview-front-back", async (_req, res) => {
  try {
    const result = await syncTemplateImageLinks();
    res.json({ ok: true, updated: result.updated, total: result.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to sync preview/front/back" });
  }
});

// PUT /api/admin/templates/:templateId – update
app.put("/api/admin/templates/:templateId", async (req, res) => {
  const templateId = decodeURIComponent((req.params.templateId || "").trim());
  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }
  const body = req.body || {};
  const { template, name, parentName, productDetailsTitle, productDetails, properties, categoryId, subcategoryId } = body;
  if (template && (!template.front?.fields || !template.back?.fields)) {
    return res.status(400).json({ error: "Template must have front.fields and back.fields" });
  }
  try {
    const existing = await getTemplateById(templateId);
    if (template && existing?.template) {
      const updateImageError = validateImageSlotsForUpdate(template, existing.template);
      if (updateImageError) {
        return res.status(400).json({ error: updateImageError });
      }
    }
 
    const replacedUploadIds = [];
    if (existing?.template && template) {
      const oldSlots = {
        thumbnailImage: existing.template.thumbnailImage,
        frontBg: existing.template.front?.backgroundImage,
        backBg: existing.template.back?.backgroundImage,
      };
      const newSlots = {
        thumbnailImage: template.thumbnailImage,
        frontBg: template.front?.backgroundImage,
        backBg: template.back?.backgroundImage,
      };
      for (const key of ["thumbnailImage", "frontBg", "backBg"]) {
        const oldVal = oldSlots[key];
        const newVal = newSlots[key];
        if (typeof oldVal === "string" && oldVal !== newVal && isUploadId(oldVal)) {
          replacedUploadIds.push(oldVal);
        }
      }
    }

    const record = existing
      ? {
          ...existing,
          ...(template && { template: { ...template, id: existing.id } }),
          ...(name !== undefined && { name }),
          ...(parentName !== undefined && { parentName }),
          ...(categoryId !== undefined && { categoryId }),
          ...(subcategoryId !== undefined && { subcategoryId }),
          ...(productDetailsTitle !== undefined && { productDetailsTitle }),
          ...(productDetails !== undefined && { productDetails }),
          ...(properties !== undefined && { properties }),
        }
      : {
          templateId,
          name: name ?? "Untitled",
          template: template
            ? { ...template, id: templateId }
            : {
                id: templateId,
                name: name ?? "Untitled",
                aspectRatio: 2.5 / 3.5,
                front: { fields: [], backgroundCss: { color: "#e2e8f0" } },
                back: { fields: [], backgroundCss: { color: "#e2e8f0" } },
              },
          ...(categoryId !== undefined && { categoryId }),
          ...(subcategoryId !== undefined && { subcategoryId }),
          ...(productDetailsTitle !== undefined && { productDetailsTitle }),
          ...(productDetails !== undefined && { productDetails }),
          ...(properties !== undefined && { properties }),
        };
    const ok = await upsertTemplate(record);
    if (!ok) {
      return res.status(503).json({ error: "Database not configured (set MONGODB_URI)" });
    }

    // When updating a variation with parentName, update the parent's parentName so client display stays in sync.
    if (existing?.parentId && parentName !== undefined) {
      const parent = await getTemplateById(existing.parentId);
      if (parent) {
        await upsertTemplate({ ...parent, parentName: parentName.trim() || parent.parentName || "" });
      }
    }

    // Keep variation cards under the same design using one shared preview image.
    if (template?.thumbnailImage !== undefined && existing?.id) {
      const designId = existing.parentId || existing.id;
      const all = await listTemplates();
      const siblings = all.filter(
        (r) => r.id !== existing.id && (r.parentId === designId || r.id === designId)
      );
      for (const sibling of siblings) {
        const next = {
          ...sibling,
          template: {
            ...sibling.template,
            thumbnailImage: template.thumbnailImage,
          },
        };
        await upsertTemplate(next);
      }
    }

    // Variations can share image uploads with parent/siblings. To avoid accidental
    // deletion while editing a variation, only auto-clean replaced uploads when
    // updating a parent (or standalone) template.
    if (!existing?.parentId) {
      for (const uploadId of replacedUploadIds) {
        await cleanupUploadIfUnused(uploadId);
      }
    }

    res.json({ ok: true, templateId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// DELETE /api/admin/templates/:templateId
app.delete("/api/admin/templates/:templateId", async (req, res) => {
  const templateId = decodeURIComponent((req.params.templateId || "").trim());
  if (!templateId) {
    return res.status(400).json({ error: "Missing templateId" });
  }
  try {
    const deleted = await deleteTemplateById(templateId);
    if (!deleted) {
      return res.status(404).json({ error: "Not found or DB not configured" });
    }
    res.json({ ok: true, templateId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// --- Categories ---
app.get("/api/categories", async (_req, res) => {
  try {
    const list = await listCategories();
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list categories" });
  }
});

app.post("/api/admin/categories", async (req, res) => {
  const { id, name, order } = req.body || {};
  if (!id?.trim() || !name?.trim()) {
    return res.status(400).json({ error: "Missing id or name" });
  }
  try {
    const normalizedId = id.trim();
    const existing = await getCategoryById(normalizedId);
    if (existing) {
      return res.status(409).json({ error: "ID already exists" });
    }
    const ok = await upsertCategory({ id: normalizedId, name: name.trim(), ...(order != null ? { order: Number(order) } : {}) });
    if (!ok) return res.status(503).json({ error: "Database not configured" });
    res.json({ ok: true, id: normalizedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save category" });
  }
});

app.put("/api/admin/categories/:id", async (req, res) => {
  const id = (req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const { name, order } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Missing name" });
  try {
    const ok = await upsertCategory({ id, name: name.trim(), ...(order != null ? { order: Number(order) } : {}) });
    if (!ok) return res.status(503).json({ error: "Database not configured" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update category" });
  }
});

app.delete("/api/admin/categories/:id", async (req, res) => {
  const id = (req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    const deleted = await deleteCategoryById(id);
    if (!deleted) return res.status(404).json({ error: "Not found or DB not configured" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

app.post("/api/admin/categories/seed-defaults", async (_req, res) => {
  try {
    for (const c of DEFAULT_CATEGORIES) {
      await upsertCategory(c);
    }
    for (const s of DEFAULT_SUBCATEGORIES) {
      await upsertSubcategory(s);
    }
    res.json({
      ok: true,
      categoriesSeeded: DEFAULT_CATEGORIES.length,
      subcategoriesSeeded: DEFAULT_SUBCATEGORIES.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to seed defaults" });
  }
});

// --- Subcategories ---
app.get("/api/subcategories", async (req, res) => {
  const categoryId = req.query.categoryId;
  try {
    const list = await listSubcategories(categoryId || null);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list subcategories" });
  }
});

app.post("/api/admin/subcategories", async (req, res) => {
  const { id, name, categoryId, order } = req.body || {};
  if (!id?.trim() || !name?.trim() || !categoryId?.trim()) {
    return res.status(400).json({ error: "Missing id, name, or categoryId" });
  }
  try {
    const normalizedId = id.trim();
    const normalizedCategoryId = categoryId.trim();
    const existing = await getSubcategoryById(normalizedId);
    if (existing) {
      return res.status(409).json({ error: "ID already exists" });
    }
    const category = await getCategoryById(normalizedCategoryId);
    if (!category) {
      return res.status(400).json({ error: "Invalid categoryId" });
    }
    const ok = await upsertSubcategory({
      id: normalizedId,
      name: name.trim(),
      categoryId: normalizedCategoryId,
      ...(order != null ? { order: Number(order) } : {}),
    });
    if (!ok) return res.status(503).json({ error: "Database not configured" });
    res.json({ ok: true, id: normalizedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save subcategory" });
  }
});

app.put("/api/admin/subcategories/:id", async (req, res) => {
  const id = (req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing id" });
  const { name, categoryId, order } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Missing name" });
  try {
    const normalizedCategoryId = (categoryId || "").trim();
    if (!normalizedCategoryId) return res.status(400).json({ error: "Missing categoryId" });
    const category = await getCategoryById(normalizedCategoryId);
    if (!category) return res.status(400).json({ error: "Invalid categoryId" });
    const ok = await upsertSubcategory({
      id,
      name: name.trim(),
      categoryId: normalizedCategoryId,
      ...(order != null ? { order: Number(order) } : {}),
    });
    if (!ok) return res.status(503).json({ error: "Database not configured" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update subcategory" });
  }
});

app.delete("/api/admin/subcategories/:id", async (req, res) => {
  const id = (req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    const deleted = await deleteSubcategoryById(id);
    if (!deleted) return res.status(404).json({ error: "Not found or DB not configured" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete subcategory" });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI not set – template APIs will return 503");
  } else {
    try {
      await ensureDatabase();
      await ensureUploadsCollection();
      await ensureCategoriesCollections();
      const currentTemplates = await listTemplates();
      const hasPetsTemplates = currentTemplates.some(
        (t) => t.categoryId === "pets" || String(t.templateId || "").startsWith("pets/")
      );
      if (currentTemplates.length === 0 || !hasPetsTemplates) {
        const seeded = await seedLegacyTemplatesFromFile();
        console.log(`Auto-seeded ${seeded} templates from legacy file (pets/templates recovery)`);
      }
      await ensureTemplateIds();
      await ensureParentIds();
      console.log("MongoDB database and collection ready");
    } catch (err) {
      console.error("MongoDB ensureDatabase failed:", err.message);
    }
  }
});
