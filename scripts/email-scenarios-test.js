/**
 * Sends every order-notification email template to one inbox (for QA).
 * Usage:
 *   npm run email:scenarios -- you@example.com
 *   npm run email:scenarios   (uses SMTP_USER from .env)
 */
import "../load-env.js";

const recipient = (process.argv[2] || process.env.SMTP_USER || "").trim();
if (!recipient) {
  console.error("Usage: npm run email:scenarios -- <email>\n   Or set SMTP_USER in .env");
  process.exit(1);
}

/** Route admin notifications to the same inbox for this test run. */
process.env.ADMIN_EMAIL = recipient;

const {
  sendOrderPlacedCustomerEmail,
  sendOrderPlacedAdminEmail,
  sendOrderStatusChangedCustomerEmail,
  sendTrackingInfoCustomerEmail,
} = await import("../services/orderEmails.js");

const baseOrder = {
  _id: { toString: () => "507f1f77bcf86cd799439011" },
  id: "507f1f77bcf86cd799439011",
  customer: {
    email: recipient,
    firstName: "Alex",
    lastName: "Test",
  },
  items: [
    {
      templateId: "baseball/classic-pro",
      templateName: "Classic Pro Card",
      quantity: 25,
      priceCents: 4999,
      designSnapshot: {
        playerPhoto: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    },
  ],
  totalCents: 4999,
  shippingCents: 599,
};

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const scenarios = [
  {
    name: "1) Customer — order received (paid)",
    run: () => sendOrderPlacedCustomerEmail({ ...baseOrder, status: "confirmed" }),
  },
  {
    name: "2) Admin — new order + print PDF attachment",
    run: () => sendOrderPlacedAdminEmail({ ...baseOrder, status: "confirmed" }),
  },
  {
    name: "3) Customer — status change (Confirmed → In production)",
    run: () =>
      sendOrderStatusChangedCustomerEmail(
        { ...baseOrder, status: "in_production" },
        "confirmed"
      ),
  },
  {
    name: "4) Customer — status change (In production → Shipped)",
    run: () =>
      sendOrderStatusChangedCustomerEmail({ ...baseOrder, status: "shipped" }, "in_production"),
  },
  {
    name: "5) Customer — tracking (UPS auto link)",
    run: () =>
      sendTrackingInfoCustomerEmail({
        ...baseOrder,
        status: "shipped",
        trackingCarrier: "UPS",
        trackingNumber: "1Z999AA10123456784",
      }),
  },
  {
    name: "6) Customer — tracking (custom URL override)",
    run: () =>
      sendTrackingInfoCustomerEmail({
        ...baseOrder,
        status: "shipped",
        trackingCarrier: "OTHER",
        trackingNumber: "TRACK-999",
        trackingUrl: "https://example.com/track?id=TRACK-999",
      }),
  },
];

console.log(`Sending ${scenarios.length} scenario emails to: ${recipient}\n`);

for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i];
  process.stdout.write(`${s.name} … `);
  try {
    await s.run();
    console.log("sent");
  } catch (e) {
    console.log("FAILED");
    console.error(e?.message || e);
    process.exitCode = 1;
  }
  if (i < scenarios.length - 1) await delay(800);
}

console.log("\nDone. Check inbox (and Junk) for subjects:");
console.log("  • Order received — #99439011");
console.log("  • [Custom Sports Cards] New order #99439011 — print pack attached");
console.log("  • Order update — #99439011 (In production)");
console.log("  • Order update — #99439011 (Shipped)");
console.log("  • Your shipment is on the way — #99439011 (×2 for UPS + custom URL tests)");
