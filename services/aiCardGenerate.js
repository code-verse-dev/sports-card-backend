import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { Blob } from "node:buffer";
import fetch from "node-fetch";
import sharp from "sharp";
import { getUploadFilePath } from "../uploads-db.js";
import { Template } from "../models/Template.js";
import { dbConnected } from "../db.js";
import {
  bleedTrimSafePromptLine,
  canvasPixelPromptLine,
  getPrintSpecForSizeOptionId,
} from "./aiCardPrintSpec.js";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

/** Portrait sizes used by OpenAI image API and our print canvas. */
const OPENAI_PORTRAIT = { w: 1024, h: 1536 };

const NO_LOGO_RULE =
  "No invented logos, crests, shields, or sponsor marks — team names as plain text only.";

const BANNED_UNLESS_REQUESTED =
  "Do not use neon, cyberpunk, glitch, circuit patterns, pink/cyan glow, or sci-fi HUD unless the customer explicitly asked.";

const LAYOUT_RULES =
  "Full-bleed portrait card art to all four edges. Sharp, crisp typography and frame lines — no blur, no soft focus. " +
  "Photo slot: one flat magenta (#FF00FF) rectangle only — no people, no gradient inside magenta. " +
  "Around magenta: opaque frame border and vignette (painted, not transparent). " +
  "Smooth gradient from photo zone into lower text panel. Front and back must match.";

/** Photo cutout % — must match sports-card-frontend build-ai-creator-template.ts */
const FRONT_PHOTO_CUTOUT = { leftPct: 10, topPct: 9, widthPct: 80, heightPct: 44 };
const BACK_PHOTO_CUTOUT = { leftPct: 10, topPct: 9, widthPct: 80, heightPct: 28 };
const FRAME_MATTE_RGB = { r: 15, g: 23, b: 42 };

function clip(s, max = 500) {
  return String(s ?? "").trim().slice(0, max);
}

function customerInstructionsLine(details, side) {
  const notes = clip(details?.customerNotes, 1200);
  if (!notes) return "";
  const sideHint = side === "back" ? "back" : "front";
  return (
    `CUSTOMER BRIEF (highest priority — apply every detail to this ${sideHint} side): "${notes}". ` +
    "Render all names, stats, team info, colors, and text from this brief clearly on the card. " +
    "Do not ignore or omit any part of the customer brief."
  );
}

function oppositeSideTypography(side, details) {
  const otherNotes =
    side === "back" ? clip(details?.frontNotes, 600) : clip(details?.backNotes, 600);
  if (otherNotes) {
    const other = side === "back" ? "front" : "back";
    return (
      `Keep typography and palette consistent with the paired ${other} side. ` +
      `Other side brief (for matching only): "${otherNotes.slice(0, 300)}".`
    );
  }
  return "";
}

function cutoutPromptLine(side, details) {
  const fromRequest = details?.photoCutout?.[side];
  const c =
    fromRequest &&
    Number.isFinite(fromRequest.leftPct) &&
    Number.isFinite(fromRequest.topPct) &&
    Number.isFinite(fromRequest.widthPct) &&
    Number.isFinite(fromRequest.heightPct)
      ? fromRequest
      : side === "back"
        ? BACK_PHOTO_CUTOUT
        : FRONT_PHOTO_CUTOUT;
  return (
    `Magenta photo slot EXACTLY: left ${c.leftPct}%, top ${c.topPct}%, width ${c.widthPct}%, height ${c.heightPct}%. ` +
    "Everything outside that rectangle is opaque illustrated frame — no holes, no white margins."
  );
}

function buildPrompt(side, details, sizeOptionId, hasReferenceImage = false) {
  const category = clip(details?.templateReference?.category, 120) || "Sports";
  const spec = getPrintSpecForSizeOptionId(sizeOptionId);
  const printGuides = bleedTrimSafePromptLine(spec);
  const canvasLine = canvasPixelPromptLine(spec);
  const normalizedSide = side === "back" ? "back" : "front";
  const ref = details?.templateReference;
  const templateName = clip(ref?.name, 80);
  const templateLine = hasReferenceImage
    ? `Use the attached "${templateName || "selected"}" ${normalizedSide} template as the layout base. Apply the CUSTOMER BRIEF — replace placeholder text with the customer's exact words. Do not leave text areas empty.`
    : templateName
      ? `Match the layout and visual style of the "${templateName}" template.`
      : "";

  const customerBrief = customerInstructionsLine(details, normalizedSide);

  return [
    `${normalizedSide.toUpperCase()} trading card frame PNG for print — full opaque illustrated artwork, no blank areas.`,
    customerBrief,
    canvasLine,
    printGuides,
    templateLine,
    `Category: ${category}.`,
    oppositeSideTypography(normalizedSide, details),
    NO_LOGO_RULE,
    BANNED_UNLESS_REQUESTED,
    LAYOUT_RULES,
    cutoutPromptLine(normalizedSide, details),
    normalizedSide === "back"
      ? "Below 38% from top: opaque back text panel with customer brief text — never leave empty."
      : "Below 54% from top: opaque front name/stats panel with customer brief text — never leave empty.",
  ]
    .filter(Boolean)
    .join(" ");
}

function isMongoId(s) {
  return /^[a-f\d]{24}$/i.test(String(s || ""));
}

function normalizeImageRef(ref) {
  const s = String(ref || "").trim();
  if (!s || s.startsWith("data:")) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const base = s.split("?")[0].trim();
  const last = base.split("/").pop() || base;
  return last.replace(/\.(png|jpe?g|webp|gif|bmp|avif|svg|tiff?)$/i, "");
}

function uploadFetchBaseUrls() {
  const bases = [
    String(process.env.API_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
    String(process.env.UPLOADS_FALLBACK_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    "https://api.customsportscards.com",
  ];
  return [...new Set(bases.filter(Boolean))];
}

async function cacheUploadBuffer(uploadId, buffer, ext = ".png") {
  if (!uploadId || !buffer?.length) return;
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOADS_DIR, `${uploadId}${ext}`), buffer);
  } catch {
    // Best-effort cache; generation can continue without it.
  }
}

async function fetchUploadBufferRemote(uploadId) {
  const id = normalizeImageRef(uploadId);
  if (!id) return null;
  const httpFetch = globalThis.fetch ?? fetch;
  for (const base of uploadFetchBaseUrls()) {
    try {
      const res = await httpFetch(`${base}/api/uploads/${encodeURIComponent(id)}`);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 512) continue;
      const ext = guessImageExtFromBuffer(buffer);
      await cacheUploadBuffer(id, buffer, ext);
      return buffer;
    } catch {
      // Try next origin.
    }
  }
  return null;
}

function guessImageExtFromBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return ".png";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return ".webp";
  return ".png";
}

async function loadImageBufferFromRef(ref) {
  const s = String(ref || "").trim();
  if (!s || s.startsWith("data:")) return null;
  if (/^https?:\/\//i.test(s)) {
    const httpFetch = globalThis.fetch ?? fetch;
    const res = await httpFetch(s);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  const id = normalizeImageRef(s);
  if (!id) return null;
  const filePath = await getUploadFilePath(id);
  if (filePath) {
    try {
      return await fs.readFile(filePath);
    } catch {
      // Fall through to remote fetch.
    }
  }
  return fetchUploadBufferRemote(id);
}

async function loadTemplateDoc(templateId) {
  const param = String(templateId || "").trim();
  if (!param || !dbConnected()) return null;
  try {
    return Template.findOne({
      $or: [
        { id: param },
        { templateId: param },
        { legacyIds: param },
        ...(isMongoId(param) ? [{ _id: param }] : []),
      ],
    }).lean();
  } catch {
    return null;
  }
}

function imageRefFromTemplateDoc(doc, side) {
  const t = doc?.template;
  if (!t || typeof t !== "object") return "";
  if (side === "back") {
    return normalizeImageRef(t.back?.backgroundImage || doc.back);
  }
  return normalizeImageRef(t.front?.backgroundImage || doc.front);
}

function imageFieldsFromTemplateDoc(doc, side) {
  const t = doc?.template;
  if (!t || typeof t !== "object") return [];
  const fields = side === "back" ? t.back?.fields : t.front?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((f) => f?.type === "image");
}

function cutoutFromTemplateField(field) {
  if (!field?.position) return null;
  const { left, top, width, height } = field.position;
  if (![left, top, width, height].every((n) => Number.isFinite(n))) return null;
  return { leftPct: left, topPct: top, widthPct: width, heightPct: height };
}

/** Build internal generation details from the minimal API request. */
export async function buildDetailsFromSimpleRequest({
  side,
  category,
  image,
  templateId,
  frontNotes,
  backNotes,
  customerNotes,
}) {
  const normalizedSide = side === "back" ? "back" : "front";
  const legacy = clip(customerNotes, 1200);
  const front = clip(frontNotes ?? legacy, 1200);
  const back = clip(backNotes ?? legacy, 1200);
  const doc = templateId ? await loadTemplateDoc(templateId) : null;
  const t = doc?.template;
  const frontField = imageFieldsFromTemplateDoc(doc, "front")[0] ?? null;
  const backField = imageFieldsFromTemplateDoc(doc, "back")[0] ?? null;
  const refImageId =
    normalizeImageRef(image) ||
    imageRefFromTemplateDoc(doc, normalizedSide) ||
    normalizeImageRef(normalizedSide === "back" ? t?.back?.backgroundImage || doc?.back : t?.front?.backgroundImage || doc?.front);

  return {
    customerNotes: normalizedSide === "back" ? back : front,
    frontNotes: front,
    backNotes: back,
    image: refImageId,
    templateReference: {
      id: templateId || doc?.id || doc?.templateId || "",
      name: doc?.name || "",
      category: clip(category, 120),
      frontImageId: normalizeImageRef(t?.front?.backgroundImage || doc?.front),
      backImageId: normalizeImageRef(t?.back?.backgroundImage || doc?.back),
    },
    photoCutout: {
      front: cutoutFromTemplateField(frontField) || FRONT_PHOTO_CUTOUT,
      back: cutoutFromTemplateField(backField) || BACK_PHOTO_CUTOUT,
    },
  };
}

async function resolveTemplateReferenceImage(details, side) {
  const ref = details?.templateReference;
  const normalizedSide = side === "back" ? "back" : "front";

  const directImage = normalizeImageRef(details?.image);
  if (directImage) {
    const buf = await loadImageBufferFromRef(directImage);
    if (buf?.length) {
      return { buffer: buf, imageId: directImage, source: "request-image" };
    }
  }

  const explicit =
    normalizedSide === "back"
      ? ref?.backImageId || ref?.backImage
      : ref?.frontImageId || ref?.frontImage;
  if (explicit) {
    const buf = await loadImageBufferFromRef(explicit);
    if (buf?.length) {
      return { buffer: buf, imageId: normalizeImageRef(explicit), source: "payload" };
    }
  }
  const templateId = ref?.id;
  if (!templateId) return null;
  const doc = await loadTemplateDoc(templateId);
  if (!doc) return null;
  const imageRef = imageRefFromTemplateDoc(doc, normalizedSide);
  if (!imageRef) return null;
  const buf = await loadImageBufferFromRef(imageRef);
  if (!buf?.length) return null;
  return { buffer: buf, imageId: imageRef, source: "template-doc" };
}

/** Fit image to OpenAI portrait canvas without cropping artwork. */
async function prepareReferenceForEdit(buffer) {
  const { w, h } = OPENAI_PORTRAIT;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read template reference image.");
  }

  return sharp(buffer)
    .rotate()
    .resize(w, h, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 3, effort: 7 })
    .toBuffer();
}

function isGptImageModel(model) {
  return /^gpt-image/i.test(model);
}

function buildImageGenerationBody(model, prompt) {
  if (isGptImageModel(model)) {
    return {
      model,
      prompt,
      n: 1,
      size: "1024x1536",
      quality: "high",
      output_format: "png",
    };
  }
  const body = {
    model,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (model === "dall-e-3") {
    body.size = "1024x1792";
    body.quality = "hd";
  } else {
    body.size = "1024x1024";
  }
  return body;
}

async function imageBufferFromGenerationResponse(data) {
  const item = data?.data?.[0];
  if (!item) throw new Error("No image returned from AI service.");

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }

  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error("Could not download generated image.");
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new Error("No image data in AI response.");
}

async function generateOpenAiImageWithReference(apiKey, model, prompt, referencePngBuffer) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", "1024x1536");
  form.append("quality", "high");
  form.append("output_format", "png");
  form.append("input_fidelity", "high");
  form.append("background", "opaque");
  form.append(
    "image",
    new Blob([referencePngBuffer], { type: "image/png" }),
    "template-reference.png"
  );

  const httpFetch = globalThis.fetch ?? fetch;
  const res = await httpFetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `OpenAI edit request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return imageBufferFromGenerationResponse(data);
}

async function generateOpenAiImage(prompt, referenceBuffer = null) {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("AI card generation is not configured (missing OPENAI_API_KEY).");
  }

  const model = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();

  if (referenceBuffer?.length && isGptImageModel(model)) {
    const prepared = await prepareReferenceForEdit(referenceBuffer);
    try {
      const edited = await generateOpenAiImageWithReference(apiKey, model, prompt, prepared);
      if ((await opaquePixelRatio(edited)) >= 0.12) return edited;
      console.warn("[ai-card] edit output mostly transparent; retrying with text generation");
    } catch (err) {
      console.warn("[ai-card] edit failed, falling back to generation:", err?.message || err);
    }
  }

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildImageGenerationBody(model, prompt)),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `OpenAI request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return imageBufferFromGenerationResponse(data);
}

function cutoutPixelBounds(width, height, cutout) {
  const left = Math.floor((width * cutout.leftPct) / 100);
  const top = Math.floor((height * cutout.topPct) / 100);
  const right = Math.min(width, left + Math.floor((width * cutout.widthPct) / 100));
  const bottom = Math.min(height, top + Math.floor((height * cutout.heightPct) / 100));
  return { left, top, right, bottom };
}
function isPhotoKey(r, g, b) {
  return r > 160 && g < 140 && b > 160 && r - g > 60 && b - g > 60;
}

/** Gold/white frame strokes that may overlap the photo slot — keep opaque. */
function isFrameAccentInCutout(r, g, b, a) {
  if (a < 48) return false;
  if (r > 150 && g > 90 && b < 140 && r - b > 25) return true;
  if (r > 200 && g > 200 && b > 200) return true;
  return false;
}

function writeOpaqueFromSource(out, src, i, bg, matteFill) {
  const a = src[i + 3];
  if (a <= 0) {
    if (matteFill) {
      out[i] = bg.r;
      out[i + 1] = bg.g;
      out[i + 2] = bg.b;
      out[i + 3] = 255;
    } else {
      out[i + 3] = 0;
    }
    return;
  }
  if (a >= 250) {
    out[i] = src[i];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i + 2];
    out[i + 3] = 255;
    return;
  }
  const scale = 255 / a;
  out[i] = Math.min(255, Math.round(src[i] * scale));
  out[i + 1] = Math.min(255, Math.round(src[i + 1] * scale));
  out[i + 2] = Math.min(255, Math.round(src[i + 2] * scale));
  out[i + 3] = 255;
}

/**
 * Punch a transparent photo hole in the cutout; flatten stray transparency elsewhere so the frame is never blank.
 */
async function processFramePng(buffer, side, cutoutOverride) {
  const cutout =
    cutoutOverride &&
    Number.isFinite(cutoutOverride.leftPct) &&
    Number.isFinite(cutoutOverride.topPct) &&
    Number.isFinite(cutoutOverride.widthPct) &&
    Number.isFinite(cutoutOverride.heightPct)
      ? cutoutOverride
      : side === "back"
        ? BACK_PHOTO_CUTOUT
        : FRONT_PHOTO_CUTOUT;
  const { data: src, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 4) return buffer;

  const { left, top, right, bottom } = cutoutPixelBounds(width, height, cutout);
  const bg = FRAME_MATTE_RGB;
  const out = Buffer.from(src);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inCutout = x >= left && x < right && y >= top && y < bottom;
      const i = (y * width + x) * channels;
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      const a = src[i + 3];

      if (inCutout) {
        if (isPhotoKey(r, g, b)) {
          out[i + 3] = 0;
        } else if (isFrameAccentInCutout(r, g, b, a)) {
          writeOpaqueFromSource(out, src, i, bg, false);
        } else {
          out[i + 3] = 0;
        }
        continue;
      }

      if (isPhotoKey(r, g, b)) {
        out[i] = bg.r;
        out[i + 1] = bg.g;
        out[i + 2] = bg.b;
        out[i + 3] = 255;
        continue;
      }

      if (a < 250) {
        writeOpaqueFromSource(out, src, i, bg, true);
      }
    }
  }

  return sharp(out, { raw: { width, height, channels } })
    .png({ compressionLevel: 1, effort: 3 })
    .withMetadata({ density: 300 })
    .toBuffer();
}

async function opaquePixelRatio(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = data.length / info.channels;
  let opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] >= 200) opaque++;
  }
  return opaque / pixels;
}

/** Keep GPT native resolution (1024×1536) — no downscale to print bleed size. */
async function finalizeHdFrame(buffer, side, cutoutOverride, spec) {
  let out = buffer;
  try {
    out = await processFramePng(buffer, side, cutoutOverride);
    if ((await opaquePixelRatio(out)) < 0.08) {
      console.warn("[ai-card] processed frame mostly blank; using raw GPT output");
      out = buffer;
    }
  } catch (e) {
    console.warn("[ai-card] frame post-process failed; using raw GPT output:", e?.message || e);
    out = buffer;
  }

  const meta = await sharp(out).metadata();
  const png = await sharp(out)
    .png({ compressionLevel: 1, effort: 3 })
    .withMetadata({ density: spec.dpi ?? 300 })
    .toBuffer();

  return {
    png,
    width: meta.width ?? OPENAI_PORTRAIT.w,
    height: meta.height ?? OPENAI_PORTRAIT.h,
  };
}

async function savePngToUploads(buffer) {
  if (!buffer?.length || buffer.length < 1024) {
    throw new Error("Generated image was empty or too small. Try again or adjust your prompt.");
  }
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const id = randomUUID();
  const filename = `${id}.png`;
  await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
  return id;
}

export async function generateAiCardSide({ side, sizeOptionId, details }) {
  const normalizedSide = side === "back" ? "back" : "front";
  const spec = getPrintSpecForSizeOptionId(sizeOptionId);
  const ref = details?.templateReference;
  const reference = await resolveTemplateReferenceImage(details || {}, normalizedSide);
  const referenceBuffer = reference?.buffer ?? null;
  const hasReferenceImage = Boolean(referenceBuffer?.length);

  if (ref?.id && !hasReferenceImage && !details?.image) {
    throw new Error(
      `Could not load the ${normalizedSide} template artwork for "${clip(ref.name, 80) || "selected design"}". ` +
        "The template image file is missing from this server."
    );
  }

  const prompt = buildPrompt(normalizedSide, details || {}, sizeOptionId, hasReferenceImage);
  const cutoutOverride = details?.photoCutout?.[normalizedSide] ?? null;
  const raw = await generateOpenAiImage(prompt, referenceBuffer);
  const { png, width, height } = await finalizeHdFrame(raw, normalizedSide, cutoutOverride, spec);
  const id = await savePngToUploads(png);
  return {
    id,
    width,
    height,
    side: normalizedSide,
    sizeOptionId: spec.sizeOptionId,
    dpi: spec.dpi,
    usedTemplateReference: hasReferenceImage,
    referenceImageId: reference?.imageId ?? null,
    referenceImageSource: reference?.source ?? null,
  };
}
