/**
 * Template CRUD using Mongoose.
 * Set MONGODB_URI in .env (e.g. mongodb://localhost:27017).
 */
import { connect, getClient } from "./connection.js";
import { Template } from "./models/Template.js";

export { getClient };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === "string" && UUID_REGEX.test(v.trim());
}
/** Keep image ref as provided (supports UUID-only and any extension). */
function withImageExt(v) {
  if (!v || typeof v !== "string") return v;
  return v.trim();
}

/** Create database and indexes on startup. */
export async function ensureDatabase() {
  const ok = await connect();
  if (!ok) return;
  await Template.syncIndexes().catch(() => {});
}

/** Get by id (UUID) or legacy templateId. Resolves preview for variations (reuse parent's). */
export async function getTemplateById(idOrTemplateId) {
  await connect();
  const key = String(idOrTemplateId || "").trim();
  if (!key) return null;
  const doc = isUuid(key)
    ? await Template.findOne({ id: key }).lean()
    : await Template.findOne({ templateId: key }).lean();
  if (!doc) return null;
  if (doc.parentId) {
    const parent = await Template.findOne({ id: doc.parentId }).lean();
    if (parent) {
      if (!doc.preview) doc.preview = parent.preview;
      if (parent.parentName != null && parent.parentName !== "") doc.parentName = parent.parentName;
    }
  }
  return doc;
}

export async function listTemplates() {
  await connect();
  const list = await Template.find({}).sort({ name: 1 }).lean();
  const byId = new Map(list.map((d) => [d.id, d]));
  for (const doc of list) {
    if (!doc.preview && doc.parentId) doc.preview = byId.get(doc.parentId)?.preview ?? null;
  }
  return list;
}

export async function upsertTemplate(record) {
  await connect();
  const filter = record.id ? { id: record.id } : { templateId: record.templateId };
  if (!filter.id && !filter.templateId) return false;
  const t = record.template || {};
  const payload = {
    ...record,
    updatedAt: new Date(),
    front: withImageExt(t.front?.backgroundImage ?? record.front ?? undefined),
    back: withImageExt(t.back?.backgroundImage ?? record.back ?? undefined),
  };
  if (record.isParent) payload.preview = withImageExt(t.previewImage ?? t.thumbnailImage ?? record.preview ?? undefined);
  await Template.updateOne(filter, { $set: payload }, { upsert: true });
  return true;
}

/** Sync top-level preview, front, back from nested template for all documents. Run once to backfill. */
export async function syncTemplateImageLinks() {
  await connect();
  const list = await Template.find({}).lean();
  let updated = 0;
  for (const doc of list) {
    const t = doc.template || {};
    const front = withImageExt((t.front && t.front.backgroundImage) ? String(t.front.backgroundImage).trim() : "");
    const back = withImageExt((t.back && t.back.backgroundImage) ? String(t.back.backgroundImage).trim() : "");
    const preview = doc.isParent ? withImageExt((t.previewImage || t.thumbnailImage || "").trim()) : "";
    const same = (doc.front || "") === front && (doc.back || "") === back && (doc.preview || "") === preview;
    if (same) continue;
    const set = { front: front || null, back: back || null, updatedAt: new Date() };
    if (doc.isParent) set.preview = preview || null;
    const result = await Template.updateOne({ id: doc.id }, { $set: set });
    if (result.modifiedCount > 0) updated += 1;
  }
  return { updated, total: list.length };
}

/** Update an existing document by templateId. When setPayload contains template, syncs top-level preview, front, back in DB. */
export async function updateTemplateByTemplateId(templateId, setPayload) {
  await connect();
  const set = { ...setPayload, updatedAt: new Date() };
  if (setPayload.template) {
    const t = setPayload.template;
    set.front = withImageExt((t.front && t.front.backgroundImage) ? String(t.front.backgroundImage).trim() : "") || null;
    set.back = withImageExt((t.back && t.back.backgroundImage) ? String(t.back.backgroundImage).trim() : "") || null;
    const doc = await Template.findOne({ templateId: String(templateId) }).select("isParent").lean();
    if (doc && doc.isParent) {
      set.preview = withImageExt((t.previewImage || t.thumbnailImage || "").trim()) || null;
    }
  }
  const result = await Template.updateOne(
    { templateId: String(templateId) },
    { $set: set }
  );
  return result.matchedCount > 0;
}

/** Delete by id (UUID) or legacy templateId. */
export async function deleteTemplateById(idOrTemplateId) {
  await connect();
  const key = String(idOrTemplateId || "").trim();
  if (!key) return false;
  const filter = isUuid(key) ? { id: key } : { templateId: key };
  const result = await Template.deleteOne(filter);
  return result.deletedCount > 0;
}
