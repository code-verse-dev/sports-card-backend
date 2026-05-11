import {
  sendMailMessage,
  getAdminNotificationEmails,
  getPublicAppBase,
  isMailConfigured,
  getHomePageUrl,
  getMailBrandName,
  getMailBrandTagline,
  getMailLogoUrl,
  getSupportEmail,
  getMailAccentColor,
  getMailAccentLight,
  getMailFooterNote,
  getAdminOrdersUrl,
} from "./mail.js";
import { buildOrderPrintPdfBuffer } from "./orderPdf.js";
import { buildFullOrderCardPdfBufferHeadless } from "./orderCardPdfHeadless.js";
import { getOrderCustomerView } from "./orderCustomer.js";
import { getOrderRef } from "./publicCodes.js";
import { Order } from "../models/Order.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(cents) {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

/** Amount charged: merchandise − discount + shipping + tax. */
function paidTotalCents(order) {
  const merch = Number(order?.totalCents) || 0;
  const disc = Number(order?.discountCents) || 0;
  const ship = Number(order?.shippingCents) || 0;
  const tax = Number(order?.taxCents) || 0;
  return merch - disc + ship + tax;
}

/** True if the customer paid for the digital PDF add-on on any line. */
function orderIncludesPurchasedPdf(order) {
  const items = order.items || [];
  for (const it of items) {
    if (it.pdfOption) return true;
    if (Array.isArray(it.lineItems) && it.lineItems.some((l) => l.pdfOption)) return true;
  }
  return false;
}

function myAccountUrl() {
  const base = getPublicAppBase();
  if (!base) return "/my-account";
  return `${base}/my-account`;
}

/** Rounded CTA — table + bgcolor helps Outlook */
function emailButton(href, label) {
  const accent = getMailAccentColor();
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 8px;">
  <tr>
    <td align="left" bgcolor="${esc(accent)}" style="background:${esc(accent)};border-radius:999px;">
      <a href="${esc(href)}" target="_blank" rel="noopener noreferrer"
        style="display:inline-block;padding:14px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">
        ${esc(label)}
      </a>
    </td>
  </tr>
</table>`;
}

function orderSummaryBlock(order) {
  const accent = getMailAccentColor();
  const items = order.items || [];
  const rows = items.map((it, i) => {
    const name = esc(it.templateName || it.templateId || `Item ${i + 1}`);
    const qty = it.quantity ?? 0;
    return `<tr>
      <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#334155;">${name} <span style="color:#94a3b8;">× ${qty}</span></td>
      <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${formatMoney(it.priceCents)}</td>
    </tr>`;
  });
  const ship = order.shippingCents ?? 0;
  const disc = Number(order.discountCents) || 0;
  const tax = Number(order.taxCents) || 0;
  const merch = Number(order.totalCents) || 0;
  const discountRow =
    disc > 0
      ? `<tr style="background:#f8fafc;">
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748b;">Discount</td>
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">−${formatMoney(disc)}</td>
  </tr>`
      : "";
  const taxRow =
    tax > 0
      ? `<tr style="background:#f8fafc;">
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748b;">Tax</td>
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${formatMoney(tax)}</td>
  </tr>`
      : "";
  const total = paidTotalCents(order);
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 8px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  ${rows.join("")}
  <tr style="background:#f8fafc;">
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748b;">Merchandise subtotal</td>
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${formatMoney(merch)}</td>
  </tr>
  ${discountRow}
  <tr style="background:#f8fafc;">
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748b;">Shipping</td>
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${formatMoney(ship)}</td>
  </tr>
  ${taxRow}
  <tr style="background:${accent};">
    <td style="padding:16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#ffffff;font-weight:700;">Total</td>
    <td style="padding:16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:18px;color:#ffffff;text-align:right;font-weight:700;">${formatMoney(total)}</td>
  </tr>
</table>`;
}

function wrapEmailHtml({ preheader, bodyHtml }) {
  const brand = esc(getMailBrandName());
  const tagline = getMailBrandTagline();
  const logo = getMailLogoUrl();
  const accent = getMailAccentColor();
  const accentLight = getMailAccentLight();
  const year = new Date().getFullYear();
  const home = getHomePageUrl();
  const account = myAccountUrl();
  const support = getSupportEmail();
  const footerNote = getMailFooterNote();

  const headerInner = logo
    ? `<img src="${esc(logo)}" alt="${brand}" width="220" style="display:block;max-width:220px;height:auto;margin:0 auto 12px;border:0;outline:none;" />`
    : `<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.03em;">${brand}</div>`;

  const taglineHtml = tagline
    ? `<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.88);margin-top:10px;line-height:1.4;">${esc(tagline)}</div>`
    : "";

  const links = [];
  if (home) links.push(`<a href="${esc(home)}" style="color:${accent};text-decoration:none;font-weight:600;">Shop</a>`);
  if (account.startsWith("http")) links.push(`<a href="${esc(account)}" style="color:${accent};text-decoration:none;font-weight:600;">My orders</a>`);
  if (support) links.push(`<a href="mailto:${esc(support)}" style="color:${accent};text-decoration:none;">${esc(support)}</a>`);
  const linkRow =
    links.length > 0
      ? `<div style="padding:0 0 20px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#64748b;text-align:center;line-height:2;">${links.join(" &nbsp;·&nbsp; ")}</div>`
      : "";

  const noteHtml = footerNote
    ? `<p style="margin:0 0 14px;font-size:12px;color:#94a3b8;text-align:center;line-height:1.55;">${esc(footerNote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${brand}</title>
<!--[if mso]><style type="text/css">table {border-collapse:collapse;border-spacing:0;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:36px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 40px rgba(15,23,42,0.07);">
        <tr>
          <td style="background:${accent};padding:32px 28px;text-align:center;">
            ${headerInner}
            ${taglineHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#334155;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="background:${accentLight};padding:28px 24px;border-top:1px solid #e2e8f0;">
            ${linkRow}
            ${noteHtml}
            <p style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#94a3b8;text-align:center;line-height:1.5;">© ${year} ${brand}. All rights reserved.</p>
            <p style="margin:10px 0 0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#cbd5e1;text-align:center;">This message was sent automatically.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function customerName(order) {
  const c = getOrderCustomerView(order);
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "there";
}

function statusPill(text, highlight) {
  const accent = getMailAccentColor();
  const light = getMailAccentLight();
  const bg = highlight ? accent : light;
  const fg = highlight ? "#ffffff" : accent;
  return `<span style="display:inline-block;padding:8px 14px;border-radius:999px;background:${bg};color:${fg};font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;">${esc(text)}</span>`;
}

/**
 * @param {import('mongoose').Document | object} order
 * @param {{ fullCardPdfBuffer?: Buffer | null }} [opts]
 */
export async function sendOrderPlacedCustomerEmail(order, opts = {}) {
  const { fullCardPdfBuffer } = opts;
  const email = getOrderCustomerView(order).email?.trim();
  if (!email) return;
  const ref = getOrderRef(order);
  const accent = getMailAccentColor();
  const wantsPdf = orderIncludesPurchasedPdf(order);
  const pdfAttached = Boolean(wantsPdf && fullCardPdfBuffer);
  const pdfNote = wantsPdf
    ? pdfAttached
      ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;">Your <strong>printable card PDF</strong> is attached: front and back for each design where you added the PDF option, at the <strong>print size you chose</strong> for that line.</p>`
      : `<p style="margin:16px 0 0;font-size:14px;color:#475569;">You added the <strong>digital PDF</strong> option. We could not attach the file automatically; reply to this email or contact support with order <strong>#${esc(ref)}</strong> and we will send your PDF.</p>`
    : "";
  const preheader = `Your order #${ref} is confirmed — thank you for choosing ${getMailBrandName()}.`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:17px;color:#0f172a;font-weight:600;">Hi ${esc(customerName(order))},</p>
    <p style="margin:0 0 20px;">Thank you for your order. We’ve received your payment and your custom cards are in our queue.</p>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Order reference</p>
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:${accent};letter-spacing:-0.02em;">#${esc(ref)}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#64748b;">Keep this number for your records.</p>
    ${orderSummaryBlock(order)}
    ${pdfNote}
    <p style="margin:8px 0 0;">Track progress and details anytime in your account.</p>
    ${emailButton(myAccountUrl(), "View my orders")}
  `;
  const attachments = pdfAttached
    ? [{ filename: `order-${ref}-your-cards.pdf`, content: fullCardPdfBuffer, contentType: "application/pdf" }]
    : [];
  await sendMailMessage({
    to: email,
    subject: pdfAttached ? `Order received — #${ref} (PDF attached)` : `Order received — #${ref}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Hi ${customerName(order)}, we received your order #${ref}. Total ${formatMoney(paidTotalCents(order))}. My orders: ${myAccountUrl()}`,
    attachments,
  });
}

/**
 * @param {import('mongoose').Document | object} order
 * @param {{ fullCardPdfBuffer?: Buffer | null; subjectPrefix?: string; sendTo?: string }} [opts]
 * When `sendTo` is set (comma-separated ok), that list is used instead of ADMIN_EMAIL / ADMIN_NOTIFICATION_EMAILS (e.g. QA scripts).
 */
export async function sendOrderPlacedAdminEmail(order, opts = {}) {
  const { fullCardPdfBuffer, subjectPrefix, sendTo } = opts;
  const subjPre = subjectPrefix != null && String(subjectPrefix).trim() ? String(subjectPrefix).trim() + " " : "";
  const rawOverride = sendTo != null ? String(sendTo).trim() : "";
  const admins = rawOverride
    ? rawOverride
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : getAdminNotificationEmails();
  if (admins.length === 0) {
    console.warn("[orderEmails] ADMIN_EMAIL / ADMIN_NOTIFICATION_EMAILS not set — skipping admin notification");
    return;
  }
  const ref = getOrderRef(order);
  const id = order._id?.toString?.() ?? order.id ?? "";
  const brand = getMailBrandName();
  /** @type {Buffer | null} */
  let fallbackSnapshotPdf = null;
  if (!fullCardPdfBuffer) {
    try {
      fallbackSnapshotPdf = await buildOrderPrintPdfBuffer(order);
    } catch (e) {
      console.error("[orderEmails] Snapshot PDF build failed:", e.message);
      fallbackSnapshotPdf = null;
    }
  }
  const adminUrl = getAdminOrdersUrl();
  const cView = getOrderCustomerView(order);
  const custRef = cView.publicId ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b;">Customer ID <strong style="color:#0f172a;font-family:ui-monospace,monospace;">${esc(cView.publicId)}</strong></p>` : "";
  const preheader = `New paid order #${ref} — ${cView.email || ""}`;
  const adminCta = adminUrl
    ? `<p style="margin:16px 0 0;">${emailButton(adminUrl, "Open orders in admin")}</p>`
    : "";
  const attachNote = fullCardPdfBuffer
    ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;">Attached: <strong>full card PDF</strong> for fulfillment — same pipeline as <strong>Admin → Orders → Download card PDF</strong> (Chrome capture per design, then PDF assembly).</p>`
    : fallbackSnapshotPdf
      ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;"><strong>Attached PDF is upload photos only</strong> — one page per customer image file, <em>not</em> the finished card (no template frame, text, or layout). That attachment appears when automatic full-card rendering did not run. For composed front &amp; back: Admin → Orders → open this order → <strong>Download card PDF</strong>. To get composed cards in email automatically: set <code>PUBLIC_APP_URL</code> (live storefront), <code>JWT_SECRET</code>, install Puppeteer on this server, and build the storefront with <code>VITE_API_URL</code> pointing at this API so headless Chrome can load uploads.</p>`
      : `<p style="margin:16px 0 0;font-size:14px;color:#475569;">No PDF attached (no design snapshot images and headless card PDF unavailable).</p>`;
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Fulfillment</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;">New paid order <span style="color:${getMailAccentColor()};">#${esc(ref)}</span></p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
      <tr><td style="padding:16px 18px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;">
        <strong style="color:#64748b;display:block;margin-bottom:6px;">Customer</strong>
        ${esc(cView.email)}<br/>
        <span style="color:#334155;">${esc([cView.firstName, cView.lastName].filter(Boolean).join(" "))}</span>
        ${custRef}
      </td></tr>
    </table>
    ${orderSummaryBlock(order)}
    ${attachNote}
    ${adminCta}
  `;
  const attachments = [];
  if (fullCardPdfBuffer) {
    attachments.push({ filename: `order-${ref}-full-card.pdf`, content: fullCardPdfBuffer, contentType: "application/pdf" });
  } else if (fallbackSnapshotPdf) {
    attachments.push({
      filename: `order-${ref}-upload-photos-only.pdf`,
      content: fallbackSnapshotPdf,
      contentType: "application/pdf",
    });
  }
  const subj =
    subjPre +
    (fullCardPdfBuffer
      ? `[${brand}] New order #${ref} — full card PDF attached`
      : fallbackSnapshotPdf
        ? `[${brand}] New order #${ref} — upload images only (not composed cards)`
        : `[${brand}] New order #${ref}`);
  return await sendMailMessage({
    to: admins,
    subject: subj,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `New order #${ref} (${id}). Customer ${cView.email || ""}${cView.publicId ? ` · ${cView.publicId}` : ""}. Admin: ${adminUrl || "(set PUBLIC_APP_URL)"}`,
    attachments,
  });
}

/**
 * Notify customer + admin when order becomes confirmed (paid).
 * @param {import('mongoose').Document | object} order
 */
export async function notifyOrderPlaced(order) {
  if (!isMailConfigured()) {
    console.warn("[orderEmails] SMTP not configured — order emails skipped");
    return;
  }
  const id = order._id?.toString() || order.id;
  if (!id) return;
  const full = await Order.findById(id)
    .populate({
      path: "customerId",
      select: "email firstName lastName phone address addressLine2 city state zip country publicId",
    })
    .lean();
  if (!full) return;
  const merged = { ...full, id: full._id?.toString() };
  const wantsCustomerPdf = orderIncludesPurchasedPdf(merged);
  let adminCardPdfBuffer = null;
  let customerCardPdfBuffer = null;
  try {
    const adminTask = buildFullOrderCardPdfBufferHeadless(id, { purpose: "admin-download" }).catch((e) => {
      console.error("[orderEmails] Headless admin email card PDF failed:", e?.message || e);
      return null;
    });
    const customerTask = wantsCustomerPdf
      ? buildFullOrderCardPdfBufferHeadless(id, { purpose: "email-customer" }).catch((e) => {
          console.error("[orderEmails] Headless customer email card PDF failed:", e?.message || e);
          return null;
        })
      : Promise.resolve(null);
    [adminCardPdfBuffer, customerCardPdfBuffer] = await Promise.all([adminTask, customerTask]);
  } catch (e) {
    console.error("[orderEmails] Headless order PDF batch failed:", e?.message || e);
  }
  try {
    await sendOrderPlacedCustomerEmail(merged, { fullCardPdfBuffer: customerCardPdfBuffer });
  } catch (e) {
    console.error("[orderEmails] Customer order email failed:", e.message);
  }
  try {
    await sendOrderPlacedAdminEmail(merged, { fullCardPdfBuffer: adminCardPdfBuffer });
  } catch (e) {
    console.error("[orderEmails] Admin order email failed:", e.message);
  }
}

const STATUS_LABELS = {
  pending: "Pending",
  pending_payment: "Awaiting payment",
  payment_failed: "Payment failed",
  confirmed: "Confirmed",
  in_production: "In production",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/**
 * @param {import('mongoose').Document | object} order
 * @param {string} previousStatus
 */
export async function sendOrderStatusChangedCustomerEmail(order, previousStatus) {
  const email = getOrderCustomerView(order).email?.trim();
  if (!email) return;
  const ref = getOrderRef(order);
  const prev = STATUS_LABELS[previousStatus] || previousStatus;
  const cur = STATUS_LABELS[order.status] || order.status;
  const preheader = `Order #${ref}: ${prev} → ${cur}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:17px;color:#0f172a;font-weight:600;">Hi ${esc(customerName(order))},</p>
    <p style="margin:0 0 20px;">We’ve updated the status of your order.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;">
      <tr>
        <td style="padding:20px;background:${getMailAccentLight()};border-radius:14px;border:1px solid #e2e8f0;text-align:center;">
          <p style="margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Status</p>
          <p style="margin:0 0 16px;font-size:15px;color:#475569;">
            ${statusPill(prev, false)} &nbsp;<span style="color:#cbd5e1;font-size:18px;">→</span>&nbsp; ${statusPill(cur, true)}
          </p>
          <p style="margin:0;font-size:13px;color:#64748b;">Order <strong style="color:#0f172a;">#${esc(ref)}</strong></p>
        </td>
      </tr>
    </table>
    ${emailButton(myAccountUrl(), "View order details")}
  `;
  await sendMailMessage({
    to: email,
    subject: `Order update — #${ref} (${cur})`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Order #${ref} status: ${prev} -> ${cur}. ${myAccountUrl()}`,
  });
}

function resolveTrackingUrl(order) {
  const custom = order.trackingUrl?.trim();
  if (custom) return custom;
  const num = order.trackingNumber?.trim();
  if (!num) return "";
  const carrier = (order.trackingCarrier || "UPS").toUpperCase();
  if (carrier === "UPS") {
    return `https://www.ups.com/track?tracknum=${encodeURIComponent(num)}`;
  }
  if (carrier === "USPS") {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(num)}`;
  }
  if (carrier === "FEDEX") {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(num)}`;
  }
  return "";
}

/**
 * @param {import('mongoose').Document | object} order
 */
export async function sendTrackingInfoCustomerEmail(order) {
  const email = getOrderCustomerView(order).email?.trim();
  if (!email) return;
  const num = order.trackingNumber?.trim();
  if (!num) return;
  const ref = getOrderRef(order);
  const trackUrl = resolveTrackingUrl(order);
  const accent = getMailAccentColor();
  const light = getMailAccentLight();
  const preheader = `Tracking for order #${ref}: ${num}`;
  const linkBlock = trackUrl
    ? emailButton(trackUrl, "Track your shipment")
    : `<p style="margin:20px 0 0;font-size:14px;color:#475569;">Use your carrier’s site with the number below.</p>`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:17px;color:#0f172a;font-weight:600;">Hi ${esc(customerName(order))},</p>
    <p style="margin:0 0 20px;">Your package is on the way. Here are your shipping details.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;width:100%;">
      <tr>
        <td style="padding:22px 20px;background:${light};border-radius:14px;border:2px dashed ${accent};text-align:center;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;">Tracking number</p>
          <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:20px;font-weight:700;color:${accent};letter-spacing:0.04em;word-break:break-all;">${esc(num)}</p>
          ${order.trackingCarrier ? `<p style="margin:10px 0 0;font-size:13px;color:#64748b;">${esc(order.trackingCarrier)}</p>` : ""}
        </td>
      </tr>
    </table>
    ${linkBlock}
    <p style="margin:24px 0 0;font-size:14px;color:#64748b;">You can also see this in <a href="${esc(myAccountUrl())}" style="color:${accent};font-weight:600;text-decoration:none;">your account</a>.</p>
  `;
  await sendMailMessage({
    to: email,
    subject: `Your shipment is on the way — #${ref}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Order #${ref} tracking: ${num}. ${trackUrl || ""} ${myAccountUrl()}`,
  });
}

function myAccountOrdersTabUrl() {
  const base = myAccountUrl();
  return base.includes("?") ? `${base}&tab=orders` : `${base}?tab=orders`;
}

/**
 * Customer email: admin asked them to update design images (no extra payment).
 * Only for orders with a linked {@link Order#customerId} account.
 * @param {import('mongoose').Document | object} order — populated customerId ok
 */
export async function sendDesignFixRequestedCustomerEmail(order) {
  if (!isMailConfigured()) {
    console.warn("[orderEmails] SMTP not configured — design-fix email skipped");
    return;
  }
  const email = getOrderCustomerView(order).email?.trim();
  if (!email) return;
  const ref = getOrderRef(order);
  const id = order._id?.toString?.() || order.id;
  const base = getPublicAppBase();
  const fixPath = id ? `/my-account/orders/${encodeURIComponent(id)}/fix-design` : "/my-account";
  const fixHref = base ? `${base.replace(/\/$/, "")}${fixPath}` : fixPath;
  const preheader = `Action needed: update images for order #${ref}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:17px;color:#0f172a;font-weight:600;">Hi ${esc(customerName(order))},</p>
    <p style="margin:0 0 20px;">We need you to <strong>replace or re-upload images</strong> for your order so we can print it correctly. You will <strong>not be charged again</strong>.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#475569;">Open <strong>My Account → Orders</strong>, find this order, and use the prompts there to upload your files.</p>
    ${emailButton(fixHref, "Update my design")}
    <p style="margin:24px 0 0;font-size:13px;color:#64748b;">Order reference: <strong style="color:#0f172a;">#${esc(ref)}</strong></p>
    ${emailButton(myAccountOrdersTabUrl(), "View all orders")}
  `;
  await sendMailMessage({
    to: email,
    subject: `Action needed — please update images for order #${ref}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `We need updated images for order #${ref}. No extra charge. Update here: ${fixHref} Or open orders: ${myAccountOrdersTabUrl()}`,
  });
}

/**
 * Admin notification: customer saved design changes while the order was in `request_review`.
 * Order stays in request review until staff changes status manually.
 * @param {import('mongoose').Document | object} order — lean/doc with _id, customer, orderCode, status
 */
export async function sendDesignReviewSubmittedAdminEmail(order) {
  if (!isMailConfigured()) {
    console.warn("[orderEmails] SMTP not configured — design-review-submitted admin email skipped");
    return;
  }
  const admins = getAdminNotificationEmails();
  if (admins.length === 0) {
    console.warn("[orderEmails] ADMIN_EMAIL / ADMIN_NOTIFICATION_EMAILS not set — skipping design-review-submitted notification");
    return;
  }
  const ref = getOrderRef(order);
  const id = order._id?.toString?.() || order.id || "";
  const cView = getOrderCustomerView(order);
  const brand = getMailBrandName();
  const accent = getMailAccentColor();
  const adminListUrl = getAdminOrdersUrl();
  const adminOrderUrl =
    adminListUrl && id ? `${adminListUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}` : "";
  const preheader = `Customer updated design for order #${ref}`;
  const openBtn = adminOrderUrl
    ? emailButton(adminOrderUrl, "Open this order in admin")
    : adminListUrl
      ? emailButton(adminListUrl, "Open orders in admin")
      : "";
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Design review</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;">Customer completed review — order <span style="color:${esc(accent)};">#${esc(ref)}</span></p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.55;">They submitted updated images or text. The order remains in <strong>request review</strong> until you verify the design and change the status.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
      <tr><td style="padding:16px 18px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;">
        <strong style="color:#64748b;display:block;margin-bottom:6px;">Customer</strong>
        ${esc(cView.email || "—")}<br/>
        <span style="color:#334155;">${esc([cView.firstName, cView.lastName].filter(Boolean).join(" ") || "—")}</span>
      </td></tr>
    </table>
    ${openBtn}
  `;
  await sendMailMessage({
    to: admins,
    subject: `[${brand}] Customer completed design review — order #${ref}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Customer submitted design updates for order #${ref} (${id}). ${cView.email || ""}. Order remains "request review". ${adminOrderUrl || adminListUrl || ""}`,
  });
}
