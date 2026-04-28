/** Merchandise subtotal from cart rows (matches sum of item.priceCents). */
export function sumItemsMerchandiseCents(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, i) => sum + (Number(i?.priceCents) || 0), 0);
}

/** Total card quantity across lines (team “4+ sets” rule). */
export function totalSetQuantity(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, i) => sum + (Number(i?.quantity) || 0), 0);
}

const TEAM_MIN_SETS = 4;
const TEAM_PCT = 20;
const FALL_PCT = 10;

/**
 * Automatic discounts (mutually exclusive): 20% when ordering 4+ sets; otherwise 10%.
 * Discount applies to merchandise only (not shipping).
 */
export function computeAutoDiscountCents(items) {
  const sub = sumItemsMerchandiseCents(items);
  if (sub <= 0) return 0;
  const sets = totalSetQuantity(items);
  if (sets >= TEAM_MIN_SETS) {
    return Math.round((sub * TEAM_PCT) / 100);
  }
  return Math.round((sub * FALL_PCT) / 100);
}

/** Card / PayPal / PI total: discounted merchandise + shipping + tax. */
export function cardChargeAmountCents(items, shippingCents, taxCents) {
  const sub = sumItemsMerchandiseCents(items);
  const disc = computeAutoDiscountCents(items);
  const ship = Number(shippingCents) || 0;
  const tax = Number(taxCents) || 0;
  return sub - disc + ship + tax;
}

/** Stripe Checkout hosted session (no tax line): merchandise − discount + shipping. */
export function hostedCheckoutAmountCents(items, shippingCents) {
  const sub = sumItemsMerchandiseCents(items);
  const disc = computeAutoDiscountCents(items);
  return sub - disc + (Number(shippingCents) || 0);
}

/**
 * Allocate discount across lines so Stripe line_items stay positive integers (hosted checkout).
 * Proportional rounding on all but the last line; last line absorbs remainder so sums match exactly.
 */
export function allocateDiscountAcrossItems(items, discountCents) {
  const base = (items || []).map((i) => ({
    ...i,
    priceCents: Number(i?.priceCents) || 0,
  }));
  const sub = base.reduce((s, i) => s + i.priceCents, 0);
  const disc = Math.max(0, Math.min(discountCents, sub));
  if (disc <= 0 || sub <= 0) return base;
  let allocated = 0;
  return base.map((i, idx) => {
    const raw = i.priceCents;
    const isLast = idx === base.length - 1;
    const take = isLast ? Math.min(raw, Math.max(0, disc - allocated)) : Math.min(raw, Math.round((disc * raw) / sub));
    if (!isLast) allocated += take;
    return { ...i, priceCents: Math.max(0, raw - take) };
  });
}
