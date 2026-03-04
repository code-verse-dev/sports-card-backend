import mongoose from "mongoose";

const priceConfigSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "default" },
    quantityTiers: [
      { minQty: Number, pricePerSet: Number },
    ],
    sizeOptions: [
      { id: String, label: String, addPrice: Number },
    ],
    pdfOption: { addPrice: Number },
    baseShipping: Number,
    freeShippingThreshold: Number,
  },
  { timestamps: true }
);

// Single document for site-wide config
const DOC_ID = "default";

export const PriceConfig = mongoose.model("PriceConfig", priceConfigSchema);

export async function getPriceConfig() {
  let doc = await PriceConfig.findById(DOC_ID).lean();
  if (!doc) {
    doc = await PriceConfig.create({
      _id: DOC_ID,
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
    });
  }
  const { _id, __v, ...rest } = doc;
  return rest;
}

export async function setPriceConfig(updates) {
  await PriceConfig.findByIdAndUpdate(
    DOC_ID,
    { $set: updates },
    { upsert: true, new: true }
  );
  return getPriceConfig();
}
