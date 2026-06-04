/**
 * Print bleed dimensions for AI-generated card artwork (matches frontend custom-card-print-spec).
 */
export const PRINT_SPEC_2_5_X_3_5 = {
  sizeOptionId: "2.5x3.5",
  shortName: "2.5 × 3.5 in",
  bleedIn: { w: 2.75, h: 3.75 },
  trimIn: { w: 2.5, h: 3.5 },
  safeIn: { w: 2.25, h: 3.25 },
  dpi: 300,
};

export const PRINT_SPEC_4_X_5_5 = {
  sizeOptionId: "4x5.5",
  shortName: "4 × 5.5 in (A2)",
  bleedIn: { w: 4.2, h: 5.725 },
  trimIn: { w: 3.95, h: 5.5 },
  safeIn: { w: 3.7, h: 5.25 },
  dpi: 300,
};

/** Inset % from bleed edges for centered safe zone (matches frontend print spec). */
export function safeZoneInsetPercents(spec) {
  const B = spec.bleedIn;
  const S = spec.safeIn;
  return {
    horizontal: Math.round(((B.w - S.w) / 2 / B.w) * 100),
    vertical: Math.round(((B.h - S.h) / 2 / B.h) * 100),
  };
}

export function bleedTrimSafePromptLine(spec) {
  const insets = safeZoneInsetPercents(spec);
  return (
    `Print canvas is full BLEED ${spec.bleedIn.w}"×${spec.bleedIn.h}" (background/color to all edges). ` +
    `Trim ${spec.trimIn.w}"×${spec.trimIn.h}". Keep all readable typography inside SAFE ${spec.safeIn.w}"×${spec.safeIn.h}" ` +
    `(~${insets.horizontal}% inset left/right, ~${insets.vertical}% inset top/bottom from bleed).`
  );
}

const ALL_SPECS = [PRINT_SPEC_2_5_X_3_5, PRINT_SPEC_4_X_5_5];

export function getPrintSpecForSizeOptionId(sizeOptionId) {
  const id = String(sizeOptionId ?? "").trim();
  if (!id) return PRINT_SPEC_2_5_X_3_5;
  const exact = ALL_SPECS.find((s) => s.sizeOptionId === id);
  if (exact) return exact;
  const lower = id.toLowerCase();
  if (lower.includes("4") && (lower.includes("5.5") || lower.includes("5_5") || lower.includes("a2"))) {
    return PRINT_SPEC_4_X_5_5;
  }
  return PRINT_SPEC_2_5_X_3_5;
}

export function bleedPixelDimensions(spec) {
  return {
    w: Math.ceil(spec.bleedIn.w * spec.dpi),
    h: Math.ceil(spec.bleedIn.h * spec.dpi),
  };
}
