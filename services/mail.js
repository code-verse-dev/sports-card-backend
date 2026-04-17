import nodemailer from "nodemailer";

let cachedTransport = null;

/** @returns {boolean} */
export function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function getMailFrom() {
  return (process.env.MAIL_FROM || process.env.SMTP_USER || "").trim() || "noreply@localhost";
}

/** Base URL for fetching uploads when generating admin PDFs (usually same origin as this API). */
export function getPublicApiBase() {
  const u = (process.env.API_PUBLIC_URL || process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  return u || "";
}

/** Customer-facing site origin for links in emails. Prefer PUBLIC_APP_URL / FRONTEND_URL / SITE_URL; API_PUBLIC_URL last for same-origin dev. */
export function getPublicAppBase() {
  const u = (
    process.env.PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.SITE_URL ||
    process.env.API_PUBLIC_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  return u || "";
}

/** Home page (storefront). */
export function getHomePageUrl() {
  const b = getPublicAppBase();
  return b ? `${b}/` : "";
}

/** Display name in email headers. */
export function getMailBrandName() {
  return (process.env.MAIL_BRAND_NAME || process.env.SITE_NAME || "Custom Sports Cards").trim();
}

/** Optional short line under the logo (e.g. tagline). */
export function getMailBrandTagline() {
  return (process.env.MAIL_BRAND_TAGLINE || "").trim();
}

/** Full HTTPS URL to a wide logo (e.g. PNG/SVG hosted on your live site). Shown in email header when set. */
export function getMailLogoUrl() {
  return (process.env.MAIL_LOGO_URL || process.env.SITE_LOGO_URL || "").trim();
}

/** Reply-to / support address shown in footer. */
export function getSupportEmail() {
  return (process.env.SUPPORT_EMAIL || process.env.SMTP_USER || "").trim();
}

/** Primary brand color for buttons and accents (hex). */
export function getMailAccentColor() {
  return (process.env.MAIL_ACCENT_COLOR || "#043264").trim();
}

/** Light tint for bands and badges (hex). */
export function getMailAccentLight() {
  return (process.env.MAIL_ACCENT_LIGHT || "#e8f0fa").trim();
}

/** Optional extra footer line (plain text; keep short). */
export function getMailFooterNote() {
  return (process.env.MAIL_FOOTER_NOTE || "").trim();
}

/**
 * Admin orders URL for fulfillment emails (defaults to {PUBLIC_APP_URL}/admin/orders).
 */
export function getAdminOrdersUrl() {
  const base = getPublicAppBase();
  const path = (process.env.ADMIN_ORDERS_PATH || "/admin/orders").trim();
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : "";
}

/**
 * @returns {import('nodemailer').Transporter}
 */
export function getTransport() {
  if (cachedTransport) return cachedTransport;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("Mail not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }
  const isMicrosoftSmtp = /office365|outlook\.com|microsoft\.com/i.test(String(host));
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    ...(isMicrosoftSmtp && !secure
      ? {
          requireTLS: true,
          tls: { minVersion: "TLSv1.2" },
        }
      : {}),
  });
  return cachedTransport;
}

/**
 * @param {{ to: string | string[], subject: string, html?: string, text?: string, attachments?: import('nodemailer').SendMailOptions['attachments'] }} opts
 */
export async function sendMailMessage(opts) {
  if (!isMailConfigured()) {
    console.warn("[mail] Skipping send: SMTP not configured");
    return { skipped: true };
  }
  const transporter = getTransport();
  const from = getMailFrom();
  const replyTo = (process.env.SUPPORT_EMAIL || process.env.MAIL_REPLY_TO || "").trim();
  const result = await transporter.sendMail({
    from,
    ...(replyTo ? { replyTo } : {}),
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: opts.attachments,
  });
  return { messageId: result.messageId };
}

/** Comma-separated ADMIN_EMAIL or ADMIN_NOTIFICATION_EMAILS */
export function getAdminNotificationEmails() {
  const raw = process.env.ADMIN_EMAIL || process.env.ADMIN_NOTIFICATION_EMAILS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
