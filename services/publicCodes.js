import crypto from "crypto";

const ORDER_LEN = 9;
const CUSTOMER_BODY_LEN = 8;
/** Unambiguous A–Z0–9 (excludes I, O, 0, 1) for 8–10 char codes. */
const ALPHANUM = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * @param {number} length
 * @param {string} [alphabet=ALPHANUM]
 */
export function randomAlnum(length, alphabet = ALPHANUM) {
  const n = Math.max(1, Math.floor(length));
  const buf = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

/**
 * @param {import("mongoose").Model} OrderModel
 */
export async function ensureUniqueOrderCode(OrderModel) {
  for (let a = 0; a < 20; a++) {
    const code = randomAlnum(ORDER_LEN);
    const exists = await OrderModel.exists({ orderCode: code });
    if (!exists) return code;
  }
  throw new Error("Could not allocate a unique order code");
}

/**
 * @param {import("mongoose").Model} CustomerUserModel
 * @param {import("mongoose").Types.ObjectId} [excludeId]
 * @param {"G" | "R"} prefix
 */
export async function ensureUniqueCustomerPublicId(CustomerUserModel, prefix, excludeId) {
  for (let a = 0; a < 20; a++) {
    const body = randomAlnum(CUSTOMER_BODY_LEN);
    const publicId = prefix + body;
    const q = { publicId };
    if (excludeId) q._id = { $ne: excludeId };
    const exists = await CustomerUserModel.exists(q);
    if (!exists) return publicId;
  }
  throw new Error("Could not allocate a unique customer id");
}

/**
 * @param {object} order Mongo doc or lean
 * @returns {string}
 */
export function getOrderRef(order) {
  const c = order?.orderCode;
  if (c != null && String(c).trim() !== "") return String(c).trim().toUpperCase();
  const id = order?._id?.toString?.() ?? order?.id ?? "";
  return id ? id.slice(-8).toUpperCase() : "";
}

/**
 * Stored guest/registered id (`G…` / `R…`), or a stable 9-char placeholder for rows created before `publicId` existed (`X` + last 8 hex of `_id`).
 * @param {{ publicId?: string, _id?: import("mongoose").Types.ObjectId|string, id?: string }} c
 * @returns {string|undefined}
 */
export function resolveCustomerPublicDisplayId(c) {
  if (!c) return undefined;
  const raw = c.publicId != null ? String(c.publicId).trim() : "";
  if (raw) return raw.toUpperCase();
  const id = c._id?.toString?.() ?? c.id;
  if (id && /^[0-9a-fA-F]{24}$/.test(String(id))) return `X${String(id).slice(-8).toUpperCase()}`;
  return undefined;
}
