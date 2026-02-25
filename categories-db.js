/**
 * Categories and subcategories using Mongoose.
 */
import { connect } from "./connection.js";
import { Category } from "./models/Category.js";
import { Subcategory } from "./models/Subcategory.js";

export async function ensureCategoriesCollections() {
  const ok = await connect();
  if (!ok) return;
  await Category.syncIndexes().catch(() => {});
  await Subcategory.syncIndexes().catch(() => {});
}

export async function listCategories() {
  await connect();
  const list = await Category.find({}).sort({ order: 1, name: 1 }).lean();
  return list;
}

export async function getCategoryById(id) {
  await connect();
  const doc = await Category.findOne({ id }).lean();
  return doc;
}

export async function upsertCategory(record) {
  await connect();
  const { id, name, order } = record;
  if (!id || !name) return false;
  await Category.updateOne(
    { id },
    {
      $set: {
        id,
        name,
        ...(typeof order === "number" ? { order } : {}),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return true;
}

export async function deleteCategoryById(id) {
  await connect();
  const result = await Category.deleteOne({ id });
  return result.deletedCount > 0;
}

export async function listSubcategories(categoryId) {
  await connect();
  const q = categoryId ? { categoryId } : {};
  const list = await Subcategory.find(q).sort({ categoryId: 1, order: 1, name: 1 }).lean();
  return list;
}

export async function getSubcategoryById(id) {
  await connect();
  const doc = await Subcategory.findOne({ id }).lean();
  return doc;
}

export async function upsertSubcategory(record) {
  await connect();
  const { id, name, categoryId, order } = record;
  if (!id || !name || !categoryId) return false;
  await Subcategory.updateOne(
    { id },
    {
      $set: {
        id,
        name,
        categoryId,
        ...(typeof order === "number" ? { order } : {}),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return true;
}

export async function deleteSubcategoryById(id) {
  await connect();
  const result = await Subcategory.deleteOne({ id });
  return result.deletedCount > 0;
}
