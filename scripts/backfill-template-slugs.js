/**
 * Backfill template slugs so product URLs use /product/slug/preview instead of /product/UUID/preview.
 * Run: node scripts/backfill-template-slugs.js (from server/) or node server/scripts/backfill-template-slugs.js (from root).
 * Requires MONGODB_URI in server/.env or environment.
 */
import "../load-env.js";

import { connectDB, dbConnected } from "../db.js";
import { Template } from "../models/Template.js";

const MONGO_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLikelySlug(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 2) return false;
  if (MONGO_ID_REGEX.test(t) || UUID_REGEX.test(t)) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.toLowerCase());
}

function slugify(name) {
  if (!name || typeof name !== "string") return "template";
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "template";
}

async function run() {
  await connectDB();
  if (!dbConnected()) {
    console.error("MONGODB_URI not set. Aborting.");
    process.exit(1);
  }

  const templates = await Template.find({}).lean();
  const used = new Set();
  let updated = 0;
  let skipped = 0;

  for (const t of templates) {
    const existingId = (t.id && String(t.id).trim()) || (t.templateId && String(t.templateId).trim());
    if (existingId && isLikelySlug(existingId)) {
      skipped++;
      used.add(existingId.toLowerCase());
      continue;
    }

    const baseSlug = slugify(t.name || t.parentName || "template");
    let slug = baseSlug;
    let n = 1;
    while (used.has(slug)) {
      slug = `${baseSlug}-${n}`;
      n++;
    }
    used.add(slug);

    const legacyIds = [];
    if (existingId && (UUID_REGEX.test(existingId) || MONGO_ID_REGEX.test(existingId))) legacyIds.push(existingId);
    if (t.templateId && t.templateId !== existingId && (UUID_REGEX.test(t.templateId) || MONGO_ID_REGEX.test(t.templateId))) legacyIds.push(t.templateId);

    await Template.updateOne(
      { _id: t._id },
      {
        $set: {
          id: slug,
          templateId: t.templateId && isLikelySlug(t.templateId) ? t.templateId : slug,
          ...(legacyIds.length ? { legacyIds } : {}),
        },
      }
    );
    updated++;
    console.log(`  ${t.name || t._id} -> ${slug}`);
  }

  console.log("Done. Updated:", updated, "Skipped (already had slug):", skipped);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
