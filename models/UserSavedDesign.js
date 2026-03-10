import mongoose from "mongoose";

/**
 * A saved design (created template) for a logged-in customer.
 * Stores snapshot of field values and font overrides so the user can resume editing or re-order later.
 */
const userSavedDesignSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerUser", required: true, index: true },
    templateId: { type: String, required: true, trim: true },
    templateName: { type: String, trim: true },
    name: { type: String, trim: true },
    designSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    designFontOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

userSavedDesignSchema.index({ userId: 1, createdAt: -1 });

export const UserSavedDesign = mongoose.model("UserSavedDesign", userSavedDesignSchema);
