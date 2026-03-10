import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    status: { type: String, required: true, default: "pending", enum: ["pending", "pending_payment", "confirmed", "in_production", "shipped", "delivered", "cancelled"] },
    stripeSessionId: { type: String, sparse: true },
    /** When set, My Orders matches by this; otherwise by customer.email (case-insensitive). */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerUser", default: null },
    customer: {
      email: String,
      firstName: String,
      lastName: String,
      phone: String,
      address: String,
      company: String,
      addressLine2: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },
    items: [{ type: mongoose.Schema.Types.Mixed }],
    totalCents: Number,
    shippingCents: Number,
    notes: String,
    createAccount: Boolean,
  },
  { timestamps: true }
);

export const Order = mongoose.model("Order", orderSchema);
