import { resolveCustomerPublicDisplayId } from "./publicCodes.js";

/**
 * Resolve customer name/email/address for emails and responses:
 * use populated customerId (CustomerUser) if present, else legacy embedded `customer`.
 * @param {object} order
 */
export function getOrderCustomerView(order) {
  if (!order) return {};
  const ref = order.customerId;
  if (ref && typeof ref === "object" && ref.email) {
    return {
      email: ref.email,
      firstName: ref.firstName,
      lastName: ref.lastName,
      phone: ref.phone,
      company: ref.company,
      address: ref.address,
      addressLine2: ref.addressLine2,
      city: ref.city,
      state: ref.state,
      zip: ref.zip,
      country: ref.country,
      publicId: resolveCustomerPublicDisplayId(ref),
    };
  }
  return order.customer && typeof order.customer === "object" ? { ...order.customer } : {};
}
