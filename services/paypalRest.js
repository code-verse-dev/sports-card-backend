/**
 * PayPal REST v2 (Orders) — server-side create + capture.
 * Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox|production|live|prod (default sandbox)
 */
import { httpFetch } from "./httpFetch.js";

const TOKEN_BUFFER_MS = 60_000;
let cachedToken = { accessToken: "", expiresAt: 0 };

/** Trim, strip wrapping quotes, remove BOM — common .env paste issues cause "Client Authentication failed". */
function normalizePayPalCredential(value) {
  if (value == null) return "";
  let s = String(value).replace(/\r\n/g, "\n").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^\uFEFF/, "").trim();
  return s;
}

/** @returns {"sandbox"|"production"} */
export function getPayPalApiEnvironment() {
  const raw = String(process.env.PAYPAL_ENV || "sandbox")
    .toLowerCase()
    .trim();
  if (["production", "live", "prod"].includes(raw)) return "production";
  return "sandbox";
}

function apiHost() {
  return getPayPalApiEnvironment() === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function basicAuthHeader() {
  const id = normalizePayPalCredential(process.env.PAYPAL_CLIENT_ID);
  const sec = normalizePayPalCredential(process.env.PAYPAL_CLIENT_SECRET);
  if (!id || !sec) return null;
  const b64 = Buffer.from(`${id}:${sec}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

export function isPayPalConfigured() {
  return Boolean(basicAuthHeader());
}

function invalidatePayPalTokenCache() {
  cachedToken = { accessToken: "", expiresAt: 0 };
}

function authFailureHint(json, status) {
  const err = String(json?.error || "");
  const desc = String(json?.error_description || json?.message || "");
  const combined = `${err} ${desc}`.toLowerCase();
  const isAuthFail =
    status === 401 ||
    err === "invalid_client" ||
    combined.includes("client authentication") ||
    combined.includes("authentication failed");
  if (!isAuthFail) return "";
  const env = getPayPalApiEnvironment();
  return ` Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (same app, no extra spaces). Set PAYPAL_ENV=sandbox for Sandbox credentials or PAYPAL_ENV=production for Live credentials (${env} API is in use). The JS SDK host must match: sandbox uses www.sandbox.paypal.com.`;
}

async function getAccessToken() {
  const auth = basicAuthHeader();
  if (!auth) throw new Error("PayPal is not configured (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)");
  const now = Date.now();
  if (cachedToken.accessToken && cachedToken.expiresAt > now + TOKEN_BUFFER_MS) {
    return cachedToken.accessToken;
  }
  const res = await httpFetch(`${apiHost()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    invalidatePayPalTokenCache();
    const base = json.error_description || json.error || `PayPal token ${res.status}`;
    throw new Error(String(base) + authFailureHint(json, res.status));
  }
  const accessToken = json.access_token;
  const expiresIn = Number(json.expires_in) || 300;
  cachedToken = {
    accessToken,
    expiresAt: now + expiresIn * 1000,
  };
  return accessToken;
}

/**
 * @param {string} valueUsd e.g. "12.34"
 * @param {string} customId Mongo order id (stored as reference_id)
 */
export async function paypalCreateOrder({ valueUsd, customId }) {
  const token = await getAccessToken();
  const res = await httpFetch(`${apiHost()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: String(customId).slice(0, 256),
          amount: {
            currency_code: "USD",
            value: valueUsd,
          },
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.name || JSON.stringify(data);
    throw new Error(`PayPal create order failed: ${msg}`);
  }
  return { id: data.id, raw: data };
}

/**
 * @param {string} paypalOrderId PayPal order id from create
 */
export async function paypalCaptureOrder(paypalOrderId) {
  const token = await getAccessToken();
  const res = await httpFetch(`${apiHost()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.name || JSON.stringify(data);
    throw new Error(`PayPal capture failed: ${msg}`);
  }
  return data;
}

/** Cancel an unapproved / payer-action PayPal order so the buyer can start again. */
export async function paypalCancelOrder(paypalOrderId) {
  const id = String(paypalOrderId || "").trim();
  if (!id) return { ok: false };
  const token = await getAccessToken();
  const res = await httpFetch(`${apiHost()}/v2/checkout/orders/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (res.status === 204) return { ok: true };
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true };
  const msg = data.message || data.name || JSON.stringify(data);
  return { ok: false, message: msg };
}

/** Extract capture id and reference_id from capture response */
export function paypalParseCapture(captureJson) {
  const pu = captureJson?.purchase_units?.[0];
  const ref = pu?.reference_id;
  const cap = pu?.payments?.captures?.[0];
  return {
    referenceId: ref,
    captureId: cap?.id,
    status: cap?.status,
    amountValue: cap?.amount?.value,
  };
}
