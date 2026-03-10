import { Router } from "express";
import Stripe from "stripe";
import { Order } from "../models/Order.js";
import { getPriceConfig } from "../models/PriceConfig.js";
import { dbConnected } from "../db.js";
import { optionalCustomer } from "../middleware/auth.js";

const router = Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-11-20.acacia" }) : null;

/** POST /api/orders/create-checkout-session
 * Body: { customer, items, successUrl, cancelUrl } (items have templateId, templateName, quantity, priceCents, etc.)
 * Creates order in DB (pending_payment), creates Stripe Checkout Session, returns { sessionId, url, orderId }.
 */
router.post("/create-checkout-session", optionalCustomer, async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Database not configured" });
  }
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });
  }
  const { customer, items, successUrl, cancelUrl, shippingCents } = req.body || {};
  if (!customer?.email?.trim() || !customer?.firstName?.trim() || !customer?.lastName?.trim()) {
    return res.status(400).json({ error: "customer.email, firstName, lastName required" });
  }
  if (!items?.length || !Array.isArray(items)) {
    return res.status(400).json({ error: "items (non-empty array) required" });
  }
  const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0) * (i.quantity || 1), 0);
  const shipCents = Number(shippingCents) || 0;
  const orderDoc = await Order.create({
    status: "pending_payment",
    customerId: req.customerUser?._id || undefined,
    customer: {
      email: String(customer.email).trim().toLowerCase(),
      firstName: String(customer.firstName).trim(),
      lastName: String(customer.lastName).trim(),
      phone: customer.phone ? String(customer.phone).trim() : undefined,
      address: customer.address ? String(customer.address).trim() : undefined,
    },
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

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: lineItems,
    success_url: successUrl || `${req.protocol}://${req.get("host")}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${req.protocol}://${req.get("host")}/checkout`,
    client_reference_id: orderId,
    metadata: { orderId },
  });

  orderDoc.stripeSessionId = session.id;
  await orderDoc.save();

  res.json({ sessionId: session.id, url: session.url, orderId });
});

/** POST /api/orders/place-without-payment - creates order with status "confirmed" (no Stripe). Temporary bypass for testing. */
router.post("/place-without-payment", optionalCustomer, async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Database not configured" });
  }
  const { customer, items, shippingCents } = req.body || {};
  if (!customer?.email?.trim() || !customer?.firstName?.trim() || !customer?.lastName?.trim()) {
    return res.status(400).json({ error: "customer.email, firstName, lastName required" });
  }
  if (!items?.length || !Array.isArray(items)) {
    return res.status(400).json({ error: "items (non-empty array) required" });
  }
  const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
  const shipCents = Number(shippingCents) || 0;
  const orderDoc = await Order.create({
    status: "confirmed",
    customerId: req.customerUser?._id || undefined,
    customer: {
      email: String(customer.email).trim().toLowerCase(),
      firstName: String(customer.firstName).trim(),
      lastName: String(customer.lastName).trim(),
      phone: customer.phone ? String(customer.phone).trim() : undefined,
      address: customer.address ? String(customer.address).trim() : undefined,
      ...(customer.company && { company: String(customer.company).trim() }),
      ...(customer.addressLine2 && { addressLine2: String(customer.addressLine2).trim() }),
      ...(customer.city && { city: String(customer.city).trim() }),
      ...(customer.state && { state: String(customer.state).trim() }),
      ...(customer.zip && { zip: String(customer.zip).trim() }),
      ...(customer.country && { country: String(customer.country).trim() }),
    },
    items,
    totalCents,
    shippingCents: shipCents,
    notes: customer.notes ? String(customer.notes).trim() : undefined,
    createAccount: Boolean(customer.createAccount),
  });
  res.status(201).json({ id: orderDoc._id.toString() });
});

/** POST /api/orders/confirm-session - body: { sessionId }. Verifies Stripe session and marks order paid. */
router.post("/confirm-session", async (req, res) => {
  if (!dbConnected() || !stripe) {
    return res.status(503).json({ error: "Server not configured" });
  }
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid") {
    return res.status(400).json({ error: "Session not paid" });
  }
  const orderId = session.client_reference_id || session.metadata?.orderId;
  if (!orderId) {
    return res.status(400).json({ error: "Order not found" });
  }
  const order = await Order.findByIdAndUpdate(orderId, { status: "confirmed" }, { new: true });
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(order);
});

/** POST /api/orders/create-payment-intent
 * Body: { customer?, items, shippingCents, taxCents }. Customer optional so card fields can show immediately.
 * Creates order (pending_payment), creates PaymentIntent (card only), returns { clientSecret, orderId }.
 */
router.post("/create-payment-intent", optionalCustomer, async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Database not configured" });
  }
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });
  }
  const { customer, items, shippingCents, taxCents } = req.body || {};
  if (!items?.length || !Array.isArray(items)) {
    return res.status(400).json({ error: "items (non-empty array) required" });
  }
  const totalCents = items.reduce((sum, i) => sum + (i.priceCents || 0), 0);
  const shipCents = Number(shippingCents) || 0;
  const taxCentsVal = Number(taxCents) || 0;
  const amountCents = totalCents + shipCents + taxCentsVal;
  if (amountCents < 50) {
    return res.status(400).json({ error: "Amount too small" });
  }
  const hasCustomer = customer && (customer.email?.trim() || customer.firstName?.trim() || customer.lastName?.trim());
  const orderDoc = await Order.create({
    status: "pending_payment",
    customerId: req.customerUser?._id || undefined,
    customer: hasCustomer
      ? {
          email: (String(customer.email || "").trim() || undefined)?.toLowerCase(),
          firstName: String(customer.firstName || "").trim() || undefined,
          lastName: String(customer.lastName || "").trim() || undefined,
          phone: customer.phone ? String(customer.phone).trim() : undefined,
          address: customer.address ? String(customer.address).trim() : undefined,
          ...(customer.company && { company: String(customer.company).trim() }),
          ...(customer.addressLine2 && { addressLine2: String(customer.addressLine2).trim() }),
          ...(customer.city && { city: String(customer.city).trim() }),
          ...(customer.state && { state: String(customer.state).trim() }),
          ...(customer.zip && { zip: String(customer.zip).trim() }),
          ...(customer.country && { country: String(customer.country).trim() }),
          notes: customer.notes ? String(customer.notes).trim() : undefined,
          createAccount: Boolean(customer.createAccount),
        }
      : {},
    items,
    totalCents,
    shippingCents: shipCents,
  });
  const orderId = orderDoc._id.toString();
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    metadata: { orderId },
    payment_method_types: ["card"],
  });
  res.json({ clientSecret: paymentIntent.client_secret, orderId });
});

/** POST /api/orders/confirm-payment - body: { paymentIntentId, customer? }. Verifies payment and marks order confirmed; optional customer updates order. */
router.post("/confirm-payment", optionalCustomer, async (req, res) => {
  if (!dbConnected() || !stripe) {
    return res.status(503).json({ error: "Server not configured" });
  }
  const { paymentIntentId, customer } = req.body || {};
  if (!paymentIntentId) {
    return res.status(400).json({ error: "paymentIntentId required" });
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== "succeeded") {
    return res.status(400).json({ error: "Payment not completed" });
  }
  const orderId = paymentIntent.metadata?.orderId;
  if (!orderId) {
    return res.status(400).json({ error: "Order not found" });
  }
  const update = { status: "confirmed", ...(req.customerUser?._id && { customerId: req.customerUser._id }) };
  if (customer && (customer.email?.trim() || customer.firstName?.trim() || customer.lastName?.trim())) {
    update.customer = {
      email: (String(customer.email || "").trim() || undefined)?.toLowerCase(),
      firstName: String(customer.firstName || "").trim() || undefined,
      lastName: String(customer.lastName || "").trim() || undefined,
      phone: customer.phone ? String(customer.phone).trim() : undefined,
      address: customer.address ? String(customer.address).trim() : undefined,
      ...(customer.company && { company: String(customer.company).trim() }),
      ...(customer.addressLine2 && { addressLine2: String(customer.addressLine2).trim() }),
      ...(customer.city && { city: String(customer.city).trim() }),
      ...(customer.state && { state: String(customer.state).trim() }),
      ...(customer.zip && { zip: String(customer.zip).trim() }),
      ...(customer.country && { country: String(customer.country).trim() }),
      notes: customer.notes ? String(customer.notes).trim() : undefined,
      createAccount: Boolean(customer.createAccount),
    };
  }
  const order = await Order.findByIdAndUpdate(orderId, update, { new: true });
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(order);
});

export default router;
