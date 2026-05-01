import { randomUUID } from "crypto";
import { Router } from "express";
import Stripe from "stripe";
import { Order } from "../models/Order.js";
import { dbConnected } from "../db.js";
import { optionalCustomer } from "../middleware/auth.js";
import { notifyOrderPlaced } from "../services/orderEmails.js";
import { invalidateAdminStatsCache } from "../services/adminStatsCache.js";
import {
  upsertCustomerFromCheckout,
  migrateGuestCustomerEmailOnCheckoutPatch,
} from "../services/customerProfile.js";
import { getOrderCustomerView } from "../services/orderCustomer.js";
import { CustomerUser } from "../models/CustomerUser.js";
import {
  isPayPalConfigured,
  getPayPalApiEnvironment,
  paypalCreateOrder,
  paypalCaptureOrder,
  paypalCancelOrder,
  paypalParseCapture,
} from "../services/paypalRest.js";
import {
  finalizeStripeDraftOrderFromSucceededIntent,
  markStripeDraftPaymentFailed,
  markStripeDraftPaymentFailedByOrderId,
} from "../services/stripeOrderFinalize.js";
import {
  sumItemsMerchandiseCents as sumItemsCents,
  computeAutoDiscountCents,
  cardChargeAmountCents,
  hostedCheckoutAmountCents,
  allocateDiscountAcrossItems,
} from "../services/cartDiscounts.js";

const router = Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-11-20.acacia" }) : null;

const P = "[orders]";
function orderInfo(msg, data) {
  if (data !== undefined) console.log(`${P} ${msg}`, data);
  else console.log(`${P} ${msg}`);
}
function orderWarn(msg) {
  console.warn(`${P} ${msg}`);
}
function orderErr(op, e) {
  console.error(`${P} ${op} failed:`, e?.message || e);
}

function computeCardCheckoutAmountCents(items, shippingCents, taxCents) {
  return cardChargeAmountCents(items, shippingCents, taxCents);
}

/** Stripe Checkout hosted session total (matches discounted line_items + shipping). */
function computeHostedCheckoutSessionAmountCents(items, shippingCents) {
  return hostedCheckoutAmountCents(items, shippingCents);
}

function sanitizeItemsForOrderStorage(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => (item && typeof item === "object" ? { ...item } : item));
}

function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isInlineImageDataUrlString(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.startsWith("data:image/") && t.includes(";base64,");
}

function valueHasInlineImageDataUrl(value) {
  if (isInlineImageDataUrlString(value)) return true;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return value.some((v) => valueHasInlineImageDataUrl(v));
    return Object.values(value).some((v) => valueHasInlineImageDataUrl(v));
  }
  return false;
}

function hasInlineImageDataUrlInItems(items) {
  if (!Array.isArray(items)) return false;
  for (const item of items) {
    if (valueHasInlineImageDataUrl(item?.designSnapshot)) return true;
  }
  return false;
}

function validateCheckoutItemsPayload(items) {
  if (!Array.isArray(items) || items.length === 0) return "items (non-empty array) required";
  if (items.length > 250) return "Too many line items in checkout payload.";
  if (hasInlineImageDataUrlInItems(items)) {
    return "Checkout is still preparing design images. Please wait a moment and try again.";
  }
  const bytes = estimateJsonBytes(items);
  if (!Number.isFinite(bytes) || bytes > 8 * 1024 * 1024) {
    return "Checkout payload is too large. Please refresh checkout and try again.";
  }
  return null;
}

function isLikelyMongoObjectId(s) {
  return typeof s === "string" && s.length === 24 && /^[a-f0-9]+$/i.test(s);
}

function normalizePhoneDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

/**
 * Same access rules as cancel-checkout-draft / PATCH guest (plus linkedDraftOrderId + phone, or matching checkoutBrowserSessionId).
 * `customer` is the checkout form payload (email, phone, etc.).
 */
async function callerMayAccessPendingStripeDraft(req, o, customer, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId) {
  if (!o || o.paymentProvider !== "stripe") return false;
  if (o.status !== "pending_payment" && o.status !== "payment_failed") return false;
  if (req.customerUser) {
    return String(o.customerId) === String(req.customerUser._id);
  }
  const sid = String(clientCheckoutSessionId || "").trim();
  if (sid.length >= 8 && o.checkoutBrowserSessionId && sid === String(o.checkoutBrowserSessionId).trim()) {
    return true;
  }
  const lid = String(linkedDraftOrderId || "").trim();
  if (lid && isLikelyMongoObjectId(lid) && lid === String(o._id)) {
    const pf = normalizePhoneDigits(customer?.phone);
    const po = normalizePhoneDigits(o.customer?.phone);
    if (pf.length >= 10 && po.length >= 10 && pf === po) return true;
  }
  const pe = String(priorCheckoutEmail || customer?.email || "").trim().toLowerCase();
  if (!pe) return false;
  const snap = String(o.customer?.email || "").trim().toLowerCase();
  const linked = await CustomerUser.findById(o.customerId).select("email").lean();
  const linkedEm = linked?.email ? String(linked.email).trim().toLowerCase() : "";
  return pe === snap || pe === linkedEm;
}

/** Find a pending Stripe draft this caller may still own (email change, linked order id, browser session id, or customerId). */
async function findAccessibleStripeCheckoutDraftForCreate(
  req,
  customer,
  priorCheckoutEmail,
  linkedDraftOrderId,
  /** After upsert: include to match drafts already tied to this CustomerUser. */
  customerIdOrNull,
  clientCheckoutSessionId
) {
  const newEmailNorm = String(customer?.email || "").trim().toLowerCase();
  const priorNorm = String(priorCheckoutEmail || "").trim().toLowerCase();
  const sessionNorm = String(clientCheckoutSessionId || "").trim();
  const or = [];
  if (customerIdOrNull) or.push({ customerId: customerIdOrNull });
  if (newEmailNorm) or.push({ "customer.email": newEmailNorm });
  if (priorNorm && priorNorm !== newEmailNorm) or.push({ "customer.email": priorNorm });
  const lid = String(linkedDraftOrderId || "").trim();
  if (lid && isLikelyMongoObjectId(lid)) or.push({ _id: lid });
  if (sessionNorm.length >= 8) or.push({ checkoutBrowserSessionId: sessionNorm });
  if (or.length === 0) return null;
  const list = await Order.find({
    status: { $in: ["pending_payment", "payment_failed"] },
    paymentProvider: "stripe",
    $or: or,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  for (const raw of list) {
    const ok = await callerMayAccessPendingStripeDraft(req, raw, customer, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId);
    if (ok) return raw;
  }
  return null;
}

/** Guest access to a pending checkout draft (Stripe or PayPal) — same rules as PATCH/cancel. */
async function guestMayAccessCheckoutDraft(o, body) {
  if (!o) return false;
  const {
    email,
    priorEmail,
    clientCheckoutSessionId,
    linkedDraftOrderId,
    customer: bodyCustomer,
  } = body || {};
  const sid = String(clientCheckoutSessionId || "").trim();
  if (sid.length >= 8 && o.checkoutBrowserSessionId && sid === String(o.checkoutBrowserSessionId).trim()) {
    return true;
  }
  const lid = String(linkedDraftOrderId || "").trim();
  if (lid && isLikelyMongoObjectId(lid) && lid === String(o._id)) {
    const pf = normalizePhoneDigits(bodyCustomer?.phone);
    const po = normalizePhoneDigits(o.customer?.phone);
    if (pf.length >= 10 && po.length >= 10 && pf === po) return true;
  }
  const pe = String(priorEmail || email || bodyCustomer?.email || "").trim().toLowerCase();
  if (!pe) return false;
  const snap = String(o.customer?.email || "").trim().toLowerCase();
  const linked = await CustomerUser.findById(o.customerId).select("email").lean();
  const linkedEm = linked?.email ? String(linked.email).trim().toLowerCase() : "";
  return pe === snap || pe === linkedEm;
}

async function callerMayAccessPendingPayPalDraft(req, o, customer, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId) {
  if (!o || o.paymentProvider !== "paypal") return false;
  if (o.status !== "pending_payment") return false;
  if (req.customerUser) {
    return String(o.customerId) === String(req.customerUser._id);
  }
  const sid = String(clientCheckoutSessionId || "").trim();
  if (sid.length >= 8 && o.checkoutBrowserSessionId && sid === String(o.checkoutBrowserSessionId).trim()) {
    return true;
  }
  const lid = String(linkedDraftOrderId || "").trim();
  if (lid && isLikelyMongoObjectId(lid) && lid === String(o._id)) {
    const pf = normalizePhoneDigits(customer?.phone);
    const po = normalizePhoneDigits(o.customer?.phone);
    if (pf.length >= 10 && po.length >= 10 && pf === po) return true;
  }
  const pe = String(priorCheckoutEmail || customer?.email || "").trim().toLowerCase();
  if (!pe) return false;
  const snap = String(o.customer?.email || "").trim().toLowerCase();
  const linked = await CustomerUser.findById(o.customerId).select("email").lean();
  const linkedEm = linked?.email ? String(linked.email).trim().toLowerCase() : "";
  return pe === snap || pe === linkedEm;
}

/** Find a pending PayPal draft this caller may still own (same discovery shape as Stripe). */
async function findAccessiblePayPalCheckoutDraftForCreate(
  req,
  customer,
  priorCheckoutEmail,
  linkedDraftOrderId,
  customerIdOrNull,
  clientCheckoutSessionId
) {
  const newEmailNorm = String(customer?.email || "").trim().toLowerCase();
  const priorNorm = String(priorCheckoutEmail || "").trim().toLowerCase();
  const sessionNorm = String(clientCheckoutSessionId || "").trim();
  const or = [];
  if (customerIdOrNull) or.push({ customerId: customerIdOrNull });
  if (newEmailNorm) or.push({ "customer.email": newEmailNorm });
  if (priorNorm && priorNorm !== newEmailNorm) or.push({ "customer.email": priorNorm });
  const lid = String(linkedDraftOrderId || "").trim();
  if (lid && isLikelyMongoObjectId(lid)) or.push({ _id: lid });
  if (sessionNorm.length >= 8) or.push({ checkoutBrowserSessionId: sessionNorm });
  if (or.length === 0) return null;
  const list = await Order.find({
    status: "pending_payment",
    paymentProvider: "paypal",
    $or: or,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  for (const raw of list) {
    const ok = await callerMayAccessPendingPayPalDraft(req, raw, customer, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId);
    if (ok) return raw;
  }
  return null;
}

/**
 * After a declined / failed 3DS attempt, reuse the same order row: cancel old PI, create a new one, refresh line items from the request.
 * Returns { clientSecret, orderId } or null if the order is not a reopenable payment_failed draft or access is denied.
 */
async function reopenStripePaymentFailedDraftForCreateIntent(stripe, orderLean, ctx) {
  const { req, customer, items, shippingCents, taxCents, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId } = ctx;
  if (!stripe || !orderLean?._id) return null;
  const oid = String(orderLean._id).trim();
  const o = await Order.findById(oid);
  if (!o || o.paymentProvider !== "stripe" || o.status !== "payment_failed") return null;

  const leanObj = typeof o.toObject === "function" ? o.toObject() : { ...o };
  const accessOk = await callerMayAccessPendingStripeDraft(
    req,
    leanObj,
    customer,
    priorCheckoutEmail,
    linkedDraftOrderId,
    clientCheckoutSessionId
  );
  if (!accessOk) return null;

  const shipCents = Number(shippingCents) || 0;
  const taxCentsVal = Number(taxCents) || 0;
  const amountCents = computeCardCheckoutAmountCents(items, shipCents, taxCentsVal);
  if (amountCents < 50) return null;

  const cu = await migrateGuestCustomerEmailOnCheckoutPatch({
    previousCustomerId: o.customerId,
    customer,
  });
  if (!cu) return null;
  const effectiveCustomerId = req.customerUser?._id || cu._id;
  const totalCents = sumItemsCents(items);
  const discountCents = computeAutoDiscountCents(items);
  const storedItems = sanitizeItemsForOrderStorage(items);
  const notesVal =
    customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;

  const oldPi = o.paymentReferenceId ? String(o.paymentReferenceId).trim() : "";
  if (oldPi) {
    try {
      await stripe.paymentIntents.cancel(oldPi);
    } catch (e) {
      orderWarn(`reopen payment_failed draft: could not cancel PI ${oldPi}: ${e?.message || e}`);
    }
  }
  const custPi = buildOrderCustomer(customer);
  const emailPi = custPi.email || "";
  const namePi = [custPi.firstName, custPi.lastName].filter(Boolean).join(" ").trim();
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    payment_method_types: ["card"],
    description: emailPi ? `Custom Sports Cards checkout (${emailPi})` : "Custom Sports Cards checkout",
    metadata: {
      orderId: oid,
      ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
    },
    receipt_email: emailPi || undefined,
  });
  const sessionSet =
    String(clientCheckoutSessionId || "").trim().length >= 8
      ? { checkoutBrowserSessionId: String(clientCheckoutSessionId).trim() }
      : {};
  await Order.findByIdAndUpdate(oid, {
    $set: {
      status: "pending_payment",
      paymentReferenceId: paymentIntent.id,
      items: storedItems,
      totalCents,
      discountCents,
      shippingCents: shipCents,
      taxCents: taxCentsVal,
      customer: buildOrderCustomer(customer),
      customerId: effectiveCustomerId,
      notes: notesVal,
      createAccount: Boolean(customer?.createAccount),
      ...sessionSet,
    },
    $unset: { paymentLastError: "" },
  });
  invalidateAdminStatsCache();
  orderInfo("reopen payment_failed draft for new PI ok", { orderId: oid, paymentIntentId: paymentIntent.id });
  return { clientSecret: paymentIntent.client_secret, orderId: oid };
}

/** Build order customer object from request body (all address/details). */
function buildOrderCustomer(customer) {
  if (!customer || (!customer.email?.trim() && !customer.firstName?.trim() && !customer.lastName?.trim())) return {};
  return {
    email: (String(customer.email || "").trim() || undefined)?.toLowerCase(),
    firstName: String(customer.firstName || "").trim() || undefined,
    lastName: String(customer.lastName || "").trim() || undefined,
    phone: customer.phone ? String(customer.phone).trim() : undefined,
    address: customer.address ? String(customer.address).trim() : undefined,
    addressLine2: customer.addressLine2 ? String(customer.addressLine2).trim() : undefined,
    city: customer.city ? String(customer.city).trim() : undefined,
    state: customer.state ? String(customer.state).trim() : undefined,
    zip: customer.zip ? String(customer.zip).trim() : undefined,
    country: customer.country ? String(customer.country).trim() : undefined,
  };
}

/** Full billing + shipping: must match checkout form (name, email, phone, full address, country). */
function isFullCustomerPayload(c) {
  if (!c || typeof c !== "object") return false;
  return (
    String(c.email || "").trim() &&
    String(c.firstName || "").trim() &&
    String(c.lastName || "").trim() &&
    String(c.phone || "").trim() &&
    String(c.address || "").trim() &&
    String(c.city || "").trim() &&
    String(c.state || "").trim() &&
    String(c.zip || "").trim() &&
    String(c.country || "").trim()
  );
}

/** Map Stripe charge billing_details to our customer shape (when checkout form was not re-posted to confirm). */
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

/** POST /api/orders/create-checkout-session
 * Body: { customer, items, successUrl, cancelUrl } (items have templateId, templateName, quantity, priceCents, etc.)
 * No DB order until payment succeeds. Returns { sessionId, url, placementRef }.
 */
router.post("/create-checkout-session", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /create-checkout-session 503: database not configured");
      return res.status(503).json({ error: "Database not configured" });
    }
    if (!stripe) {
      orderWarn("POST /create-checkout-session 503: STRIPE_SECRET_KEY not set");
      return res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });
    }
    const { customer, items, successUrl, cancelUrl, shippingCents } = req.body || {};
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /create-checkout-session 400: full customer (email, name, phone, full address) required");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /create-checkout-session 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    const discountCents = computeAutoDiscountCents(items);
    const subtotalMerchCents = sumItemsCents(items);
    const subtotalChargedCents = subtotalMerchCents - discountCents;
    const shipCents = Number(shippingCents) || 0;
    const placementRef = randomUUID();
    orderInfo("POST /create-checkout-session", {
      itemLines: items.length,
      subtotalCents: subtotalChargedCents,
      discountCents,
      shippingCents: shipCents,
      customerLoggedIn: Boolean(req.customerUser),
      placementRef,
    });

    const itemsForStripe = allocateDiscountAcrossItems(items, discountCents);
    // Each cart item is one Stripe line: priceCents = total for that line after auto-discount split, quantity = 1
    const lineItems = itemsForStripe.map((i) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: i.templateName || i.templateId || "Card",
          description: i.quantity ? `Qty: ${i.quantity} cards` : undefined,
        },
        unit_amount: i.priceCents || 0,
      },
      quantity: 1,
    }));
    if (shipCents > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Shipping" },
          unit_amount: shipCents,
        },
        quantity: 1,
      });
    }

    const cust = buildOrderCustomer(customer);
    const email = cust.email || "";
    const customerName = [cust.firstName, cust.lastName].filter(Boolean).join(" ").trim();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: successUrl || `${req.protocol}://${req.get("host")}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.protocol}://${req.get("host")}/checkout`,
      client_reference_id: placementRef,
      customer_email: email || undefined,
      metadata: {
        placementRef,
        customer_email: email,
        ...(customerName ? { customer_name: customerName.slice(0, 500) } : {}),
      },
    });

    orderInfo("create-checkout-session ok", { placementRef, sessionId: session.id });
    res.json({ sessionId: session.id, url: session.url, placementRef });
  } catch (e) {
    orderErr("create-checkout-session", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/place-without-payment - creates order with status "confirmed" (no Stripe). Temporary bypass for testing. */
router.post("/place-without-payment", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /place-without-payment 503: database not configured");
      return res.status(503).json({ error: "Database not configured" });
    }
    const { customer, items, shippingCents } = req.body || {};
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /place-without-payment 400: full customer required");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /place-without-payment 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const shipCents = Number(shippingCents) || 0;
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const orderDoc = await Order.create({
      status: "confirmed",
      paymentProvider: "manual",
      customerId: cu._id,
      items: storedItems,
      totalCents,
      discountCents,
      shippingCents: shipCents,
      notes: customer.notes ? String(customer.notes).trim() : undefined,
      createAccount: Boolean(customer.createAccount),
    });
    notifyOrderPlaced(orderDoc).catch((err) => orderErr("notifyOrderPlaced (place-without-payment)", err));
    const id = orderDoc._id.toString();
    orderInfo("POST /place-without-payment ok", { orderId: id, itemLines: items.length });
    invalidateAdminStatsCache();
    res.status(201).json({ id });
  } catch (e) {
    orderErr("place-without-payment", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/confirm-session - body: { sessionId, items?, customer?, shippingCents? }. Verifies Stripe session paid; creates or updates order. */
router.post("/confirm-session", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      orderWarn("POST /confirm-session 503: server not configured");
      return res.status(503).json({ error: "Server not configured" });
    }
    const { sessionId, items, customer, shippingCents } = req.body || {};
    if (!sessionId) {
      orderWarn("POST /confirm-session 400: sessionId missing");
      return res.status(400).json({ error: "sessionId required" });
    }
    orderInfo("POST /confirm-session", { sessionId });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      orderWarn(
        `POST /confirm-session 400: session not paid (status=${session.payment_status})`
      );
      return res.status(400).json({ error: "Session not paid" });
    }

    const existingPaid = await Order.findOne({ paymentReferenceId: sessionId, status: "confirmed" });
    if (existingPaid) {
      return res.json(existingPaid);
    }

    const ref = session.client_reference_id || session.metadata?.orderId;
    if (ref && isLikelyMongoObjectId(String(ref).trim())) {
      const mongoOrderId = String(ref).trim();
      const prev = await Order.findById(mongoOrderId);
      if (prev) {
        const update = { status: "confirmed", paymentProvider: "stripe", paymentReferenceId: sessionId };
        if (req.customerUser?._id) {
          update.customerId = req.customerUser._id;
        } else {
          const emb = prev.customer;
          if (!prev.customerId && emb && emb.email) {
            const cu = await upsertCustomerFromCheckout(emb);
            if (cu) update.customerId = cu._id;
          }
        }
        const order = await Order.findByIdAndUpdate(
          mongoOrderId,
          { $set: update, $unset: { customer: "" } },
          { new: true }
        );
        if (!order) {
          orderWarn(`POST /confirm-session 404: order vanished after read id=${mongoOrderId}`);
          return res.status(404).json({ error: "Order not found" });
        }
        if (prev.status !== "confirmed" && order.status === "confirmed") {
          notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (confirm-session)", err));
        }
        orderInfo("POST /confirm-session ok (legacy)", { orderId: mongoOrderId, fromStatus: prev.status, to: order.status });
        invalidateAdminStatsCache();
        return res.json(order);
      }
    }

    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /confirm-session 400: items required to create order for this checkout session");
      return res.status(400).json({
        error:
          "Order details missing. Use the same browser session after checkout, or contact support with your receipt.",
      });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    if (!isFullCustomerPayload(customer)) {
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const shipCents = Number(shippingCents) || 0;
    const expectedCents = computeHostedCheckoutSessionAmountCents(items, shipCents);
    const paidTotal = session.amount_total;
    if (paidTotal != null && expectedCents !== paidTotal) {
      orderWarn(`POST /confirm-session 400: amount mismatch session=${paidTotal} calc=${expectedCents}`);
      return res.status(400).json({ error: "Order total does not match payment" });
    }
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const itemsTotal = items.reduce((sum, i) => sum + (Number(i.priceCents) || 0), 0);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const notesVal =
      customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;
    const order = await Order.create({
      status: "confirmed",
      paymentProvider: "stripe",
      paymentReferenceId: sessionId,
      stripeSessionId: session.id,
      customerId: req.customerUser?._id || cu._id,
      items: storedItems,
      totalCents: itemsTotal,
      discountCents,
      shippingCents: shipCents,
      notes: notesVal,
      createAccount: Boolean(customer?.createAccount),
    });
    notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (confirm-session deferred)", err));
    orderInfo("POST /confirm-session ok (deferred)", { orderId: String(order._id) });
    invalidateAdminStatsCache();
    res.json(order);
  } catch (e) {
    orderErr("confirm-session", e);
    res.status(500).json({ error: e.message });
  }
});

/** Max age (minutes) for a stale pending_payment draft before auto-cancel. Default 1440 (24h). */
function checkoutDraftMaxAgeMs() {
  const n = parseInt(String(process.env.CHECKOUT_DRAFT_MAX_AGE_MINUTES || "1440"), 10);
  return (Number.isFinite(n) && n > 0 ? n : 1440) * 60 * 1000;
}

/** POST /api/orders/create-payment-intent
 * Body: { customer, items, shippingCents, taxCents }. Creates CustomerUser (guest), draft Order (pending_payment), PaymentIntent with metadata.orderId.
 * Returns { clientSecret, orderId }.
 */
router.post("/create-payment-intent", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /create-payment-intent 503: database not configured");
      return res.status(503).json({ error: "Database not configured" });
    }
    if (!stripe) {
      orderWarn("POST /create-payment-intent 503: STRIPE_SECRET_KEY not set");
      return res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });
    }
    const { customer, items, shippingCents, taxCents, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId } =
      req.body || {};
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /create-payment-intent 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /create-payment-intent 400: full customer required (complete billing on checkout first)");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const amountCents = computeCardCheckoutAmountCents(items, shippingCents, taxCents);
    if (amountCents < 50) {
      orderWarn("POST /create-payment-intent 400: amount too small", { amountCents });
      return res.status(400).json({ error: "Amount too small" });
    }

    const reopenCtx = {
      req,
      customer,
      items,
      shippingCents,
      taxCents,
      priorCheckoutEmail,
      linkedDraftOrderId,
      clientCheckoutSessionId,
    };
    const preBlock = await findAccessibleStripeCheckoutDraftForCreate(
      req,
      customer,
      priorCheckoutEmail,
      linkedDraftOrderId,
      req.customerUser?._id || null,
      clientCheckoutSessionId
    );
    if (preBlock) {
      if (preBlock.status === "payment_failed") {
        try {
          const reopened = await reopenStripePaymentFailedDraftForCreateIntent(stripe, preBlock, reopenCtx);
          if (reopened?.clientSecret) {
            return res.json(reopened);
          }
        } catch (e) {
          orderErr("create-payment-intent reopen (preBlock)", e);
          return res.status(500).json({ error: e.message });
        }
      }
      orderWarn("POST /create-payment-intent 409: existing checkout draft (pre-upsert)");
      return res.status(409).json({
        error:
          "You already have an unpaid card checkout open. Use Continue saved checkout on the payment step, or cancel it to start over.",
        existingOrderId: String(preBlock._id),
      });
    }

    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const effectiveCustomerId = req.customerUser?._id || cu._id;
    const cutoff = new Date(Date.now() - checkoutDraftMaxAgeMs());
    await Order.updateMany(
      {
        customerId: effectiveCustomerId,
        status: "pending_payment",
        paymentProvider: { $in: ["stripe", "paypal"] },
        createdAt: { $lt: cutoff },
      },
      {
        $set: {
          status: "cancelled",
          notes: "Checkout draft expired (auto-cancelled).",
        },
      }
    );
    const postBlock = await findAccessibleStripeCheckoutDraftForCreate(
      req,
      customer,
      priorCheckoutEmail,
      linkedDraftOrderId,
      effectiveCustomerId,
      clientCheckoutSessionId
    );
    if (postBlock) {
      if (postBlock.status === "payment_failed") {
        try {
          const reopened = await reopenStripePaymentFailedDraftForCreateIntent(stripe, postBlock, reopenCtx);
          if (reopened?.clientSecret) {
            return res.json(reopened);
          }
        } catch (e) {
          orderErr("create-payment-intent reopen (postBlock)", e);
          return res.status(500).json({ error: e.message });
        }
      }
      orderWarn("POST /create-payment-intent 409: existing checkout draft (post-upsert)");
      return res.status(409).json({
        error:
          "You already have an unpaid card checkout open. Use Continue saved checkout on the payment step, or cancel it to start over.",
        existingOrderId: String(postBlock._id),
      });
    }

    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const totalCents = sumItemsCents(items);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const notesVal =
      customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;

    orderInfo("POST /create-payment-intent", {
      itemLines: items.length,
      amountCents,
      hasCustomer: true,
    });

    const sessionNorm = String(clientCheckoutSessionId || "").trim();
    const orderDoc = await Order.create({
      status: "pending_payment",
      paymentProvider: "stripe",
      customer: buildOrderCustomer(customer),
      customerId: effectiveCustomerId,
      items: storedItems,
      totalCents,
      discountCents,
      shippingCents: shipCents,
      taxCents: taxCentsVal,
      notes: notesVal,
      createAccount: Boolean(customer?.createAccount),
      ...(sessionNorm.length >= 8 ? { checkoutBrowserSessionId: sessionNorm } : {}),
    });
    const orderId = String(orderDoc._id);
    const custPi = buildOrderCustomer(customer);
    const emailPi = custPi.email || "";
    const namePi = [custPi.firstName, custPi.lastName].filter(Boolean).join(" ").trim();

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        payment_method_types: ["card"],
        description: emailPi ? `Custom Sports Cards checkout (${emailPi})` : "Custom Sports Cards checkout",
        metadata: {
          orderId,
          ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
        },
        receipt_email: emailPi || undefined,
      });
      await Order.findByIdAndUpdate(orderId, { $set: { paymentReferenceId: paymentIntent.id } });
      orderInfo("create-payment-intent ok", { paymentIntentId: paymentIntent.id, orderId });
      invalidateAdminStatsCache();
      res.json({ clientSecret: paymentIntent.client_secret, orderId });
    } catch (e) {
      await Order.findByIdAndUpdate(orderId, {
        $set: { status: "payment_failed", paymentLastError: String(e?.message || e || "Stripe error").slice(0, 2000) },
      });
      invalidateAdminStatsCache();
      orderErr("create-payment-intent", e);
      res.status(500).json({ error: e.message });
    }
  } catch (e) {
    orderErr("create-payment-intent", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/confirm-payment - Verifies PI succeeded, then creates or confirms the order. Body: { paymentIntentId, customer?, items?, shippingCents?, taxCents? } — items required when no legacy pending order exists for this PI. */
router.post("/confirm-payment", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      orderWarn("POST /confirm-payment 503: server not configured");
      return res.status(503).json({ error: "Server not configured" });
    }
    const { paymentIntentId, customer, items, shippingCents, taxCents } = req.body || {};
    if (!paymentIntentId) {
      orderWarn("POST /confirm-payment 400: paymentIntentId missing");
      return res.status(400).json({ error: "paymentIntentId required" });
    }
    orderInfo("POST /confirm-payment", { paymentIntentId });
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    if (paymentIntent.status !== "succeeded") {
      orderWarn(
        `POST /confirm-payment 400: PI not succeeded (status=${paymentIntent.status})`
      );
      return res.status(400).json({ error: "Payment not completed" });
    }

    const ch = paymentIntent.latest_charge;
    const fromStripeObj =
      typeof ch === "object" && ch && ch.billing_details
        ? customerFromStripeBilling(ch.billing_details)
        : null;
    const mergedForSave = { ...(fromStripeObj || {}), ...(customer || {}) };

    const finalized = await finalizeStripeDraftOrderFromSucceededIntent(stripe, paymentIntent, {
      requestCustomer: customer,
      customerUser: req.customerUser,
    });
    if (finalized.ok) {
      orderInfo("POST /confirm-payment ok (draft)", { orderId: String(finalized.order._id) });
      return res.json(finalized.order);
    }
    if (finalized.code === "amount_mismatch") {
      orderWarn("POST /confirm-payment 400: amount mismatch draft");
      return res.status(400).json({ error: "Order total does not match payment" });
    }

    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /confirm-payment 400: items required for deferred order finalize");
      return res.status(400).json({
        error: "Order details missing. Return to checkout with the same browser session, or contact support with your payment receipt.",
      });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    const expectedCents = computeCardCheckoutAmountCents(items, shippingCents, taxCents);
    if (expectedCents !== paymentIntent.amount) {
      orderWarn(`POST /confirm-payment 400: amount mismatch pi=${paymentIntent.amount} calc=${expectedCents}`);
      return res.status(400).json({ error: "Order total does not match payment" });
    }
    if (!isFullCustomerPayload(mergedForSave)) {
      orderWarn("POST /confirm-payment 400: incomplete customer for deferred finalize");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const cu = await upsertCustomerFromCheckout(mergedForSave);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const totalCents = sumItemsCents(items);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const notesVal =
      mergedForSave.notes != null && String(mergedForSave.notes).trim()
        ? String(mergedForSave.notes).trim()
        : customer?.notes != null && String(customer.notes).trim()
          ? String(customer.notes).trim()
          : undefined;
    const createAccount = Boolean(customer?.createAccount);
    const order = await Order.create({
      status: "confirmed",
      paymentProvider: "stripe",
      paymentReferenceId: paymentIntentId,
      customerId: req.customerUser?._id || cu._id,
      items: storedItems,
      totalCents,
      discountCents,
      shippingCents: shipCents,
      taxCents: taxCentsVal,
      notes: notesVal,
      createAccount,
    });
    const orderId = String(order._id);
    const orderForReceipt = await Order.findById(orderId).populate({
      path: "customerId",
      select: "email firstName lastName phone address addressLine2 city state zip country",
    });
    const custView = getOrderCustomerView(orderForReceipt ? orderForReceipt.toObject() : { customer: {}, customerId: null });
    const em = custView.email?.trim();
    if (em) {
      try {
        const name = [custView.firstName, custView.lastName].filter(Boolean).join(" ").trim();
        await stripe.paymentIntents.update(paymentIntentId, {
          receipt_email: em,
          description: `Custom Sports Cards order ${orderId} (${em})`,
          metadata: {
            ...paymentIntent.metadata,
            orderId: String(orderId),
            customer_email: em,
            ...(name ? { customer_name: name.slice(0, 500) } : {}),
          },
        });
      } catch (err) {
        orderWarn(`paymentIntent update (receipt): ${err?.message || err}`);
      }
    }
    notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (confirm-payment deferred)", err));
    orderInfo("POST /confirm-payment ok (deferred create)", { orderId });
    invalidateAdminStatsCache();
    res.json(order);
  } catch (e) {
    orderErr("confirm-payment", e);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/orders/paypal-client-config — public client id when PayPal REST is configured (same id as JS SDK). */
router.get("/paypal-client-config", (_req, res) => {
  try {
    const enabled = isPayPalConfigured();
    const clientId = enabled ? String(process.env.PAYPAL_CLIENT_ID || "").trim() : "";
    res.json({
      enabled: Boolean(enabled && clientId),
      clientId: enabled ? clientId : "",
      environment: getPayPalApiEnvironment(),
    });
  } catch (e) {
    orderErr("paypal-client-config", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/orders/create-paypal-order — same body as create-payment-intent (+ priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId).
 * Creates a draft Order (pending_payment, PayPal) and a PayPal order; returns { placementRef, paypalOrderId, orderId }.
 */
router.post("/create-paypal-order", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /create-paypal-order 503: database not configured");
      return res.status(503).json({ error: "Database not configured" });
    }
    if (!isPayPalConfigured()) {
      orderWarn("POST /create-paypal-order 503: PayPal not configured");
      return res.status(503).json({ error: "PayPal not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET." });
    }
    const { customer, items, shippingCents, taxCents, priorCheckoutEmail, linkedDraftOrderId, clientCheckoutSessionId } =
      req.body || {};
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /create-paypal-order 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /create-paypal-order 400: full customer required");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const amountCents = computeCardCheckoutAmountCents(items, shippingCents, taxCents);
    if (amountCents < 50) {
      orderWarn("POST /create-paypal-order 400: amount too small", { amountCents });
      return res.status(400).json({ error: "Amount too small" });
    }
    const preBlock = await findAccessiblePayPalCheckoutDraftForCreate(
      req,
      customer,
      priorCheckoutEmail,
      linkedDraftOrderId,
      req.customerUser?._id || null,
      clientCheckoutSessionId
    );
    if (preBlock) {
      orderWarn("POST /create-paypal-order 409: existing PayPal draft (pre-upsert)");
      return res.status(409).json({
        error:
          "You already have an unpaid PayPal checkout open. Use Continue saved checkout on the payment step, or cancel it to start over.",
        existingOrderId: String(preBlock._id),
        placementRef: preBlock.paypalPlacementRef || undefined,
        paypalOrderId: preBlock.paymentReferenceId || undefined,
      });
    }

    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const effectiveCustomerId = req.customerUser?._id || cu._id;
    const cutoff = new Date(Date.now() - checkoutDraftMaxAgeMs());
    await Order.updateMany(
      {
        customerId: effectiveCustomerId,
        status: "pending_payment",
        paymentProvider: { $in: ["stripe", "paypal"] },
        createdAt: { $lt: cutoff },
      },
      {
        $set: {
          status: "cancelled",
          notes: "Checkout draft expired (auto-cancelled).",
        },
      }
    );
    const postBlock = await findAccessiblePayPalCheckoutDraftForCreate(
      req,
      customer,
      priorCheckoutEmail,
      linkedDraftOrderId,
      effectiveCustomerId,
      clientCheckoutSessionId
    );
    if (postBlock) {
      orderWarn("POST /create-paypal-order 409: existing PayPal draft (post-upsert)");
      return res.status(409).json({
        error:
          "You already have an unpaid PayPal checkout open. Use Continue saved checkout on the payment step, or cancel it to start over.",
        existingOrderId: String(postBlock._id),
        placementRef: postBlock.paypalPlacementRef || undefined,
        paypalOrderId: postBlock.paymentReferenceId || undefined,
      });
    }

    const valueUsd = (amountCents / 100).toFixed(2);
    const placementRef = randomUUID();
    const pp = await paypalCreateOrder({ valueUsd, customId: placementRef });
    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const totalCents = sumItemsCents(items);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const notesVal =
      customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;
    const sessionNorm = String(clientCheckoutSessionId || "").trim();
    let orderDoc;
    try {
      orderDoc = await Order.create({
        status: "pending_payment",
        paymentProvider: "paypal",
        paymentReferenceId: pp.id,
        paypalPlacementRef: placementRef,
        customer: buildOrderCustomer(customer),
        customerId: effectiveCustomerId,
        items: storedItems,
        totalCents,
        discountCents,
        shippingCents: shipCents,
        taxCents: taxCentsVal,
        notes: notesVal,
        createAccount: Boolean(customer?.createAccount),
        ...(sessionNorm.length >= 8 ? { checkoutBrowserSessionId: sessionNorm } : {}),
      });
    } catch (e) {
      await paypalCancelOrder(pp.id).catch(() => {});
      throw e;
    }
    const orderId = String(orderDoc._id);
    invalidateAdminStatsCache();
    orderInfo("create-paypal-order ok", { placementRef, paypalOrderId: pp.id, orderId });
    res.json({ placementRef, paypalOrderId: pp.id, orderId });
  } catch (e) {
    orderErr("create-paypal-order", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/capture-paypal-order — body: { placementRef, paypalOrderId, customer, items, shippingCents, taxCents } (new) or legacy { orderId, paypalOrderId, customer? }. */
router.post("/capture-paypal-order", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /capture-paypal-order 503: database not configured");
      return res.status(503).json({ error: "Database not configured" });
    }
    if (!isPayPalConfigured()) {
      orderWarn("POST /capture-paypal-order 503: PayPal not configured");
      return res.status(503).json({ error: "PayPal not configured" });
    }
    const { placementRef, orderId, paypalOrderId, customer, items, shippingCents, taxCents, priorEmail, email, clientCheckoutSessionId, linkedDraftOrderId } =
      req.body || {};
    if (!paypalOrderId) {
      orderWarn("POST /capture-paypal-order 400: paypalOrderId missing");
      return res.status(400).json({ error: "paypalOrderId required" });
    }
    const ppId = String(paypalOrderId).trim();

    if (placementRef) {
      orderInfo("POST /capture-paypal-order (deferred)", { placementRef, paypalOrderId: ppId, orderId });
      if (!items?.length || !Array.isArray(items)) {
        return res.status(400).json({ error: "items (non-empty array) required" });
      }
      const itemsPayloadErr = validateCheckoutItemsPayload(items);
      if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
      if (!isFullCustomerPayload(customer)) {
        return res
          .status(400)
          .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
      }
      const expectedCents = computeCardCheckoutAmountCents(items, shippingCents, taxCents);
      if (expectedCents < 50) {
        return res.status(400).json({ error: "Amount too small" });
      }
      const expectedUsd = (expectedCents / 100).toFixed(2);
      const draftOid = String(orderId || "").trim();
      let pending = null;
      if (draftOid && isLikelyMongoObjectId(draftOid)) {
        pending = await Order.findById(draftOid);
        if (!pending || pending.paymentProvider !== "paypal" || pending.status !== "pending_payment") {
          orderWarn(`POST /capture-paypal-order 400: invalid PayPal draft orderId=${draftOid}`);
          return res.status(400).json({ error: "Invalid or expired checkout" });
        }
        if (String(pending.paymentReferenceId || "").trim() !== ppId) {
          return res.status(400).json({ error: "PayPal order does not match this checkout" });
        }
        if (String(pending.paypalPlacementRef || "").trim() !== String(placementRef).trim()) {
          return res.status(400).json({ error: "Payment does not match this checkout" });
        }
        if (req.customerUser) {
          if (String(pending.customerId) !== String(req.customerUser._id)) {
            return res.status(403).json({ error: "Forbidden" });
          }
        } else {
          const okGuest = await guestMayAccessCheckoutDraft(pending, {
            email,
            priorEmail,
            clientCheckoutSessionId,
            linkedDraftOrderId,
            customer,
          });
          if (!okGuest) return res.status(403).json({ error: "Forbidden" });
        }
        const draftCents = computeCardCheckoutAmountCents(pending.items, pending.shippingCents, pending.taxCents);
        if (draftCents !== expectedCents) {
          orderWarn("POST /capture-paypal-order 400: cart total changed vs draft");
          return res.status(400).json({ error: "Order total changed; refresh checkout and try again." });
        }
      }

      const captured = await paypalCaptureOrder(ppId);
      const parsed = paypalParseCapture(captured);
      if (String(parsed.referenceId || "") !== String(placementRef).trim()) {
        orderWarn(`POST /capture-paypal-order 400: reference_id mismatch placementRef=${placementRef}`);
        return res.status(400).json({ error: "Payment does not match this checkout" });
      }
      if (parsed.status !== "COMPLETED") {
        orderWarn(`POST /capture-paypal-order 400: capture status=${parsed.status}`);
        return res.status(400).json({ error: "PayPal capture not completed" });
      }
      const paidUsd = String(parsed.amountValue || "").trim();
      if (paidUsd && paidUsd !== expectedUsd) {
        orderWarn(`POST /capture-paypal-order 400: amount mismatch paid=${paidUsd} expected=${expectedUsd}`);
        return res.status(400).json({ error: "Paid amount does not match order total" });
      }
      const captureKey = parsed.captureId || ppId;
      const dup = await Order.findOne({ paymentProvider: "paypal", paymentReferenceId: captureKey, status: "confirmed" });
      if (dup) {
        return res.json(dup);
      }
      const cu = await upsertCustomerFromCheckout(customer);
      if (!cu) {
        return res.status(500).json({ error: "Could not create customer record" });
      }
      const shipCents = Number(shippingCents) || 0;
      const taxCentsVal = Number(taxCents) || 0;
      const totalCents = sumItemsCents(items);
      const discountCents = computeAutoDiscountCents(items);
      const storedItems = sanitizeItemsForOrderStorage(items);
      const notesVal =
        customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;

      if (pending) {
        const order = await Order.findByIdAndUpdate(
          draftOid,
          {
            $set: {
              status: "confirmed",
              paymentProvider: "paypal",
              paymentReferenceId: captureKey,
              customerId: req.customerUser?._id || cu._id,
              customer: buildOrderCustomer(customer),
              items: storedItems,
              totalCents,
              discountCents,
              shippingCents: shipCents,
              taxCents: taxCentsVal,
              notes: notesVal,
              createAccount: Boolean(customer?.createAccount),
            },
            $unset: { paypalPlacementRef: "", paymentLastError: "" },
          },
          { new: true }
        );
        if (!order) return res.status(404).json({ error: "Order not found" });
        notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (capture-paypal-order deferred)", err));
        orderInfo("POST /capture-paypal-order ok (deferred confirm)", { orderId: String(order._id), captureId: parsed.captureId });
        invalidateAdminStatsCache();
        return res.json(order);
      }

      const order = await Order.create({
        status: "confirmed",
        paymentProvider: "paypal",
        paymentReferenceId: captureKey,
        customerId: req.customerUser?._id || cu._id,
        customer: buildOrderCustomer(customer),
        items: storedItems,
        totalCents,
        discountCents,
        shippingCents: shipCents,
        taxCents: taxCentsVal,
        notes: notesVal,
        createAccount: Boolean(customer?.createAccount),
      });
      notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (capture-paypal-order deferred)", err));
      orderInfo("POST /capture-paypal-order ok (deferred legacy create)", { orderId: String(order._id), captureId: parsed.captureId });
      invalidateAdminStatsCache();
      return res.json(order);
    }

    if (!orderId) {
      orderWarn("POST /capture-paypal-order 400: placementRef or orderId required");
      return res.status(400).json({ error: "placementRef and paypalOrderId required (or legacy orderId and paypalOrderId)" });
    }
    orderInfo("POST /capture-paypal-order (legacy)", { orderId, paypalOrderId: ppId });
    const prev = await Order.findById(orderId);
    if (!prev) {
      orderWarn(`POST /capture-paypal-order 404: order not found id=${orderId}`);
      return res.status(404).json({ error: "Order not found" });
    }
    if (prev.status === "confirmed") {
      invalidateAdminStatsCache();
      return res.json(prev);
    }
    if (prev.paymentProvider !== "paypal") {
      orderWarn(`POST /capture-paypal-order 400: order is not PayPal provider id=${orderId}`);
      return res.status(400).json({ error: "Order is not a PayPal checkout" });
    }
    const storedRef = String(prev.paymentReferenceId || "").trim();
    if (storedRef && storedRef !== ppId) {
      orderWarn(`POST /capture-paypal-order 400: paypal order mismatch id=${orderId}`);
      return res.status(400).json({ error: "PayPal order does not match this checkout" });
    }
    const captured = await paypalCaptureOrder(ppId);
    const parsed = paypalParseCapture(captured);
    if (String(parsed.referenceId || "") !== String(orderId)) {
      orderWarn(`POST /capture-paypal-order 400: reference_id mismatch id=${orderId}`);
      return res.status(400).json({ error: "Payment does not match this order" });
    }
    if (parsed.status !== "COMPLETED") {
      orderWarn(`POST /capture-paypal-order 400: capture status=${parsed.status}`);
      return res.status(400).json({ error: "PayPal capture not completed" });
    }
    const update = {
      status: "confirmed",
      paymentProvider: "paypal",
      paymentReferenceId: parsed.captureId || ppId,
    };
    if (customer?.notes != null && String(customer.notes).trim()) {
      update.notes = String(customer.notes).trim();
    }
    if (req.customerUser?._id) {
      update.customerId = req.customerUser._id;
    } else if (prev.customerId) {
      update.customerId = prev.customerId;
    }
    const order = await Order.findByIdAndUpdate(
      orderId,
      { $set: update, $unset: { customer: "" } },
      { new: true }
    );
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (prev.status !== "confirmed" && order.status === "confirmed") {
      notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (capture-paypal-order)", err));
    }
    orderInfo("POST /capture-paypal-order ok (legacy)", { orderId, captureId: parsed.captureId });
    invalidateAdminStatsCache();
    res.json(order);
  } catch (e) {
    orderErr("capture-paypal-order", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/stripe-payment-intent-failed — mark draft order payment_failed (client decline). */
router.post("/stripe-payment-intent-failed", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      orderWarn("POST /stripe-payment-intent-failed 503");
      return res.status(503).json({ error: "Database not configured" });
    }
    const { orderId, paymentIntentId, message, email, priorEmail, clientCheckoutSessionId, linkedDraftOrderId } =
      req.body || {};
    const msg = message != null && String(message).trim() ? String(message).trim() : "Payment failed";

    if (orderId) {
      const oid = String(orderId).trim();
      const o = await Order.findById(oid);
      if (!o || o.status !== "pending_payment" || o.paymentProvider !== "stripe") {
        return res.status(404).json({ error: "No matching checkout draft" });
      }
      if (req.customerUser) {
        if (String(o.customerId) !== String(req.customerUser._id)) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        const okGuest = await guestMayAccessCheckoutDraft(o, {
          email,
          priorEmail,
          clientCheckoutSessionId,
          linkedDraftOrderId,
          customer: req.body.customer,
        });
        if (!okGuest) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }
      const updated = await markStripeDraftPaymentFailedByOrderId(oid, paymentIntentId, msg);
      if (!updated) return res.status(404).json({ error: "No matching checkout draft" });
      return res.json(updated);
    }

    if (paymentIntentId) {
      const updated = await markStripeDraftPaymentFailed(String(paymentIntentId).trim(), msg);
      if (!updated) return res.status(404).json({ error: "No matching checkout draft" });
      return res.json(updated);
    }

    return res.status(400).json({ error: "orderId or paymentIntentId required" });
  } catch (e) {
    orderErr("stripe-payment-intent-failed", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/cancel-checkout-draft — pending_payment → cancelled. */
router.post("/cancel-checkout-draft", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      return res.status(503).json({ error: "Database not configured" });
    }
    const { orderId, email, priorEmail, clientCheckoutSessionId, linkedDraftOrderId, customer } = req.body || {};
    const oid = String(orderId || "").trim();
    if (!oid) return res.status(400).json({ error: "orderId required" });
    const o = await Order.findById(oid);
    const stripeDraft =
      o && o.paymentProvider === "stripe" && ["pending_payment", "payment_failed"].includes(o.status);
    const paypalDraft = o && o.paymentProvider === "paypal" && o.status === "pending_payment";
    if (!o || (!stripeDraft && !paypalDraft)) {
      return res.status(404).json({ error: "No matching checkout draft" });
    }
    if (req.customerUser) {
      if (String(o.customerId) !== String(req.customerUser._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      const okGuest = await guestMayAccessCheckoutDraft(o, {
        email,
        priorEmail,
        clientCheckoutSessionId,
        linkedDraftOrderId,
        customer,
      });
      if (!okGuest) return res.status(403).json({ error: "Forbidden" });
    }
    if (paypalDraft && o.paymentReferenceId) {
      const cr = await paypalCancelOrder(String(o.paymentReferenceId).trim());
      if (!cr.ok) orderWarn(`POST /cancel-checkout-draft: PayPal cancel: ${cr.message || "unknown"}`);
    }
    const order = await Order.findByIdAndUpdate(
      oid,
      {
        $set: {
          status: "cancelled",
          notes: o.notes ? `${o.notes}\nCheckout abandoned.` : "Checkout abandoned.",
        },
      },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    invalidateAdminStatsCache();
    orderInfo("POST /cancel-checkout-draft ok", { orderId: oid, provider: o.paymentProvider });
    res.json(order);
  } catch (e) {
    orderErr("cancel-checkout-draft", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/orders/checkout-draft — update pending_payment or payment_failed Stripe draft + CustomerUser; recreate PI when amount changes or after a failed attempt.
 * Guest auth: priorEmail (or email) must match the email on file for this draft (order snapshot or linked account).
 */
router.patch("/checkout-draft", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      return res.status(503).json({ error: "Server not configured" });
    }
    const { orderId, email, priorEmail, customer, items, shippingCents, taxCents, clientCheckoutSessionId, linkedDraftOrderId } =
      req.body || {};
    const oid = String(orderId || "").trim();
    if (!oid) return res.status(400).json({ error: "orderId required" });
    if (!items?.length || !Array.isArray(items)) {
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    const itemsPayloadErr = validateCheckoutItemsPayload(items);
    if (itemsPayloadErr) return res.status(400).json({ error: itemsPayloadErr });
    if (!isFullCustomerPayload(customer)) {
      return res.status(400).json({ error: "Full billing is required." });
    }
    const o = await Order.findById(oid);
    if (!o || o.paymentProvider !== "stripe" || !["pending_payment", "payment_failed"].includes(o.status)) {
      return res.status(404).json({ error: "No matching checkout draft" });
    }

    if (req.customerUser) {
      if (String(o.customerId) !== String(req.customerUser._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      const okGuest = await guestMayAccessCheckoutDraft(o, {
        email,
        priorEmail,
        clientCheckoutSessionId,
        linkedDraftOrderId,
        customer,
      });
      if (!okGuest) return res.status(403).json({ error: "Forbidden" });
    }

    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const amountCents = computeCardCheckoutAmountCents(items, shipCents, taxCentsVal);
    if (amountCents < 50) {
      return res.status(400).json({ error: "Amount too small" });
    }

    const cu = await migrateGuestCustomerEmailOnCheckoutPatch({
      previousCustomerId: o.customerId,
      customer,
    });
    if (!cu) {
      return res.status(500).json({ error: "Could not update customer record" });
    }
    const effectiveCustomerId = req.customerUser?._id || cu._id;
    const totalCents = sumItemsCents(items);
    const discountCents = computeAutoDiscountCents(items);
    const storedItems = sanitizeItemsForOrderStorage(items);
    const notesVal =
      customer?.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined;

    const oldPi = o.paymentReferenceId ? String(o.paymentReferenceId).trim() : "";
    let clientSecret = null;
    let paymentReferenceId = oldPi;
    const needFreshPiAfterFailure = o.status === "payment_failed";

    if (oldPi) {
      let shouldReplacePi = needFreshPiAfterFailure;
      if (!shouldReplacePi) {
        try {
          const pi = await stripe.paymentIntents.retrieve(oldPi);
          shouldReplacePi = pi.amount !== amountCents;
        } catch (e) {
          orderWarn(`PATCH checkout-draft PI retrieve ${oldPi}: ${e?.message || e}`);
          shouldReplacePi = true;
        }
      }
      if (shouldReplacePi) {
        try {
          await stripe.paymentIntents.cancel(oldPi);
        } catch (e) {
          orderWarn(`PATCH checkout-draft cancel PI ${oldPi}: ${e?.message || e}`);
        }
        const custPi = buildOrderCustomer(customer);
        const emailPi = custPi.email || "";
        const namePi = [custPi.firstName, custPi.lastName].filter(Boolean).join(" ").trim();
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          payment_method_types: ["card"],
          description: emailPi ? `Custom Sports Cards checkout (${emailPi})` : "Custom Sports Cards checkout",
          metadata: {
            orderId: oid,
            ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
          },
          receipt_email: emailPi || undefined,
        });
        paymentReferenceId = paymentIntent.id;
        clientSecret = paymentIntent.client_secret;
      }
    }

    if (!paymentReferenceId) {
      const custPi = buildOrderCustomer(customer);
      const emailPi = custPi.email || "";
      const namePi = [custPi.firstName, custPi.lastName].filter(Boolean).join(" ").trim();
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        payment_method_types: ["card"],
        description: emailPi ? `Custom Sports Cards checkout (${emailPi})` : "Custom Sports Cards checkout",
        metadata: {
          orderId: oid,
          ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
        },
        receipt_email: emailPi || undefined,
      });
      paymentReferenceId = paymentIntent.id;
      clientSecret = paymentIntent.client_secret;
    }

    const patchSessionNorm = String(clientCheckoutSessionId || "").trim();
    await Order.findByIdAndUpdate(oid, {
      $set: {
        status: "pending_payment",
        paymentReferenceId,
        items: storedItems,
        totalCents,
        discountCents,
        shippingCents: shipCents,
        taxCents: taxCentsVal,
        customer: buildOrderCustomer(customer),
        customerId: effectiveCustomerId,
        notes: notesVal,
        createAccount: Boolean(customer?.createAccount),
        ...(patchSessionNorm.length >= 8 ? { checkoutBrowserSessionId: patchSessionNorm } : {}),
      },
      $unset: { paymentLastError: "" },
    });
    invalidateAdminStatsCache();
    orderInfo("PATCH /checkout-draft ok", { orderId: oid, newPi: Boolean(clientSecret) });
    res.json({ ok: true, orderId: oid, ...(clientSecret ? { clientSecret } : {}) });
  } catch (e) {
    orderErr("checkout-draft PATCH", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/resume-payment-intent — new PaymentIntent for an existing pending_payment or payment_failed Stripe draft (same order row). */
router.post("/resume-payment-intent", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      orderWarn("POST /resume-payment-intent 503");
      return res.status(503).json({ error: "Server not configured" });
    }
    const { orderId, email, priorEmail, clientCheckoutSessionId, linkedDraftOrderId, customer } = req.body || {};
    const oid = String(orderId || "").trim();
    if (!oid) return res.status(400).json({ error: "orderId required" });
    const o = await Order.findById(oid);
    if (!o || o.paymentProvider !== "stripe" || !["pending_payment", "payment_failed"].includes(o.status)) {
      return res.status(404).json({ error: "No matching checkout draft" });
    }
    if (req.customerUser) {
      if (String(o.customerId) !== String(req.customerUser._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      const okGuest = await guestMayAccessCheckoutDraft(o, {
        email,
        priorEmail,
        clientCheckoutSessionId,
        linkedDraftOrderId,
        customer,
      });
      if (!okGuest) return res.status(403).json({ error: "Forbidden" });
    }
    const amountCents = computeCardCheckoutAmountCents(o.items, o.shippingCents, o.taxCents);
    if (amountCents < 50) {
      return res.status(400).json({ error: "Amount too small" });
    }
    const oldPi = o.paymentReferenceId ? String(o.paymentReferenceId).trim() : "";
    if (oldPi) {
      try {
        await stripe.paymentIntents.cancel(oldPi);
      } catch (e) {
        orderWarn(`resume-payment-intent: could not cancel old PI ${oldPi}: ${e?.message || e}`);
      }
    }
    const rawC = o.customer;
    const cust =
      rawC && typeof rawC === "object"
        ? typeof rawC.toObject === "function"
          ? rawC.toObject()
          : { ...rawC }
        : {};
    const emailPi = String(cust.email || "").trim();
    const namePi = [cust.firstName, cust.lastName].filter(Boolean).join(" ").trim();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      payment_method_types: ["card"],
      description: emailPi ? `Custom Sports Cards checkout (${emailPi})` : "Custom Sports Cards checkout",
      metadata: {
        orderId: oid,
        ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
      },
      receipt_email: emailPi || undefined,
    });
    const resumeSessionNorm = String(clientCheckoutSessionId || "").trim();
    await Order.findByIdAndUpdate(oid, {
      $set: {
        status: "pending_payment",
        paymentReferenceId: paymentIntent.id,
        ...(resumeSessionNorm.length >= 8 ? { checkoutBrowserSessionId: resumeSessionNorm } : {}),
      },
      $unset: { paymentLastError: "" },
    });
    orderInfo("resume-payment-intent ok", { orderId: oid, paymentIntentId: paymentIntent.id });
    invalidateAdminStatsCache();
    res.json({ clientSecret: paymentIntent.client_secret, orderId: oid });
  } catch (e) {
    orderErr("resume-payment-intent", e);
    res.status(500).json({ error: e.message });
  }
});

function draftJsonFromOrder(draft) {
  const base = {
    id: String(draft._id),
    orderCode: draft.orderCode,
    status: draft.status,
    paymentProvider: draft.paymentProvider || "stripe",
    paymentReferenceId: draft.paymentReferenceId,
    createdAt: draft.createdAt,
  };
  if (draft.paymentProvider === "paypal") {
    return {
      ...base,
      placementRef: draft.paypalPlacementRef || undefined,
      paypalOrderId: draft.paymentReferenceId || undefined,
    };
  }
  return base;
}

/** GET /api/orders/checkout-draft — pending card or PayPal draft for customer, or ?browserSessionId= for tab-scoped guest lookup. */
router.get("/checkout-draft", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      return res.status(503).json({ error: "Database not configured" });
    }
    const browserSid = String(req.query.browserSessionId || "").trim();
    // Logged-in customers are keyed by customerId only — avoid a stale tab session id matching someone else's draft.
    if (!req.customerUser?._id && browserSid.length >= 8) {
      const bySession = await Order.findOne({
        checkoutBrowserSessionId: browserSid,
        status: { $in: ["pending_payment", "payment_failed"] },
        paymentProvider: { $in: ["stripe", "paypal"] },
      })
        .sort({ createdAt: -1 })
        .lean();
      if (bySession) {
        return res.json({ draft: draftJsonFromOrder(bySession) });
      }
    }
    let customerId = null;
    if (req.customerUser?._id) {
      customerId = req.customerUser._id;
    } else {
      const em = String(req.query.email || "").trim().toLowerCase();
      if (!em) return res.json({ draft: null });
      const u = await CustomerUser.findOne({ email: em }).select("_id").lean();
      if (!u) return res.json({ draft: null });
      customerId = u._id;
    }
    const draft = await Order.findOne({
      customerId,
      status: { $in: ["pending_payment", "payment_failed"] },
      paymentProvider: { $in: ["stripe", "paypal"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!draft) return res.json({ draft: null });
    res.json({ draft: draftJsonFromOrder(draft) });
  } catch (e) {
    orderErr("checkout-draft", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
