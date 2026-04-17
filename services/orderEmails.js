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
  const total = (order.totalCents ?? 0) + ship;
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 8px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  ${rows.join("")}
  <tr style="background:#f8fafc;">
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748b;">Shipping</td>
    <td style="padding:12px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${formatMoney(ship)}</td>
  </tr>
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
  const c = order.customer || {};
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
 */
export async function sendOrderPlacedCustomerEmail(order) {
  const email = order.customer?.email?.trim();
  if (!email) return;
  const id = order._id?.toString?.() ?? order.id ?? "";
  const accent = getMailAccentColor();
  const preheader = `Your order #${id.slice(-8)} is confirmed — thank you for choosing ${getMailBrandName()}.`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:17px;color:#0f172a;font-weight:600;">Hi ${esc(customerName(order))},</p>
    <p style="margin:0 0 20px;">Thank you for your order. We’ve received your payment and your custom cards are in our queue.</p>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Order reference</p>
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:${accent};letter-spacing:-0.02em;">#${esc(id.slice(-8))}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#64748b;">Keep this number for your records.</p>
    ${orderSummaryBlock(order)}
    <p style="margin:8px 0 0;">Track progress and details anytime in your account.</p>
    ${emailButton(myAccountUrl(), "View my orders")}
  `;
  await sendMailMessage({
    to: email,
    subject: `Order received — #${id.slice(-8)}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Hi ${customerName(order)}, we received your order #${id.slice(-8)}. Total ${formatMoney((order.totalCents ?? 0) + (order.shippingCents ?? 0))}. My orders: ${myAccountUrl()}`,
  });
}

/**
 * @param {import('mongoose').Document | object} order
 */
export async function sendOrderPlacedAdminEmail(order) {
  const admins = getAdminNotificationEmails();
  if (admins.length === 0) {
    console.warn("[orderEmails] ADMIN_EMAIL / ADMIN_NOTIFICATION_EMAILS not set — skipping admin notification");
    return;
  }
  const id = order._id?.toString?.() ?? order.id ?? "";
  const brand = getMailBrandName();
  let pdfBuffer;
  try {
    pdfBuffer = await buildOrderPrintPdfBuffer(order);
  } catch (e) {
    console.error("[orderEmails] PDF build failed:", e.message);
    pdfBuffer = null;
  }
  const adminUrl = getAdminOrdersUrl();
  const preheader = `New paid order #${id.slice(-8)} — ${order.customer?.email || ""}`;
  const adminCta = adminUrl
    ? `<p style="margin:16px 0 0;">${emailButton(adminUrl, "Open orders in admin")}</p>`
    : "";
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">Fulfillment</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;">New paid order <span style="color:${getMailAccentColor()};">#${esc(id.slice(-8))}</span></p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
      <tr><td style="padding:16px 18px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;">
        <strong style="color:#64748b;display:block;margin-bottom:6px;">Customer</strong>
        ${esc(order.customer?.email)}<br/>
        <span style="color:#334155;">${esc([order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" "))}</span>
      </td></tr>
    </table>
    ${orderSummaryBlock(order)}
    <p style="margin:16px 0 0;font-size:14px;color:#475569;">A <strong>print PDF</strong> is attached when design images are present in the order snapshot.</p>
    ${adminCta}
  `;
  const attachments = pdfBuffer
    ? [{ filename: `order-${id.slice(-8)}-print.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
    : [];
  await sendMailMessage({
    to: admins,
    subject: `[${brand}] New order #${id.slice(-8)} — print pack attached`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `New order ${id}. Customer ${order.customer?.email}. Admin: ${adminUrl || "(set PUBLIC_APP_URL)"}`,
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
  try {
    await sendOrderPlacedCustomerEmail(order);
  } catch (e) {
    console.error("[orderEmails] Customer order email failed:", e.message);
  }
  try {
    await sendOrderPlacedAdminEmail(order);
  } catch (e) {
    console.error("[orderEmails] Admin order email failed:", e.message);
  }
}

const STATUS_LABELS = {
  pending: "Pending",
  pending_payment: "Awaiting payment",
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
  const email = order.customer?.email?.trim();
  if (!email) return;
  const id = order._id?.toString?.() ?? order.id ?? "";
  const prev = STATUS_LABELS[previousStatus] || previousStatus;
  const cur = STATUS_LABELS[order.status] || order.status;
  const preheader = `Order #${id.slice(-8)}: ${prev} → ${cur}`;
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
          <p style="margin:0;font-size:13px;color:#64748b;">Order <strong style="color:#0f172a;">#${esc(id.slice(-8))}</strong></p>
        </td>
      </tr>
    </table>
    ${emailButton(myAccountUrl(), "View order details")}
  `;
  await sendMailMessage({
    to: email,
    subject: `Order update — #${id.slice(-8)} (${cur})`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Order #${id.slice(-8)} status: ${prev} -> ${cur}. ${myAccountUrl()}`,
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
  const email = order.customer?.email?.trim();
  if (!email) return;
  const num = order.trackingNumber?.trim();
  if (!num) return;
  const id = order._id?.toString?.() ?? order.id ?? "";
  const trackUrl = resolveTrackingUrl(order);
  const accent = getMailAccentColor();
  const light = getMailAccentLight();
  const preheader = `Tracking for order #${id.slice(-8)}: ${num}`;
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
    subject: `Your shipment is on the way — #${id.slice(-8)}`,
    html: wrapEmailHtml({ preheader, bodyHtml }),
    text: `Order #${id.slice(-8)} tracking: ${num}. ${trackUrl || ""} ${myAccountUrl()}`,
  });
}
