import { CustomerUser, hashCustomerPassword } from "../models/CustomerUser.js";

/** Map checkout / API body to a normalized profile (email lowercased). */
export function profileFromBody(c) {
  if (!c) return null;
  const email = String(c.email || "").trim().toLowerCase();
  if (!email) return null;
  return {
    email,
    firstName: String(c.firstName || "").trim() || undefined,
    lastName: String(c.lastName || "").trim() || undefined,
    phone: c.phone != null && String(c.phone).trim() ? String(c.phone).trim() : undefined,
    address: c.address != null && String(c.address).trim() ? String(c.address).trim() : undefined,
    addressLine2: c.addressLine2 != null && String(c.addressLine2).trim() ? String(c.addressLine2).trim() : undefined,
    city: c.city != null && String(c.city).trim() ? String(c.city).trim() : undefined,
    state: c.state != null && String(c.state).trim() ? String(c.state).trim() : undefined,
    zip: c.zip != null && String(c.zip).trim() ? String(c.zip).trim() : undefined,
    country: c.country != null && String(c.country).trim() ? String(c.country).trim() : undefined,
  };
}

/**
 * Create or update CustomerUser (guest allowed: no password).
 * Merges profile fields. Returns the document.
 */
/**
 * Guest checkout: if the draft order was tied to `previousCustomerId` and that user is still
 * an unregistered guest, update that user's email in place instead of creating a second CustomerUser.
 * Falls back to upsertCustomerFromCheckout when the guest is registered or the new email is taken.
 */
export async function migrateGuestCustomerEmailOnCheckoutPatch({ previousCustomerId, customer }) {
  const p = profileFromBody(customer);
  if (!p || !previousCustomerId) return upsertCustomerFromCheckout(customer);
  const prevUser = await CustomerUser.findById(previousCustomerId);
  if (!prevUser || prevUser.isRegistered) {
    return upsertCustomerFromCheckout(customer);
  }
  const newEmail = p.email;
  if (!newEmail) return upsertCustomerFromCheckout(customer);
  if (String(prevUser.email).toLowerCase() === newEmail) {
    if (p.firstName !== undefined) prevUser.firstName = p.firstName;
    if (p.lastName !== undefined) prevUser.lastName = p.lastName;
    if (p.phone !== undefined) prevUser.phone = p.phone;
    if (p.address !== undefined) prevUser.address = p.address;
    if (p.addressLine2 !== undefined) prevUser.addressLine2 = p.addressLine2;
    if (p.city !== undefined) prevUser.city = p.city;
    if (p.state !== undefined) prevUser.state = p.state;
    if (p.zip !== undefined) prevUser.zip = p.zip;
    if (p.country !== undefined) prevUser.country = p.country;
    await prevUser.save();
    return prevUser;
  }
  const conflict = await CustomerUser.findOne({ email: newEmail, _id: { $ne: prevUser._id } }).select("_id").lean();
  if (conflict) {
    return upsertCustomerFromCheckout(customer);
  }
  prevUser.email = newEmail;
  if (p.firstName !== undefined) prevUser.firstName = p.firstName;
  if (p.lastName !== undefined) prevUser.lastName = p.lastName;
  if (p.phone !== undefined) prevUser.phone = p.phone;
  if (p.address !== undefined) prevUser.address = p.address;
  if (p.addressLine2 !== undefined) prevUser.addressLine2 = p.addressLine2;
  if (p.city !== undefined) prevUser.city = p.city;
  if (p.state !== undefined) prevUser.state = p.state;
  if (p.zip !== undefined) prevUser.zip = p.zip;
  if (p.country !== undefined) prevUser.country = p.country;
  await prevUser.save();
  return prevUser;
}

export async function upsertCustomerFromCheckout(customer) {
  const p = profileFromBody(customer);
  if (!p) return null;
  const existing = await CustomerUser.findOne({ email: p.email });
  if (existing) {
    if (p.firstName !== undefined) existing.firstName = p.firstName;
    if (p.lastName !== undefined) existing.lastName = p.lastName;
    if (p.phone !== undefined) existing.phone = p.phone;
    if (p.address !== undefined) existing.address = p.address;
    if (p.addressLine2 !== undefined) existing.addressLine2 = p.addressLine2;
    if (p.city !== undefined) existing.city = p.city;
    if (p.state !== undefined) existing.state = p.state;
    if (p.zip !== undefined) existing.zip = p.zip;
    if (p.country !== undefined) existing.country = p.country;
    await existing.save();
    return existing;
  }
  return CustomerUser.create({
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    address: p.address,
    addressLine2: p.addressLine2,
    city: p.city,
    state: p.state,
    zip: p.zip,
    country: p.country,
    isRegistered: false,
  });
}

/** @param {import('mongoose').Document} user */
export async function saveProfileFromCheckoutBody(user, customer) {
  if (!user || !customer) return;
  const p = profileFromBody(customer);
  if (!p) return;
  if (p.firstName !== undefined) user.firstName = p.firstName;
  if (p.lastName !== undefined) user.lastName = p.lastName;
  if (p.phone !== undefined) user.phone = p.phone;
  if (p.address !== undefined) user.address = p.address;
  if (p.addressLine2 !== undefined) user.addressLine2 = p.addressLine2;
  if (p.city !== undefined) user.city = p.city;
  if (p.state !== undefined) user.state = p.state;
  if (p.zip !== undefined) user.zip = p.zip;
  if (p.country !== undefined) user.country = p.country;
  await user.save();
}

export async function setCustomerPasswordById(id, plainPassword) {
  const p = String(plainPassword || "").trim();
  if (p.length < 6) throw new Error("Password must be at least 6 characters");
  const u = await CustomerUser.findById(id).select("+passwordHash");
  if (!u) throw new Error("Customer not found");
  u.passwordHash = await hashCustomerPassword(p);
  u.isRegistered = true;
  await u.save();
  return u;
}
