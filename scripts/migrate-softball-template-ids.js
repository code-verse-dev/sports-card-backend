/**
 * Option A: Fix softball product URLs in the DB only (no frontend changes).
 *
 * Problem: templateId values like sports/softball/softball-2/Orange resolve to slug "Orange"
 * and collide with other products.
 *
 * This script sets unique templateId paths and keeps old values in legacyIds.
 * UUID `id` fields are left unchanged so existing references keep working.
 *
 * Run (from sports-card-backend):
 *   node scripts/migrate-softball-template-ids.js           # dry run
 *   node scripts/migrate-softball-template-ids.js --apply   # write to DB
 *
 * Requires MONGODB_URI in .env or environment.
 */
import "../load-env.js";

import { connectDB, dbConnected } from "../db.js";
import { Template } from "../models/Template.js";

const APPLY = process.argv.includes("--apply");
const PREFIX = "sports-cards-trading-cards/softball";
const ALREADY_MIGRATED = /^sports-cards-trading-cards\/softball\/softball-option-\d/i;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function colorSegmentToSlug(segment) {
  return String(segment ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/** Infer design option 1 or 2 from templateId, parentName, or name. */
function inferOption(t) {
  const hay = [t.templateId, t.parentName, t.name].filter(Boolean).join(" ");
  const m = hay.match(/softball[-\s]*(\d)/i) || hay.match(/option\s*(\d)/i);
  if (m) return m[1];
  return null;
}

function resolveNewTemplateId(t) {
  const current = String(t.templateId ?? "").trim();
  if (current && ALREADY_MIGRATED.test(current)) return null;

  if (t.isParent) {
    const opt = inferOption(t);
    if (!opt) return null;
    return `${PREFIX}/softball-option-${opt}`;
  }

  const pathMatch = current.match(/softball-(\d)\/([^/]+)$/i);
  if (pathMatch) {
    const opt = pathMatch[1];
    const color = colorSegmentToSlug(pathMatch[2]);
    if (!color) return null;
    if (color === "master") return `${PREFIX}/softball-option-${opt}`;
    return `${PREFIX}/softball-option-${opt}-${color}`;
  }

  const opt = inferOption(t);
  const nameColor = String(t.name ?? "").match(/[–-]\s*([A-Za-z]+)\s*$/);
  if (opt && nameColor) {
    const color = colorSegmentToSlug(nameColor[1]);
    if (color) return `${PREFIX}/softball-option-${opt}-${color}`;
  }

  return null;
}

function collectLegacyIds(t, oldTemplateId) {
  const legacy = new Set(Array.isArray(t.legacyIds) ? t.legacyIds.map(String) : []);
  if (oldTemplateId) legacy.add(oldTemplateId);
  const id = String(t.id ?? "").trim();
  if (id && id === oldTemplateId) legacy.add(id);
  return [...legacy];
}

async function run() {
  await connectDB();
  if (!dbConnected()) {
    console.error("MONGODB_URI not set. Aborting.");
    process.exit(1);
  }

  const templates = await Template.find({
    subcategoryId: /^softball$/i,
  }).lean();

  console.log(`Found ${templates.length} softball template(s). Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  let wouldUpdate = 0;
  let skipped = 0;
  let errors = 0;

  for (const t of templates) {
    const oldTemplateId = String(t.templateId ?? "").trim();
    const newTemplateId = resolveNewTemplateId(t);

    if (!newTemplateId) {
      skipped++;
      console.log(`  SKIP  ${t.name || t._id}  (templateId=${oldTemplateId || "(empty)"})`);
      continue;
    }

    if (oldTemplateId === newTemplateId) {
      skipped++;
      continue;
    }

    const taken = await Template.findOne({
      _id: { $ne: t._id },
      $or: [{ id: newTemplateId }, { templateId: newTemplateId }],
    }).lean();

    const legacyIds = collectLegacyIds(t, oldTemplateId);
    const id = String(t.id ?? "").trim();

    if (taken) {
      // e.g. "Master" parent duplicate — keep legacy path on this row only
      wouldUpdate++;
      console.log(`  ${APPLY ? "LEGACY" : "WOULD LEGACY"}  ${t.name} (canonical id already on ${taken.name})`);
      console.log(`         templateId unchanged: ${oldTemplateId}`);
      if (legacyIds.length) console.log(`         legacyIds += ${legacyIds.filter((x) => x !== oldTemplateId).join(", ")}`);
      if (APPLY && legacyIds.length) {
        await Template.updateOne({ _id: t._id }, { $addToSet: { legacyIds: { $each: legacyIds } } });
      }
      continue;
    }

    const update = {
      templateId: newTemplateId,
      ...(legacyIds.length ? { legacyIds } : {}),
    };
    if (id && id === oldTemplateId) {
      update.id = newTemplateId;
    }

    wouldUpdate++;
    console.log(`  ${APPLY ? "UPDATE" : "WOULD"}  ${t.name}`);
    console.log(`         templateId: ${oldTemplateId || "(empty)"} -> ${newTemplateId}`);
    console.log(`         id kept: ${id && id !== oldTemplateId ? id : "(unchanged or synced)"}`);
    if (legacyIds.length) console.log(`         legacyIds += ${legacyIds.filter((x) => x !== newTemplateId).join(", ")}`);

    if (APPLY) {
      await Template.updateOne({ _id: t._id }, { $set: update });
    }
  }

  console.log(`\nDone. ${APPLY ? "Updated" : "Would update"}: ${wouldUpdate}, Skipped: ${skipped}, Errors: ${errors}`);
  if (!APPLY && wouldUpdate > 0) {
    console.log("\nRe-run with --apply to write changes:");
    console.log("  node scripts/migrate-softball-template-ids.js --apply");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
