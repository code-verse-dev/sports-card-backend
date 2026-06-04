import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import sharp from "sharp";
import {
  bleedPixelDimensions,
  bleedTrimSafePromptLine,
  getPrintSpecForSizeOptionId,
} from "./aiCardPrintSpec.js";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

const DEFAULT_STYLE =
  "Classic premium sports trading card — deep navy background, gold foil accents, bold white name typography, clean and print-ready";

const NO_LOGO_RULE =
  "No invented logos, crests, shields, or sponsor marks — team names as plain text only.";

const BANNED_UNLESS_REQUESTED =
  "Do not use neon, cyberpunk, glitch, circuit patterns, pink/cyan glow, or sci-fi HUD unless the customer explicitly asked.";

const LAYOUT_RULES =
  "Full-bleed portrait card art to all four edges. Lower panel: name, position, stats on opaque navy. " +
  "Photo slot: one flat magenta (#FF00FF) rectangle only — no people, no gradient inside magenta. " +
  "Around magenta: opaque gold/navy frame border and vignette (painted, not transparent). " +
  "Smooth gradient from photo zone into lower text panel. Front and back must match.";

/** Photo cutout % — must match sports-card-frontend build-ai-creator-template.ts */
const FRONT_PHOTO_CUTOUT = { leftPct: 10, topPct: 9, widthPct: 80, heightPct: 44 };
const BACK_PHOTO_CUTOUT = { leftPct: 10, topPct: 9, widthPct: 80, heightPct: 28 };
const FRAME_MATTE_RGB = { r: 15, g: 23, b: 42 };

function clip(s, max = 500) {
  return String(s ?? "").trim().slice(0, max);
}

function cardContentTypography(side, details) {
  const c = details?.cardContent;
  if (!c || typeof c !== "object") return "";
  if (side === "back") {
    const parts = [];
    if (clip(c.backHeadline, 80)) parts.push(`Headline (exact): "${clip(c.backHeadline, 80)}"`);
    if (clip(c.backBio, 400)) parts.push(`Bio (exact): "${clip(c.backBio, 400)}"`);
    if (clip(c.backStats, 120)) parts.push(`Stats (exact): "${clip(c.backStats, 120)}"`);
    if (!parts.length) return "";
    return `Back typography — spell correctly, gold/white on navy, readable hierarchy: ${parts.join(". ")}.`;
  }
  const parts = [];
  if (clip(c.frontName, 80)) parts.push(`Name large white (exact): "${clip(c.frontName, 80)}"`);
  if (clip(c.frontPosition, 80)) parts.push(`Position gold (exact): "${clip(c.frontPosition, 80)}"`);
  if (clip(c.frontStats, 120)) parts.push(`Stats gold (exact): "${clip(c.frontStats, 120)}"`);
  if (clip(c.frontFooter, 80)) parts.push(`Footer small gold text (exact): "${clip(c.frontFooter, 80)}"`);
  if (!parts.length) return "";
  return `Front typography — spell correctly, professional sports card fonts: ${parts.join(". ")}.`;
}

function cutoutPromptLine(side) {
  const c = side === "back" ? BACK_PHOTO_CUTOUT : FRONT_PHOTO_CUTOUT;
  return (
    `Magenta photo slot EXACTLY: left ${c.leftPct}%, top ${c.topPct}%, width ${c.widthPct}%, height ${c.heightPct}%. ` +
    "Everything outside that rectangle is opaque illustrated frame — no holes, no white margins."
  );
}

function buildPrompt(side, details, sizeOptionId) {
  const sport = clip(details.sportOrTheme, 120) || "Sports";
  const style = clip(details.style, 120) || DEFAULT_STYLE;
  const notes = clip(details.additionalNotes, 500);
  const typography = cardContentTypography(side, details);
  const spec = getPrintSpecForSizeOptionId(sizeOptionId);
  const printGuides = bleedTrimSafePromptLine(spec);
  const normalizedSide = side === "back" ? "back" : "front";

  return [
    `${normalizedSide.toUpperCase()} trading card frame PNG for print.`,
    printGuides,
    `Theme: ${sport}.`,
    `Style: ${style}.`,
    notes ? `Customer notes: ${notes}.` : "",
    typography,
    NO_LOGO_RULE,
    BANNED_UNLESS_REQUESTED,
    LAYOUT_RULES,
    cutoutPromptLine(normalizedSide),
    normalizedSide === "back"
      ? "Below 38% from top: opaque back text panel only."
      : "Below 54% from top: opaque front name/stats panel only.",
  ]
    .filter(Boolean)
    .join(" ");
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

async function generateOpenAiImage(prompt) {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("AI card generation is not configured (missing OPENAI_API_KEY).");
  }

  const model = String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();
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

/** Magenta placeholder — converted to transparency when the model uses it. */
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
 * Magenta → transparent in photo slot; preserve frame colors elsewhere (no muddy navy flattening).
 */
async function processFramePng(buffer, side) {
  const cutout = side === "back" ? BACK_PHOTO_CUTOUT : FRONT_PHOTO_CUTOUT;
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
        if (
          isPhotoKey(r, g, b) ||
          a < 20 ||
          !isFrameAccentInCutout(r, g, b, a)
        ) {
          out[i + 3] = 0;
        } else {
          writeOpaqueFromSource(out, src, i, bg, false);
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

      writeOpaqueFromSource(out, src, i, bg, true);
    }
  }

  return sharp(out, { raw: { width, height, channels } }).png({ compressionLevel: 8 }).toBuffer();
}

async function resizeToBleed(buffer, spec) {
  const { w, h } = bleedPixelDimensions(spec);
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read generated image data.");
  }
  return sharp(buffer)
    .resize(w, h, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 8 })
    .toBuffer();
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
  const { w, h } = bleedPixelDimensions(spec);
  const prompt = buildPrompt(normalizedSide, details || {}, sizeOptionId);
  const raw = await generateOpenAiImage(prompt);
  const resized = await resizeToBleed(raw, spec);
  const png = await processFramePng(resized, normalizedSide);
  const id = await savePngToUploads(png);
  return { id, width: w, height: h, side: normalizedSide, sizeOptionId: spec.sizeOptionId };
}
