import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ensureUniqueCustomerPublicId } from "../services/publicCodes.js";

const CUSTOMER_BODY = 8;

const customerUserSchema = new mongoose.Schema(
  {
    /**
     * Human id: G + 8 (guest) or R + 8 (registered), A–Z0–9 without I,O,0,1.
     * Upgrades from G… to R… (same body) when the account gains a password.
     */
    publicId: { type: String, unique: true, sparse: true, trim: true, uppercase: true, index: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    /** Set when the customer can sign in. Guests (checkout only) have no password until they register or admin sets one. */
    passwordHash: { type: String, required: false, default: null, select: false },
    /** True if password was set (login allowed). */
    isRegistered: { type: Boolean, default: false, index: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zip: { type: String, trim: true },
    country: { type: String, trim: true },
    /** Checkout-upload file id (uuid or uuid.ext) for profile photo in My account. */
    avatarImageRef: { type: String, trim: true },
    /** Short-lived forgot-password code hash. */
    passwordResetCodeHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    passwordResetAttempts: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

customerUserSchema.pre("save", async function customerPublicIdPreSave(next) {
  try {
    if (this.isModified("passwordHash") && this.passwordHash) {
      this.isRegistered = true;
    }

    if (!this.publicId) {
      const hasAccount = Boolean(this.isRegistered || this.passwordHash);
      const prefix = hasAccount ? "R" : "G";
      this.publicId = await ensureUniqueCustomerPublicId(this.constructor, prefix, this._id);
    } else {
      this.publicId = String(this.publicId).trim().toUpperCase();
    }

    if (this.publicId?.startsWith("G") && (this.isRegistered || this.passwordHash)) {
      const tail = this.publicId.slice(1);
      if (tail.length === CUSTOMER_BODY) {
        const candidate = "R" + tail;
        const exists = await this.constructor.exists({ publicId: candidate, _id: { $ne: this._id } });
        if (!exists) this.publicId = candidate;
      }
    }

    next();
  } catch (e) {
    next(e);
  }
});

customerUserSchema.methods.comparePassword = async function (plain) {
  if (typeof plain !== "string" || !plain) return false;
  if (typeof this.passwordHash !== "string" || !this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

export const CustomerUser = mongoose.model("CustomerUser", customerUserSchema);

export async function hashCustomerPassword(password) {
  return bcrypt.hash(password, 10);
}
