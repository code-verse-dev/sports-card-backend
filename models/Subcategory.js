import mongoose from "mongoose";

const subcategorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    categoryId: { type: String, required: true },
    order: Number,
  },
  { timestamps: true }
);

export const Subcategory = mongoose.model("Subcategory", subcategorySchema, "subcategories");
