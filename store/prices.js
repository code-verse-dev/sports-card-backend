/** Default price config. Admin can override via PUT /api/admin/prices */
const defaultPrices = {
  quantityTiers: [
    { minQty: 15, pricePerSet: 19 },
    { minQty: 25, pricePerSet: 25 },
    { minQty: 35, pricePerSet: 33 },
    { minQty: 50, pricePerSet: 40 },
    { minQty: 100, pricePerSet: 45 },
    { minQty: 150, pricePerSet: 50 },
    { minQty: 200, pricePerSet: 55 },
    { minQty: 250, pricePerSet: 60 },
    { minQty: 500, pricePerSet: 65 },
    { minQty: 1000, pricePerSet: 80 },
  ],
  sizeOptions: [
    { id: "2.5x3.5", label: "2.5 x 3.5 in", addPrice: 0 },
    { id: "4x5.5", label: "4 x 5.5 in", addPrice: 2 },
  ],
  pdfOption: { addPrice: 10 },
  baseShipping: 8,
  freeShippingThreshold: 75,
};

let prices = { ...defaultPrices };

export function getPrices() {
  return { ...prices };
}

export function setPrices(newPrices) {
  prices = { ...defaultPrices, ...newPrices };
  return getPrices();
}

/** Calculate price for given quantity (uses first matching tier). */
export function calcPriceForQuantity(qty) {
  const tiers = [...(prices.quantityTiers || [])].sort((a, b) => b.minQty - a.minQty);
  for (const t of tiers) {
    if (qty >= t.minQty) return t.pricePerSet;
  }
  return 0;
}
