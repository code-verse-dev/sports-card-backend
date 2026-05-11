/**
 * Shared checks for design snapshots on checkout and post-order customer fixes.
 * Keeps behavior aligned between Stripe checkout validation and /api/user design-fix PATCH.
 */

export const INLINE_IMAGE_REF_PLACEHOLDER_PREFIX = "__inline_image_ref__:";

export function isInlineImageDataUrlString(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.startsWith("data:image/") && t.includes(";base64,");
}

export function isInlineImageRefPlaceholderString(s) {
  return typeof s === "string" && s.trim().startsWith(INLINE_IMAGE_REF_PLACEHOLDER_PREFIX);
}

export function valueHasInlineImageDataUrl(value) {
  if (isInlineImageDataUrlString(value)) return true;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return value.some((v) => valueHasInlineImageDataUrl(v));
    return Object.values(value).some((v) => valueHasInlineImageDataUrl(v));
  }
  return false;
}

export function valueHasInlineImageRefPlaceholder(value) {
  if (isInlineImageRefPlaceholderString(value)) return true;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return value.some((v) => valueHasInlineImageRefPlaceholder(v));
    return Object.values(value).some((v) => valueHasInlineImageRefPlaceholder(v));
  }
  return false;
}

export function hasInlineImageDataUrlInItems(items) {
  if (!Array.isArray(items)) return false;
  for (const item of items) {
    if (valueHasInlineImageDataUrl(item?.designSnapshot)) return true;
  }
  return false;
}

export function hasInlineImageRefPlaceholderInItems(items) {
  if (!Array.isArray(items)) return false;
  for (const item of items) {
    if (valueHasInlineImageRefPlaceholder(item?.designSnapshot)) return true;
  }
  return false;
}
