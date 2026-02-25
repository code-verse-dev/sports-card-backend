import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    order: Number,
  },
  { timestamps: true }
);

export const Category = mongoose.model("Category", categorySchema, "categories");
