import mongoose from "mongoose";
const templateSchema = new mongoose.Schema(
  {
    id: { type: String, sparse: true, unique: true },
    templateId: { type: String, sparse: true, unique: true },
    legacyIds: [String],
    name: { type: String, required: true },
    parentName: { type: String, default: "" },
    template: { type: mongoose.Schema.Types.Mixed, required: true },
    categoryId: String,
    subcategoryId: String,
    preview: String,
    front: String,
    back: String,
    parentId: { type: String, default: null },
    isParent: Boolean,
    productDetailsTitle: String,
    productDetails: String,
    properties: [mongoose.Schema.Types.Mixed],
  },
  { timestamps: true, strict: false }
);

export const Template = mongoose.model("Template", templateSchema, "templates");
