import { Router } from "express";
import Stripe from "stripe";
import { Order } from "../models/Order.js";
import { dbConnected } from "../db.js";
import { optionalCustomer } from "../middleware/auth.js";
import { notifyOrderPlaced } from "../services/orderEmails.js";
import { invalidateAdminStatsCache } from "../services/adminStatsCache.js";
import { upsertCustomerFromCheckout } from "../services/customerProfile.js";
import { getOrderCustomerView } from "../services/orderCustomer.js";
import { CustomerUser } from "../models/CustomerUser.js";
import {
  isPayPalConfigured,
  paypalCreateOrder,
  paypalCaptureOrder,
  paypalParseCapture,
} from "../services/paypalRest.js";

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

/** Build order customer object from request body (all address/details). */
function buildOrderCustomer(customer) {
  if (!customer || (!customer.email?.trim() && !customer.firstName?.trim() && !customer.lastName?.trim())) return {};
  return {
    email: (String(customer.email || "").trim() || undefined)?.toLowerCase(),
    firstName: String(customer.firstName || "").trim() || undefined,
    lastName: String(customer.lastName || "").trim() || undefined,
    phone: customer.phone ? String(customer.phone).trim() : undefined,
    address: customer.address ? String(customer.address).trim() : undefined,
    company: customer.company ? String(customer.company).trim() : undefined,
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
  return out;
}

/** POST /api/orders/create-checkout-session
 * Body: { customer, items, successUrl, cancelUrl } (items have templateId, templateName, quantity, priceCents, etc.)
 * Creates order in DB (pending_payment), creates Stripe Checkout Session, returns { sessionId, url, orderId }.
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
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0) * (i.quantity || 1), 0);
    const shipCents = Number(shippingCents) || 0;
    orderInfo("POST /create-checkout-session", {
      itemLines: items.length,
      subtotalCents: totalCents,
      shippingCents: shipCents,
      customerLoggedIn: Boolean(req.customerUser),
    });
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const orderDoc = await Order.create({
      status: "pending_payment",
      paymentProvider: "stripe",
      customerId: cu._id,
      items,
      totalCents,
      shippingCents: shipCents,
      notes: customer.notes ? String(customer.notes).trim() : undefined,
      createAccount: Boolean(customer.createAccount),
    });
    const orderId = orderDoc._id.toString();

    // Each cart item is one Stripe line: priceCents = total for that line, quantity = 1
    const lineItems = items.map((i) => ({
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
      client_reference_id: orderId,
      customer_email: email || undefined,
      metadata: {
        orderId,
        customer_email: email,
        ...(customerName ? { customer_name: customerName.slice(0, 500) } : {}),
      },
    });

    orderDoc.stripeSessionId = session.id;
    orderDoc.paymentProvider = "stripe";
    orderDoc.paymentReferenceId = session.id;
    await orderDoc.save();

    orderInfo("create-checkout-session ok", { orderId, sessionId: session.id });
    res.json({ sessionId: session.id, url: session.url, orderId });
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
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
    const shipCents = Number(shippingCents) || 0;
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const orderDoc = await Order.create({
      status: "confirmed",
      paymentProvider: "manual",
      customerId: cu._id,
      items,
      totalCents,
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

/** POST /api/orders/confirm-session - body: { sessionId }. Verifies Stripe session and marks order paid. */
router.post("/confirm-session", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      orderWarn("POST /confirm-session 503: server not configured");
      return res.status(503).json({ error: "Server not configured" });
    }
    const { sessionId } = req.body || {};
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
    const orderId = session.client_reference_id || session.metadata?.orderId;
    if (!orderId) {
      orderWarn("POST /confirm-session 400: no order id on session");
      return res.status(400).json({ error: "Order not found" });
    }
    const prev = await Order.findById(orderId);
    if (!prev) {
      orderWarn(`POST /confirm-session 404: order not found id=${orderId}`);
      return res.status(404).json({ error: "Order not found" });
    }
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
      orderId,
      { $set: update, $unset: { customer: "" } },
      { new: true }
    );
    if (!order) {
      orderWarn(`POST /confirm-session 404: order vanished after read id=${orderId}`);
      return res.status(404).json({ error: "Order not found" });
    }
    if (prev.status !== "confirmed" && order.status === "confirmed") {
      notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (confirm-session)", err));
    }
    orderInfo("POST /confirm-session ok", { orderId, fromStatus: prev.status, to: order.status });
    invalidateAdminStatsCache();
    res.json(order);
  } catch (e) {
    orderErr("confirm-session", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/create-payment-intent
 * Body: { customer, items, shippingCents, taxCents }. **customer is required** (full billing) so the order is stored with name, email, phone, and address.
 * Creates order (pending_payment), creates PaymentIntent (card only), returns { clientSecret, orderId }.
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
    const { customer, items, shippingCents, taxCents } = req.body || {};
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /create-payment-intent 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /create-payment-intent 400: full customer required (complete billing on checkout first)");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const amountCents = totalCents + shipCents + taxCentsVal;
    if (amountCents < 50) {
      orderWarn("POST /create-payment-intent 400: amount too small", { amountCents });
      return res.status(400).json({ error: "Amount too small" });
    }
    orderInfo("POST /create-payment-intent", {
      itemLines: items.length,
      amountCents,
      hasCustomer: true,
    });
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const orderDoc = await Order.create({
      status: "pending_payment",
      paymentProvider: "stripe",
      customerId: cu._id,
      items,
      totalCents,
      shippingCents: shipCents,
      notes: customer.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined,
      createAccount: Boolean(customer.createAccount),
    });
    const orderId = orderDoc._id.toString();
    const custPi = buildOrderCustomer(customer);
    const emailPi = custPi.email || "";
    const namePi = [custPi.firstName, custPi.lastName].filter(Boolean).join(" ").trim();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      payment_method_types: ["card"],
      description: emailPi
        ? `Custom Sports Cards order ${orderId} (${emailPi})`
        : `Custom Sports Cards order ${orderId}`,
      metadata: {
        orderId,
        ...(emailPi ? { customer_email: emailPi, ...(namePi ? { customer_name: namePi.slice(0, 500) } : {}) } : {}),
      },
      receipt_email: emailPi || undefined,
    });
    orderDoc.paymentReferenceId = paymentIntent.id;
    await orderDoc.save();
    orderInfo("create-payment-intent ok", { orderId, paymentIntentId: paymentIntent.id });
    invalidateAdminStatsCache();
    res.json({ clientSecret: paymentIntent.client_secret, orderId });
  } catch (e) {
    orderErr("create-payment-intent", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/confirm-payment - body: { paymentIntentId, customer? }. Verifies payment and marks order confirmed; optional customer updates order. */
router.post("/confirm-payment", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected() || !stripe) {
      orderWarn("POST /confirm-payment 503: server not configured");
      return res.status(503).json({ error: "Server not configured" });
    }
    const { paymentIntentId, customer } = req.body || {};
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
    const orderId = paymentIntent.metadata?.orderId;
    if (!orderId) {
      orderWarn("POST /confirm-payment 400: no orderId in PI metadata");
      return res.status(400).json({ error: "Order not found" });
    }
    const prev = await Order.findById(orderId);
    if (!prev) {
      orderWarn(`POST /confirm-payment 404: order not found id=${orderId}`);
      return res.status(404).json({ error: "Order not found" });
    }
    const update = { status: "confirmed", paymentProvider: "stripe", paymentReferenceId: paymentIntentId };
    if (customer?.notes != null && String(customer.notes).trim()) {
      update.notes = String(customer.notes).trim();
    }
    const ch = paymentIntent.latest_charge;
    const fromStripeObj =
      typeof ch === "object" && ch && ch.billing_details
        ? customerFromStripeBilling(ch.billing_details)
        : null;
    const mergedForSave = { ...(fromStripeObj || {}), ...(customer || {}) };
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
    if (req.customerUser?._id) {
      update.customerId = req.customerUser._id;
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
    const order = await Order.findByIdAndUpdate(
      orderId,
      { $set: update, $unset: { customer: "" } },
      { new: true }
    );
    if (!order) {
      orderWarn(`POST /confirm-payment 404: order update returned null id=${orderId}`);
      return res.status(404).json({ error: "Order not found" });
    }

    const orderForReceipt = await Order.findById(orderId).populate({
      path: "customerId",
      select: "email firstName lastName phone company address addressLine2 city state zip country",
    });
    const custView = getOrderCustomerView(
      orderForReceipt ? orderForReceipt.toObject() : { customer: prevC, customerId: null }
    );
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

    if (prev.status !== "confirmed" && order.status === "confirmed") {
      notifyOrderPlaced(order).catch((err) => orderErr("notifyOrderPlaced (confirm-payment)", err));
    }
    orderInfo("POST /confirm-payment ok", { orderId, fromStatus: prev.status, to: order.status });
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
    res.json({ enabled: Boolean(enabled && clientId), clientId: enabled ? clientId : "" });
  } catch (e) {
    orderErr("paypal-client-config", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/create-paypal-order — same body as create-payment-intent; returns { orderId, paypalOrderId }. */
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
    const { customer, items, shippingCents, taxCents } = req.body || {};
    if (!items?.length || !Array.isArray(items)) {
      orderWarn("POST /create-paypal-order 400: items invalid");
      return res.status(400).json({ error: "items (non-empty array) required" });
    }
    if (!isFullCustomerPayload(customer)) {
      orderWarn("POST /create-paypal-order 400: full customer required");
      return res
        .status(400)
        .json({ error: "Full billing is required: email, name, phone, country, and complete shipping address." });
    }
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
    const shipCents = Number(shippingCents) || 0;
    const taxCentsVal = Number(taxCents) || 0;
    const amountCents = totalCents + shipCents + taxCentsVal;
    if (amountCents < 50) {
      orderWarn("POST /create-paypal-order 400: amount too small", { amountCents });
      return res.status(400).json({ error: "Amount too small" });
    }
    const valueUsd = (amountCents / 100).toFixed(2);
    const cu = await upsertCustomerFromCheckout(customer);
    if (!cu) {
      return res.status(500).json({ error: "Could not create customer record" });
    }
    const orderDoc = await Order.create({
      status: "pending_payment",
      paymentProvider: "paypal",
      customerId: cu._id,
      items,
      totalCents,
      shippingCents: shipCents,
      notes: customer.notes != null && String(customer.notes).trim() ? String(customer.notes).trim() : undefined,
      createAccount: Boolean(customer.createAccount),
    });
    const orderId = orderDoc._id.toString();
    const pp = await paypalCreateOrder({ valueUsd, customId: orderId });
    orderDoc.paymentReferenceId = pp.id;
    await orderDoc.save();
    orderInfo("create-paypal-order ok", { orderId, paypalOrderId: pp.id });
    invalidateAdminStatsCache();
    res.json({ orderId, paypalOrderId: pp.id });
  } catch (e) {
    orderErr("create-paypal-order", e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/orders/capture-paypal-order — body: { orderId, paypalOrderId, customer? }. Server captures and confirms order. */
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
    const { orderId, paypalOrderId, customer } = req.body || {};
    if (!orderId || !paypalOrderId) {
      orderWarn("POST /capture-paypal-order 400: missing ids");
      return res.status(400).json({ error: "orderId and paypalOrderId required" });
    }
    orderInfo("POST /capture-paypal-order", { orderId, paypalOrderId });
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
    if (storedRef && storedRef !== String(paypalOrderId).trim()) {
      orderWarn(`POST /capture-paypal-order 400: paypal order mismatch id=${orderId}`);
      return res.status(400).json({ error: "PayPal order does not match this checkout" });
    }
    const captured = await paypalCaptureOrder(String(paypalOrderId).trim());
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
      paymentReferenceId: parsed.captureId || String(paypalOrderId).trim(),
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
    orderInfo("POST /capture-paypal-order ok", { orderId, captureId: parsed.captureId });
    invalidateAdminStatsCache();
    res.json(order);
  } catch (e) {
    orderErr("capture-paypal-order", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
