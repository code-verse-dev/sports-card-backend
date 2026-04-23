/** Nominal print size from cart size option id (e.g. "2.5x3.5", "4x5.5"). Width × height in inches as stored in admin prices. */
export function parseNominalSizeInches(sizeOptionId) {
  const m = String(sizeOptionId || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i);
  if (!m) return { w: 2.5, h: 3.5 };
  return { w: parseFloat(m[1]), h: parseFloat(m[2]) };
}

function hasDesignSnapshot(it) {
  return it?.designSnapshot && typeof it.designSnapshot === "object" && Object.keys(it.designSnapshot).length > 0;
}

/** Admin “download card images” / Puppeteer capture: every line with a non-empty design snapshot. */
export function filterDesignedItemsForCardCapture(items) {
  /** @type {{ item: object }[]} */
  const captureItemRows = [];
  for (const it of items || []) {
    if (!hasDesignSnapshot(it)) continue;
    captureItemRows.push({ item: it });
  }
  return { captureItemRows };
}

/** Admin order-notification email: every custom design at fixed 2.75″×3.75″ canvas (not builder / not admin download). */
export function filterItemsForAdminEmailCardPdf(items) {
  /** @type {{ item: object, nominalInches: { w: number, h: number } }[]} */
  const pdfItemRows = [];
  for (const it of items || []) {
    if (!hasDesignSnapshot(it)) continue;
    pdfItemRows.push({ item: it, nominalInches: { w: 2.75, h: 3.75 } });
  }
  return { pdfItemRows };
}

/**
 * Customer confirmation email: only lines where PDF was purchased, at the size ordered for that line.
 * @returns {{ pdfItemRows: { item: object, nominalInches: { w: number, h: number } }[] }}
 */
export function filterItemsForCustomerEmailCardPdf(items) {
  /** @type {{ item: object, nominalInches: { w: number, h: number } }[]} */
  const pdfItemRows = [];
  for (const it of items || []) {
    if (!hasDesignSnapshot(it)) continue;
    if (Array.isArray(it.lineItems) && it.lineItems.length) {
      for (const line of it.lineItems) {
        if (!line.pdfOption) continue;
        const { w, h } = parseNominalSizeInches(line.sizeOptionId);
        pdfItemRows.push({
          item: {
            ...it,
            sizeOptionId: line.sizeOptionId,
            pdfOption: true,
            lineItems: undefined,
            quantity: line.quantity,
            priceCents: line.priceCents,
          },
          nominalInches: { w, h },
        });
      }
    } else if (it.pdfOption) {
      const { w, h } = parseNominalSizeInches(it.sizeOptionId);
      pdfItemRows.push({
        item: { ...it, lineItems: undefined },
        nominalInches: { w, h },
      });
    }
  }
  return { pdfItemRows };
}
