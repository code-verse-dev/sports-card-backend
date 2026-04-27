import mongoose from "mongoose";
import { ensureUniqueOrderCode } from "../services/publicCodes.js";

const orderSchema = new mongoose.Schema(
  {
    /** Unique 9-char A–Z0–9 reference for emails, admin, PDFs. Auto-assigned on save. */
    orderCode: { type: String, unique: true, sparse: true, trim: true, uppercase: true },
    status: {
      type: String,
      required: true,
      default: "pending",
      enum: ["pending", "pending_payment", "payment_failed", "confirmed", "in_production", "shipped", "delivered", "cancelled"],
    },
    stripeSessionId: { type: String, sparse: true },
    /** stripe | paypal | manual — how the customer paid (or bypass). */
    paymentProvider: { type: String, trim: true, sparse: true, index: true },
    /** Gateway reference: Stripe PaymentIntent id, Checkout Session id, PayPal capture id, or PayPal order id while awaiting capture. */
    paymentReferenceId: { type: String, trim: true, sparse: true, index: true },
    /** PayPal purchase_units.reference_id for pending_payment PayPal drafts (matches capture placementRef). */
    paypalPlacementRef: { type: String, trim: true, sparse: true, index: true },
    /** Client-generated id (sessionStorage) for one browser tab’s checkout; survives reload; cleared after pay/cancel. */
    checkoutBrowserSessionId: { type: String, trim: true, sparse: true, index: true },
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
    /** Automatic promo/team discount (merchandise); charged amount uses totalCents − discountCents + shipping + tax. */
    discountCents: { type: Number, default: 0 },
    shippingCents: Number,
    /** Tax in cents (card checkout); included in Stripe PaymentIntent amount. */
    taxCents: { type: Number, default: 0 },
    /** Last Stripe/client payment error message for admin (e.g. decline reason). */
    paymentLastError: { type: String, trim: true },
    notes: String,
    createAccount: Boolean,
    /** Carrier for tracking (default UPS). */
    trackingCarrier: { type: String, default: "UPS", trim: true },
    /** Shipping tracking number (e.g. UPS). */
    trackingNumber: { type: String, trim: true },
    /** Optional full tracking URL; if empty, UPS URL is derived from trackingNumber when carrier is UPS. */
    trackingUrl: { type: String, trim: true },
  },
  { timestamps: true }
);

/** List/sort: admin orders. Email filter still uses regex (no index). */
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

orderSchema.pre("save", async function orderCodePreSave(next) {
  try {
    if (!this.orderCode) {
      this.orderCode = await ensureUniqueOrderCode(this.constructor);
    } else {
      this.orderCode = String(this.orderCode).trim().toUpperCase();
    }
    next();
  } catch (e) {
    next(e);
  }
});

export const Order = mongoose.model("Order", orderSchema);
