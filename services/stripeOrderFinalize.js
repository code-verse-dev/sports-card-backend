import { Order } from "../models/Order.js";
import { CustomerUser } from "../models/CustomerUser.js";
import { upsertCustomerFromCheckout } from "./customerProfile.js";
import { getOrderCustomerView } from "./orderCustomer.js";
import { notifyOrderPlaced } from "./orderEmails.js";
import { invalidateAdminStatsCache } from "./adminStatsCache.js";

import { sumItemsMerchandiseCents, computeAutoDiscountCents } from "./cartDiscounts.js";

function sumItemsCents(items) {
  return sumItemsMerchandiseCents(items);
}

/** Expected PI amount in cents from a persisted draft order. */
export function expectedCentsFromOrder(order) {
  if (!order) return 0;
  const tax = Number(order.taxCents) || 0;
  const rawDisc = order.discountCents;
  const disc =
    rawDisc != null && Number.isFinite(Number(rawDisc))
      ? Number(rawDisc)
      : computeAutoDiscountCents(order.items || []);
  return sumItemsCents(order.items) - disc + (Number(order.shippingCents) || 0) + tax;
}

function isLikelyMongoObjectId(s) {
  return typeof s === "string" && s.length === 24 && /^[a-f0-9]+$/i.test(s);
}

/** Map Stripe charge billing_details to our customer shape. */
function customerFromStripeBilling(bd) {
  if (!bd) return null;
  const email = (bd.email && String(bd.email).trim()) || "";
  if (!email) return null;
  const name = (bd.name && String(bd.name).trim()) || "";
  const parts = name ? name.split(/\s+/).filter(Boolean) : [];
  const firstName = parts[0] || undefined;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  const line1 = bd.address?.line1;
  const line2 = bd.address?.line2;
  const out = { email, firstName, lastName };
  if (line1) out.address = [line1, line2].filter(Boolean).join(", ");
  else if (line2) out.address = String(line2);
  if (bd.address?.city) out.city = String(bd.address.city).trim();
  if (bd.address?.state) out.state = String(bd.address.state).trim();
  if (bd.address?.postal_code) out.zip = String(bd.address.postal_code).trim();
  if (bd.address?.country) out.country = String(bd.address.country).trim();
  if (bd.phone) out.phone = String(bd.phone).trim();
  return out;
}

/**
 * Load draft order for a succeeded PaymentIntent (paymentReferenceId or metadata.orderId).
 * @returns {import("mongoose").Document | null}
 */
export async function findPendingStripeDraftForPaymentIntent(paymentIntent) {
  const piId = paymentIntent.id;
  let prev = await Order.findOne({ paymentReferenceId: piId, status: "pending_payment" });
  if (prev) return prev;
  const oid = paymentIntent.metadata?.orderId;
  if (oid && isLikelyMongoObjectId(String(oid).trim())) {
    const o = await Order.findById(String(oid).trim());
    if (o && o.status === "pending_payment" && String(o.paymentReferenceId || "") === String(piId)) {
      return o;
    }
  }
  return null;
}

/**
 * Confirm a pending_payment Stripe draft after PI succeeded. Idempotent if already confirmed.
 * @param {import("stripe").Stripe} stripe
 * @param {import("stripe").Stripe.PaymentIntent} paymentIntent
 * @param {{ requestCustomer?: object; customerUser?: import("mongoose").Document | null }} ctx
 * @returns {Promise<{ ok: true; order: object } | { ok: false; code: string }>}
 */
export async function finalizeStripeDraftOrderFromSucceededIntent(stripe, paymentIntent, ctx = {}) {
  const { requestCustomer, customerUser } = ctx;
  if (paymentIntent.status !== "succeeded") {
    return { ok: false, code: "not_succeeded" };
  }
  const piId = paymentIntent.id;

  const existingConfirmed = await Order.findOne({ paymentReferenceId: piId, status: "confirmed" });
  if (existingConfirmed) {
    return { ok: true, order: existingConfirmed };
  }

  const prev = await findPendingStripeDraftForPaymentIntent(paymentIntent);
  if (!prev) {
    return { ok: false, code: "no_draft" };
  }

  const expectedCents = expectedCentsFromOrder(prev);
  if (expectedCents !== paymentIntent.amount) {
    return { ok: false, code: "amount_mismatch" };
  }

  const ch = paymentIntent.latest_charge;
  const fromStripeObj =
    typeof ch === "object" && ch && ch.billing_details ? customerFromStripeBilling(ch.billing_details) : null;
  const mergedForSave = { ...(fromStripeObj || {}), ...(requestCustomer || {}) };

  const orderId = String(prev._id);
  const update = { status: "confirmed", paymentProvider: "stripe", paymentReferenceId: piId };
  if (requestCustomer?.notes != null && String(requestCustomer.notes).trim()) {
    update.notes = String(requestCustomer.notes).trim();
  }
  const rawPrevC = prev.customer;
  const prevC =
    rawPrevC && typeof rawPrevC === "object"
      ? typeof rawPrevC.toObject === "function"
        ? rawPrevC.toObject()
        : { ...rawPrevC }
      : {};
  const profileMerge = { ...prevC, ...mergedForSave, email: mergedForSave.email || prevC.email || undefined };
  if (profileMerge.email) {
    await upsertCustomerFromCheckout(profileMerge);
  }
  if (customerUser?._id) {
    update.customerId = customerUser._id;
  } else {
    const e = String(profileMerge.email || "").trim().toLowerCase();
    if (e) {
      const u = await CustomerUser.findOne({ email: e });
      if (u) update.customerId = u._id;
      else if (prev.customerId) update.customerId = prev.customerId;
    } else if (prev.customerId) {
      update.customerId = prev.customerId;
    }
  }

  const order = await Order.findByIdAndUpdate(orderId, { $set: update, $unset: { customer: "", paymentLastError: "" } }, { new: true });
  if (!order) {
    return { ok: false, code: "order_missing" };
  }

  const orderForReceipt = await Order.findById(orderId).populate({
    path: "customerId",
    select: "email firstName lastName phone address addressLine2 city state zip country",
  });
  const custView = getOrderCustomerView(
    orderForReceipt ? orderForReceipt.toObject() : { customer: prevC, customerId: null }
  );
  const em = custView.email?.trim();
  if (em) {
    try {
      const name = [custView.firstName, custView.lastName].filter(Boolean).join(" ").trim();
      await stripe.paymentIntents.update(piId, {
        receipt_email: em,
        description: `Custom Sports Cards order ${orderId} (${em})`,
        metadata: {
          ...paymentIntent.metadata,
          orderId: String(orderId),
          customer_email: em,
          ...(name ? { customer_name: name.slice(0, 500) } : {}),
        },
      });
    } catch {
      /* non-fatal */
    }
  }

  if (prev.status !== "confirmed" && order.status === "confirmed") {
    notifyOrderPlaced(order).catch(() => {});
  }
  invalidateAdminStatsCache();
  return { ok: true, order };
}

/**
 * Mark pending_payment draft as failed (client decline, webhook, or PI creation error).
 * @param {string} paymentIntentId
 * @param {string} [message]
 * @returns {Promise<import("mongoose").Document | null>}
 */
export async function markStripeDraftPaymentFailed(paymentIntentId, message) {
  const piId = String(paymentIntentId || "").trim();
  if (!piId) return null;
  const prev = await Order.findOne({ paymentReferenceId: piId, status: "pending_payment" });
  if (!prev) return null;
  const msg = message != null && String(message).trim() ? String(message).trim().slice(0, 2000) : "Payment failed";
  const order = await Order.findByIdAndUpdate(
    prev._id,
    { $set: { status: "payment_failed", paymentLastError: msg } },
    { new: true }
  );
  invalidateAdminStatsCache();
  return order;
}

/**
 * Mark draft failed by Mongo order id (client reported error before PI id known).
 * @param {string} orderId
 * @param {string} [paymentIntentId] if set, must match order.paymentReferenceId when present
 */
export async function markStripeDraftPaymentFailedByOrderId(orderId, paymentIntentId, message) {
  if (!isLikelyMongoObjectId(String(orderId || "").trim())) return null;
  const prev = await Order.findById(String(orderId).trim());
  if (!prev || prev.status !== "pending_payment" || prev.paymentProvider !== "stripe") return null;
  if (paymentIntentId && prev.paymentReferenceId && String(prev.paymentReferenceId) !== String(paymentIntentId)) {
    return null;
  }
  const msg = message != null && String(message).trim() ? String(message).trim().slice(0, 2000) : "Payment failed";
  const order = await Order.findByIdAndUpdate(
    prev._id,
    { $set: { status: "payment_failed", paymentLastError: msg } },
    { new: true }
  );
  invalidateAdminStatsCache();
  return order;
}
