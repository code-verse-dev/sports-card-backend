import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    status: { type: String, required: true, default: "pending", enum: ["pending", "pending_payment", "confirmed", "in_production", "shipped", "delivered", "cancelled"] },
    stripeSessionId: { type: String, sparse: true },
    customer: {
      email: String,
      firstName: String,
      lastName: String,
      phone: String,
      address: String,
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
