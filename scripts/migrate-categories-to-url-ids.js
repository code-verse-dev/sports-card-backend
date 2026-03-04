/**
 * One-time migration: update categories, subcategories, and templates from old ids to URL-style ids.
 * Run with: node scripts/migrate-categories-to-url-ids.js
 * Requires MONGODB_URI in env (or .env).
 */
import "dotenv/config";
import { connectDB, dbConnected } from "../db.js";
import { Category } from "../models/Category.js";
import { Subcategory } from "../models/Subcategory.js";
import { Template } from "../models/Template.js";
import { CATEGORY_OLD_TO_NEW, SUBCATEGORY_OLD_TO_NEW } from "../seed-categories.js";

async function migrate() {
  await connectDB();
  if (!dbConnected()) {
    console.error("MONGODB_URI not set. Aborting.");
    process.exit(1);
  }

  let catUpdated = 0;
  let subUpdated = 0;
  let templateUpdated = 0;

  for (const [oldId, newId] of Object.entries(CATEGORY_OLD_TO_NEW)) {
    if (oldId === newId) continue;
    const result = await Category.updateMany({ id: oldId }, { $set: { id: newId } });
    if (result.modifiedCount) catUpdated += result.modifiedCount;
  }

  for (const [key, { categoryId: newCatId, subcategoryId: newSubId }] of Object.entries(SUBCATEGORY_OLD_TO_NEW)) {
    const [oldCatId, oldSubId] = key.split("/");
    const result = await Subcategory.updateMany(
      { id: oldSubId, categoryId: oldCatId },
      { $set: { id: newSubId, categoryId: newCatId } }
    );
    if (result.modifiedCount) subUpdated += result.modifiedCount;
  }

  const templates = await Template.find({}).lean();
  for (const t of templates) {
    const oldCat = t.categoryId;
    const oldSub = t.subcategoryId;
    if (!oldCat && !oldSub) continue;
    const newCat = oldCat ? (CATEGORY_OLD_TO_NEW[oldCat] ?? oldCat) : null;
    const key = oldCat && oldSub ? `${oldCat}/${oldSub}` : null;
    const mapped = key ? SUBCATEGORY_OLD_TO_NEW[key] : null;
    const newSub = mapped ? mapped.subcategoryId : (oldSub ?? null);
    if (newCat !== oldCat || newSub !== oldSub) {
      await Template.updateOne(
        { _id: t._id },
        {
          $set: {
            ...(newCat ? { categoryId: newCat } : {}),
            ...(newSub != null ? { subcategoryId: newSub } : {}),
          },
        }
      );
      templateUpdated += 1;
    }
  }

  console.log("Migration done. Categories updated:", catUpdated, "Subcategories:", subUpdated, "Templates:", templateUpdated);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});

// one time migration to update the categories to url ids
