/**
 * Sitemap XML builders for the public storefront.
 *
 * Layout (Yoast-style):
 *   /sitemap.xml          -> sitemap index referencing the four sub-sitemaps below
 *   /page-sitemap.xml     -> static marketing pages (about, contact, faq, ...)
 *   /product-sitemap.xml  -> every public product page (from `templates` collection)
 *   /category-sitemap.xml -> every category + subcategory listing page
 *   /post-sitemap.xml     -> every published blog post
 *
 * URL slug mapping mirrors `sports-card-frontend/src/lib/url-structure.ts` so the
 * server emits the same canonical URLs the SPA renders. Keep them in sync when
 * adding new category/subcategory slugs.
 */
import { Template } from "../models/Template.js";
import { Category } from "../models/Category.js";
import { Subcategory } from "../models/Subcategory.js";
import { BlogPost } from "../models/BlogPost.js";
import { FEATURED_BLOG_SEEDS } from "../data/featured-blog-seeds.js";

/** Internal category ID -> URL slug (mirrors frontend CATEGORY_TO_SLUG). */
const CATEGORY_TO_SLUG = {
  sports: "sports-cards-trading-cards",
  "save-the-dates": "weddings-save-the-date",
  "birth-announcements": "birth-announcements-trading-cards",
  pets: "pets-trading-cards",
  "military-public-safety": "military-public-safety",
  military: "military-public-safety",
  promotional: "promotional-corporate",
  "pomotional&corporate": "promotional-corporate",
  music: "music",
  Music: "music",
  lifestyle: "life-style",
  LifeStyle: "life-style",
};

/** Mirrors frontend `getSubcategorySlug` so DB subcategory ids resolve to canonical URL slugs. */
function subcategoryUrlSlug(categoryId, subcategoryId) {
  const sub = String(subcategoryId ?? "").trim();
  if (!sub) return "";
  switch (categoryId) {
    case "sports":
      if (sub === "hockey") return "icehockey";
      if (sub === "motor-sports") return "motor_sports";
      return sub;
    case "save-the-dates":
      if (sub === "basketball") return "basketball-weddings-save-the-date";
      if (sub === "baseball") return "baseball-weddings-save-the-date";
      if (sub === "football") return "football-weddings-save-the-date";
      if (sub === "hockey") return "hockey-weddings-save-the-date";
      return sub;
    case "birth-announcements":
    case "birth-announcements-trading-cards":
      if (sub === "birth-announcement-baseball") return "baseball-birth-announcements-trading-cards";
      if (sub === "birth-announcement-foodball" || sub === "birth-announcement-football")
        return "football-birth-announcements-trading-cards";
      if (sub === "birth-announcement-hockey" || sub === "hockey") return "hockey-birth-announcements-trading-cards";
      if (sub === "birth-announcement-basketball") return "basketball-birth-announcements-trading-cards";
      return sub;
    case "pets":
      if (sub === "dogs") return "dog";
      return sub;
    case "military-public-safety":
    case "military":
      if (sub === "k9") return "canine-police";
      if (sub === "Firefighters") return "firefighters";
      return sub;
    default:
      return sub;
  }
}

/** Build /product-category/... path matching the frontend `getCategoryPath` helper. */
function categoryUrlPath(categoryId, subcategoryId) {
  const cat = String(categoryId ?? "").trim();
  if (!cat) return "";
  const sub = String(subcategoryId ?? "").trim();
  if (!sub) {
    if (cat === "life-style" || cat === "lifestyle" || cat === "LifeStyle") return "/product-category/life-style";
    if (cat === "music" || cat === "Music") return "/product-category/music";
    if (cat === "promotional-corporate" || cat === "promotional" || cat === "pomotional&corporate")
      return "/product-category/promotional-corporate";
    const slug = CATEGORY_TO_SLUG[cat] ?? cat;
    return `/product-category/${encodeURIComponent(slug)}`;
  }
  const catSlug = CATEGORY_TO_SLUG[cat] ?? cat;
  const subSlug = subcategoryUrlSlug(cat, sub);
  return `/product-category/${encodeURIComponent(catSlug)}/${encodeURIComponent(subSlug || sub)}`;
}

const LEGACY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/i;

/** Prefer slug-like id over legacy UUID/ObjectId. Returns last `/`-segment to match SPA path. */
function productUrlSlug(doc) {
  const candidates = [doc.id, doc.templateId].filter((s) => typeof s === "string" && s.trim());
  const looksLegacy = (s) => LEGACY_ID_REGEX.test(s) || OBJECT_ID_REGEX.test(s);
  const slug = (candidates.find((s) => !looksLegacy(s)) || candidates[0] || "").trim();
  if (!slug) return "";
  const segments = slug.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : slug;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIsoLastmod(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function urlEntry(baseUrl, pathOrUrl, lastmod, changefreq, priority) {
  const loc = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const lines = [`  <url>`, `    <loc>${xmlEscape(loc)}</loc>`];
  const iso = toIsoLastmod(lastmod);
  if (iso) lines.push(`    <lastmod>${iso}</lastmod>`);
  if (changefreq) lines.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority != null) lines.push(`    <priority>${priority}</priority>`);
  lines.push(`  </url>`);
  return `${lines.join("\n")}\n`;
}

function wrapUrlset(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}</urlset>\n`;
}

function wrapSitemapIndex(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}</sitemapindex>\n`;
}

/** Static marketing pages — keep aligned with public routes registered in `sports-card-frontend/src/App.tsx`. */
const STATIC_PAGES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/about", changefreq: "monthly", priority: "0.7" },
  { path: "/contact", changefreq: "monthly", priority: "0.6" },
  { path: "/group-orders", changefreq: "monthly", priority: "0.6" },
  { path: "/shop", changefreq: "weekly", priority: "0.9" },
  { path: "/privacy-policy", changefreq: "yearly", priority: "0.3" },
  { path: "/terms-of-service", changefreq: "yearly", priority: "0.3" },
  { path: "/faqs", changefreq: "monthly", priority: "0.6" },
  { path: "/your-design", changefreq: "monthly", priority: "0.7" },
  { path: "/ai-card-creator", changefreq: "monthly", priority: "0.7" },
  { path: "/custom-design-size", changefreq: "monthly", priority: "0.6" },
  { path: "/how-it-works", changefreq: "monthly", priority: "0.7" },
  { path: "/order-tips", changefreq: "monthly", priority: "0.6" },
  { path: "/price-guide", changefreq: "monthly", priority: "0.6" },
  { path: "/blog", changefreq: "weekly", priority: "0.8" },
];

export function buildPageSitemap(baseUrl) {
  let body = "";
  for (const page of STATIC_PAGES) {
    body += urlEntry(baseUrl, page.path, null, page.changefreq, page.priority);
  }
  return wrapUrlset(body);
}

export async function buildProductSitemap(baseUrl) {
  /** Exclude variations: SPA only renders one page per template "family" (parent or standalone). */
  const list = await Template.find({
    $and: [
      { $or: [{ parentId: { $exists: false } }, { parentId: null }, { parentId: "" }] },
      { isParent: { $ne: false } },
    ],
  })
    .select("id templateId updatedAt createdAt")
    .lean();

  const seen = new Set();
  const rows = [];
  for (const doc of list) {
    const slug = productUrlSlug(doc);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, lastmod: doc.updatedAt || doc.createdAt });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  let body = "";
  for (const row of rows) {
    body += urlEntry(baseUrl, `/product/${encodeURIComponent(row.slug)}`, row.lastmod, "weekly", "0.7");
  }
  return wrapUrlset(body);
}

export async function buildCategorySitemap(baseUrl) {
  const [cats, subs] = await Promise.all([
    Category.find().select("id updatedAt createdAt").lean(),
    Subcategory.find().select("id categoryId updatedAt createdAt").lean(),
  ]);

  const seen = new Set();
  const rows = [];

  for (const c of cats) {
    const path = categoryUrlPath(c.id);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, lastmod: c.updatedAt || c.createdAt });
  }
  for (const s of subs) {
    const path = categoryUrlPath(s.categoryId, s.id);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, lastmod: s.updatedAt || s.createdAt });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  let body = "";
  for (const row of rows) {
    body += urlEntry(baseUrl, row.path, row.lastmod, "weekly", "0.8");
  }
  return wrapUrlset(body);
}

export async function buildPostSitemap(baseUrl) {
  const list = await BlogPost.find({ published: true })
    .select("slug publishedAt updatedAt createdAt")
    .lean();

  const seen = new Set();
  const rows = [];
  for (const p of list) {
    const slug = String(p.slug ?? "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, lastmod: p.publishedAt || p.updatedAt || p.createdAt });
  }
  /** The four legacy posts always render via hardcoded React pages, so include their URLs even if not yet seeded. */
  for (const seed of FEATURED_BLOG_SEEDS) {
    if (!seen.has(seed.slug)) {
      seen.add(seed.slug);
      rows.push({ slug: seed.slug, lastmod: null });
    }
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  let body = "";
  for (const row of rows) {
    body += urlEntry(baseUrl, `/${encodeURIComponent(row.slug)}`, row.lastmod, "monthly", "0.6");
  }
  return wrapUrlset(body);
}

/**
 * Compute per-sub-sitemap `lastmod` from the most recent document in each collection so search engines
 * see a fresh index entry whenever underlying content changes (and skip re-crawl when nothing changed).
 */
async function latestUpdatedAt(model, filter = {}) {
  const row = await model.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).select("updatedAt createdAt").lean();
  return row ? toIsoLastmod(row.updatedAt || row.createdAt) : "";
}

export async function buildSitemapIndex(baseUrl) {
  const now = new Date().toISOString();
  const [productLastmod, categoryLastmod, subcategoryLastmod, postLastmod] = await Promise.all([
    latestUpdatedAt(Template),
    latestUpdatedAt(Category),
    latestUpdatedAt(Subcategory),
    latestUpdatedAt(BlogPost, { published: true }),
  ]);

  const entries = [
    { path: "/page-sitemap.xml", lastmod: now },
    { path: "/product-sitemap.xml", lastmod: productLastmod || now },
    { path: "/category-sitemap.xml", lastmod: categoryLastmod || subcategoryLastmod || now },
    { path: "/post-sitemap.xml", lastmod: postLastmod || now },
  ];

  let body = "";
  for (const entry of entries) {
    body += `  <sitemap>\n    <loc>${xmlEscape(`${baseUrl}${entry.path}`)}</loc>\n    <lastmod>${xmlEscape(entry.lastmod)}</lastmod>\n  </sitemap>\n`;
  }
  return wrapSitemapIndex(body);
}

/**
 * Resolve the public base URL for `<loc>` entries.
 * Prefers `PUBLIC_APP_URL` so production always renders `https://customsportscards.com` regardless of
 * which host (Vercel proxy, api.* domain, etc.) actually served the request.
 */
export function resolvePublicBaseUrl(req) {
  const env = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const proto = String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "https");
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "");
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}
