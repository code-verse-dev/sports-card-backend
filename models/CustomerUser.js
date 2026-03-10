import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const customerUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
  },
  { timestamps: true }
);

customerUserSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const CustomerUser = mongoose.model("CustomerUser", customerUserSchema);

export async function hashCustomerPassword(password) {
  return bcrypt.hash(password, 10);
}
