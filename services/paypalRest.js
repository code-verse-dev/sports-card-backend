/**
 * PayPal REST v2 (Orders) — server-side create + capture. No extra npm deps.
 * Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox|production (default sandbox)
 */

const TOKEN_BUFFER_MS = 60_000;
let cachedToken = { accessToken: "", expiresAt: 0 };

function apiHost() {
  const env = String(process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  return env === "production" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function basicAuthHeader() {
  const id = String(process.env.PAYPAL_CLIENT_ID || "").trim();
  const sec = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();
  if (!id || !sec) return null;
  const b64 = Buffer.from(`${id}:${sec}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

export function isPayPalConfigured() {
  return Boolean(basicAuthHeader());
}

async function getAccessToken() {
  const auth = basicAuthHeader();
  if (!auth) throw new Error("PayPal is not configured (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)");
  const now = Date.now();
  if (cachedToken.accessToken && cachedToken.expiresAt > now + TOKEN_BUFFER_MS) {
    return cachedToken.accessToken;
  }
  const res = await fetch(`${apiHost()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `PayPal token ${res.status}`);
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
  const res = await fetch(`${apiHost()}/v2/checkout/orders`, {
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
  const res = await fetch(`${apiHost()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
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
