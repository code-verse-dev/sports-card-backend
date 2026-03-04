import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const adminUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, default: "admin" },
  },
  { timestamps: true }
);

adminUserSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const AdminUser = mongoose.model("AdminUser", adminUserSchema);

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}
