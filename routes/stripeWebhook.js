import Stripe from "stripe";
import {
  finalizeStripeDraftOrderFromSucceededIntent,
  markStripeDraftPaymentFailed,
} from "../services/stripeOrderFinalize.js";

const P = "[stripe-webhook]";

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleRawStripeWebhook(req, res) {
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-11-20.acacia" })
    : null;
  if (!stripe || !secret) {
    console.warn(`${P} 503: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not set`);
    return res.status(503).send("Webhook not configured");
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing stripe-signature");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.warn(`${P} signature verify failed:`, err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = /** @type {import("stripe").Stripe.PaymentIntent} */ (event.data.object);
        const expanded = await stripe.paymentIntents.retrieve(pi.id, { expand: ["latest_charge"] });
        const result = await finalizeStripeDraftOrderFromSucceededIntent(stripe, expanded, {});
        if (!result.ok && result.code !== "no_draft") {
          console.log(`${P} payment_intent.succeeded finalize`, { piId: pi.id, code: result.code });
        }
        break;
      }
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const pi = /** @type {import("stripe").Stripe.PaymentIntent} */ (event.data.object);
        const msg =
          pi.last_payment_error?.message ||
          (event.type === "payment_intent.canceled" ? "Payment canceled" : "Payment failed");
        await markStripeDraftPaymentFailed(pi.id, msg);
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error(`${P} handler error:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
}
