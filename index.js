import "./load-env.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import http from "http";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import fs from "fs/promises";
import { buildTemplateSlugOrQueries, pickBestTemplateCandidate } from "./services/templateSlugResolve.js";
import { connectDB, dbConnected } from "./db.js";
import { requireAdmin, requireCustomer, optionalCustomer } from "./middleware/auth.js";
import adminAuthRouter from "./routes/adminAuth.js";
import userAuthRouter from "./routes/userAuth.js";
import stripeRouter from "./routes/stripe.js";
import { handleRawStripeWebhook } from "./routes/stripeWebhook.js";
import { registerUploadsRouter, registerCheckoutDesignUpload } from "./uploads-router.js";
import { listCategories, listSubcategories, upsertCategory, upsertSubcategory, deleteCategoryById, deleteSubcategoryById, getCategoryById, getSubcategoryById } from "./categories-db.js";
import { DEFAULT_CATEGORIES, DEFAULT_SUBCATEGORIES } from "./seed-categories.js";
import {
  getAllOrders,
  getOrdersPage,
  getOrderById,
  createOrder,
  updateOrderStatus,
  updateOrder,
  deleteOrderById,
  deleteAllOrders,
  ORDER_STATUSES,
} from "./store/orders.js";
import { getPrices, setPrices } from "./store/prices.js";
import { Order } from "./models/Order.js";
import { Template } from "./models/Template.js";
import { Category } from "./models/Category.js";
import { Subcategory } from "./models/Subcategory.js";
import { BlogPost } from "./models/BlogPost.js";
import { BlogComment } from "./models/BlogComment.js";
import { BlogLike } from "./models/BlogLike.js";
import { ContactSubmission } from "./models/ContactSubmission.js";
import { FEATURED_BLOG_SEEDS, seedContentHtml } from "./data/featured-blog-seeds.js";
import { getPriceConfig, setPriceConfig } from "./models/PriceConfig.js";
import { AdminUser, hashPassword } from "./models/AdminUser.js";
import { CustomerUser, hashCustomerPassword } from "./models/CustomerUser.js";
import {
  sendOrderStatusChangedCustomerEmail,
  sendTrackingInfoCustomerEmail,
  sendDesignFixRequestedCustomerEmail,
} from "./services/orderEmails.js";
import { initAdminSocket, emitAdminNotification } from "./services/adminSocketHub.js";
import { getOrderCustomerView } from "./services/orderCustomer.js";
import {
  filterItemsForAdminEmailCardPdf,
  filterItemsForCustomerEmailCardPdf,
  filterDesignedItemsForCardCapture,
} from "./services/orderCardPdfExportMeta.js";
import { buildOrderCardImagesZipHeadless } from "./services/orderCardCaptureHeadless.js";
import {
  buildSitemapIndex,
  buildPageSitemap,
  buildProductSitemap,
  buildCategorySitemap,
  buildPostSitemap,
  resolvePublicBaseUrl,
} from "./services/sitemap.js";
import { buildFullOrderCardPdfBufferHeadless } from "./services/orderCardPdfHeadless.js";
import { augmentPuppeteerLaunchError } from "./services/puppeteerLaunchConfig.js";
import { profileFromBody, setCustomerPasswordById } from "./services/customerProfile.js";
import {
  ensureUniqueOrderCode,
  ensureUniqueCustomerPublicId,
  getOrderRef,
  resolveCustomerPublicDisplayId,
} from "./services/publicCodes.js";
import { buildOrderPrintPdfBuffer } from "./services/orderPdf.js";
import {
  getCachedAdminStats,
  setCachedAdminStats,
  invalidateAdminStatsCache,
} from "./services/adminStatsCache.js";

const app = express();
const PORT = Number(process.env.PORT) || 4043;
const HOST = (process.env.HOST && String(process.env.HOST).trim() && process.env.HOST !== "null") ? process.env.HOST.trim() : "0.0.0.0";
const JSON_BODY_LIMIT = String(process.env.JSON_BODY_LIMIT || "50mb").trim() || "50mb";

app.use(cors({ origin: true, credentials: true, allowedHeaders: ["Content-Type", "Authorization"] }));
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  handleRawStripeWebhook(req, res).catch((e) => {
    console.error("[stripe-webhook] unhandled:", e?.message || e);
    if (!res.headersSent) res.status(500).send("Internal error");
  });
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));

/** Log every request when it finishes (so you see traffic in the terminal, not only `[orders]`). */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[http] ${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${ms}ms`);
  });
  next();
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request payload is too large. Please wait for image upload processing, then try checkout again.",
    });
  }
  return next(err);
});

/** When DB is connected, require admin JWT; otherwise no-op (legacy in-memory mode). */
const maybeRequireAdmin = (req, res, next) => {
  if (!dbConnected()) return next();
  requireAdmin(req, res, next);
};

// ----- Helpers when using DB -----
const CUSTOMER_ID_POPULATE_SELECT =
  "email firstName lastName phone address addressLine2 city state zip country createdAt publicId";

function orderToJson(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const cId = o.customerId;
  const customerIdStr =
    cId && typeof cId === "object" && cId._id != null
      ? String(cId._id)
      : cId
        ? String(cId)
        : null;
  return {
    id: o._id?.toString() ?? o.id,
    orderCode: o.orderCode || undefined,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    stripeSessionId: o.stripeSessionId,
    paymentProvider: o.paymentProvider || undefined,
    paymentReferenceId: o.paymentReferenceId || undefined,
    customerId: customerIdStr,
    customer: getOrderCustomerView(o) || {},
    items: o.items,
    totalCents: o.totalCents,
    discountCents: o.discountCents != null ? o.discountCents : undefined,
    shippingCents: o.shippingCents,
    taxCents: o.taxCents != null ? o.taxCents : undefined,
    paymentLastError: o.paymentLastError || undefined,
    notes: o.notes,
    createAccount: o.createAccount,
    trackingCarrier: o.trackingCarrier,
    trackingNumber: o.trackingNumber,
    trackingUrl: o.trackingUrl,
    designFixRequestedAt: o.designFixRequestedAt || undefined,
    designFixNote: o.designFixNote || undefined,
    designFixLastSubmittedAt: o.designFixLastSubmittedAt || undefined,
  };
}

const ORDER_STATUSES_WITH_PAYMENT = [...new Set([...ORDER_STATUSES, "pending_payment", "payment_failed"])];

// ---------- Public: Prices ----------
app.get("/api/prices", async (req, res) => {
  try {
    if (dbConnected()) {
      const config = await getPriceConfig();
      return res.json(config);
    }
    res.json(getPrices());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Categories & Subcategories (from DB; seed with POST /api/admin/categories/seed-defaults) ----------
app.get("/api/categories", async (req, res) => {
  try {
    if (dbConnected()) {
      const list = await listCategories();
      return res.json(list);
    }
    res.json(DEFAULT_CATEGORIES);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/subcategories", async (req, res) => {
  try {
    const categoryId = req.query.categoryId;
    if (dbConnected()) {
      const list = await listSubcategories(categoryId || undefined);
      return res.json(list);
    }
    const list = categoryId
      ? DEFAULT_SUBCATEGORIES.filter((s) => s.categoryId === categoryId)
      : DEFAULT_SUBCATEGORIES;
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Templates (from DB) ----------
// Prefer slug (id or templateId) for URLs; fall back to _id for backwards compatibility
function isMongoId(s) {
  return typeof s === "string" && /^[0-9a-fA-F]{24}$/.test(s.trim());
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Express may give query as string or string[] when repeated (?page=1&page=2). */
function firstQueryParam(q) {
  if (q == null) return undefined;
  return Array.isArray(q) ? q[0] : q;
}

app.get("/api/templates", async (req, res) => {
  try {
    if (!dbConnected()) {
      return res.status(503).json({ error: "Database not connected", db: false });
    }
    const qCategoryId = req.query.categoryId;
    const qSubcategoryId = req.query.subcategoryId;
    const filter = {};
    if (qCategoryId && String(qCategoryId).trim()) {
      const val = String(qCategoryId).trim();
      filter.categoryId = new RegExp(`^${escapeRegex(val)}$`, "i");
    }
    if (qSubcategoryId && String(qSubcategoryId).trim()) {
      const val = String(qSubcategoryId).trim();
      filter.subcategoryId = new RegExp(`^${escapeRegex(val)}$`, "i");
    }
    // When no filters: exclude long text fields but keep `template` long enough to derive list thumbnails,
    // then strip `template` from the JSON (shop relies on top-level `preview` or nested image refs).
    const noFilters = !qCategoryId && !qSubcategoryId;
    let query = Template.find(filter);
    if (noFilters) {
      query = query.limit(2000).select("-productDetails -productDetailsTitle");
    }
    const list = await query.lean();
    const withId = list.map((doc) => {
      let row = { ...doc };
      if (noFilters && doc.template && typeof doc.template === "object") {
        const t = doc.template;
        // Same priority as POST create + Shop grid: nested template images win over stale top-level preview
        const effective =
          t.previewImage ||
          t.thumbnailImage ||
          doc.preview ||
          (t.front && t.front.backgroundImage) ||
          "";
        if (effective) row.preview = effective;
        const { template: _drop, ...rest } = row;
        row = rest;
      }
      const id =
        (doc.id && String(doc.id).trim()) ||
        (doc.templateId && String(doc.templateId).trim()) ||
        doc._id?.toString();
      return { ...row, id };
    });
    return res.json(withId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function sendTemplateByIdOrSlug(req, res, rawParam) {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const param = String(rawParam || "").trim();
    if (!param) return res.status(400).json({ error: "Missing id or slug" });
    let doc = await Template.findOne({
      $or: [
        { id: param },
        { templateId: param },
        { legacyIds: param },
        ...(isMongoId(param) ? [{ _id: param }] : []),
      ],
    }).lean();
    if (!doc) {
      const slugQueries = buildTemplateSlugOrQueries(param);
      const candidates = await Template.find({ $or: slugQueries }).lean();
      doc = pickBestTemplateCandidate(candidates, param, {
        categoryId: req.query.categoryId || req.query.category,
        subcategoryId: req.query.subcategoryId || req.query.subcategory,
      });
    }
    if (!doc) return res.status(404).json({ error: "Template not found" });
    const id = (doc.id && String(doc.id).trim()) || (doc.templateId && String(doc.templateId).trim()) || doc._id?.toString();
    res.json({ ...doc, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/templates/:idOrSlug – accepts full id, templateId, legacyIds, or slug (last segment).
// Frontend uses slug-only in URLs; backend resolves slug to template so frontend never needs to send internal id.
app.get("/api/templates/:idOrSlug", async (req, res) => {
  return sendTemplateByIdOrSlug(req, res, req.params.idOrSlug);
});

// Backwards compatibility for older/manual callers that send unencoded slash ids:
// /api/templates/sports/baseball/baseball-trading-card-02.
app.get("/api/templates/*", async (req, res) => {
  return sendTemplateByIdOrSlug(req, res, req.params[0]);
});

// Register before app.use("/api/admin", …) so /api/admin/templates/* is not swallowed by the auth router.
// ---------- Admin: Templates (POST create, PUT update, DELETE) ----------
app.post("/api/admin/templates", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const body = req.body || {};
    const {
      name,
      categoryId,
      subcategoryId,
      template: templateBody,
      templateId: bodyTemplateId,
      parentId: bodyParentId,
      isParent: bodyIsParent,
      parentName: bodyParentName,
    } = body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
    if (!categoryId || !String(categoryId).trim()) return res.status(400).json({ error: "categoryId required" });
    if (!subcategoryId || !String(subcategoryId).trim()) return res.status(400).json({ error: "subcategoryId required" });
    if (!templateBody || typeof templateBody !== "object") return res.status(400).json({ error: "template object required" });

    const cat = String(categoryId).trim();
    const sub = String(subcategoryId).trim();

    const explicitTid =
      bodyTemplateId != null && String(bodyTemplateId).trim() !== "" ? String(bodyTemplateId).trim() : "";

    let id;
    if (explicitTid) {
      id = explicitTid;
      const exists = await Template.findOne({ $or: [{ id }, { templateId: id }] });
      if (exists) return res.status(409).json({ error: "A template with this id already exists" });
    } else {
      const slugBase = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card";
      id = `${cat}/${sub}/${slugBase}`;
      let suffix = 1;
      while (await Template.findOne({ $or: [{ id }, { templateId: id }] })) {
        id = `${cat}/${sub}/${slugBase}-${String(suffix).padStart(2, "0")}`;
        suffix += 1;
      }
    }

    const parentId =
      bodyParentId != null && String(bodyParentId).trim() !== "" ? String(bodyParentId).trim() : null;

    const isParentFlag = parentId != null ? false : bodyIsParent !== false;

    let parentNameForDoc = String(name).trim();
    if (bodyParentName != null && String(bodyParentName).trim() !== "") {
      parentNameForDoc = String(bodyParentName).trim();
    } else if (parentId) {
      const p = await Template.findOne({
        $or: [
          { id: parentId },
          { templateId: parentId },
          { legacyIds: parentId },
          ...(isMongoId(parentId) ? [{ _id: parentId }] : []),
        ],
      }).lean();
      if (p) {
        const pname = p.parentName && String(p.parentName).trim();
        const n = p.name && String(p.name).trim();
        parentNameForDoc = pname || n || parentNameForDoc;
      }
    }

    const previewRef = templateBody.previewImage || templateBody.thumbnailImage || "";
    const frontRef = (templateBody.front && templateBody.front.backgroundImage) || "";
    const backRef = (templateBody.back && templateBody.back.backgroundImage) || "";

    const storedTemplate = { ...templateBody, id };

    const doc = await Template.create({
      id,
      templateId: id,
      name: String(name).trim(),
      parentName: parentNameForDoc,
      template: storedTemplate,
      categoryId: cat,
      subcategoryId: sub,
      preview: previewRef || undefined,
      front: frontRef || undefined,
      back: backRef || undefined,
      parentId,
      isParent: isParentFlag,
    });

    const out = doc.toObject();
    const outId = (out.id && String(out.id).trim()) || (out.templateId && String(out.templateId).trim()) || out._id?.toString();
    res.status(201).json({ ...out, id: outId, templateId: outId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/templates/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const param = (req.params.id || "").trim();
    if (!param) return res.status(400).json({ error: "Missing template id" });
    const doc = await Template.findOne({
      $or: [
        { id: param },
        { templateId: param },
        { legacyIds: param },
        ...(isMongoId(param) ? [{ _id: param }] : []),
      ],
    });
    if (!doc) return res.status(404).json({ error: "Template not found" });
    const body = req.body || {};
    const allowed = [
      "name", "parentName", "template", "categoryId", "subcategoryId",
      "preview", "front", "back", "parentId", "isParent",
      "productDetailsTitle", "productDetails", "properties",
    ];
    for (const key of allowed) {
      if (body[key] !== undefined) doc.set(key, body[key]);
    }
    // Keep top-level preview/front/back in sync with nested template (same as POST create). Shop list uses
    // top-level `preview` when `template` is stripped from GET /api/templates.
    if (body.template !== undefined) {
      const tb = doc.template;
      if (tb && typeof tb === "object") {
        const previewRef = tb.previewImage || tb.thumbnailImage || "";
        const frontRef = tb.front && tb.front.backgroundImage ? tb.front.backgroundImage : "";
        const backRef = tb.back && tb.back.backgroundImage ? tb.back.backgroundImage : "";
        if (body.preview === undefined && previewRef) doc.set("preview", previewRef);
        if (body.front === undefined && frontRef) doc.set("front", frontRef);
        if (body.back === undefined && backRef) doc.set("back", backRef);
      }
    }
    await doc.save();
    const out = doc.toObject();
    const id = (out.id && String(out.id).trim()) || (out.templateId && String(out.templateId).trim()) || out._id?.toString();
    res.json({ ...out, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/templates/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const param = (req.params.id || "").trim();
    if (!param) return res.status(400).json({ error: "Missing template id" });
    const doc = await Template.findOne({
      $or: [
        { id: param },
        { templateId: param },
        { legacyIds: param },
        ...(isMongoId(param) ? [{ _id: param }] : []),
      ],
    });
    if (!doc) return res.status(404).json({ error: "Template not found" });

    const parentIdStr = doc.parentId != null ? String(doc.parentId).trim() : "";
    const isVariation = doc.isParent === false || parentIdStr !== "";
    if (!isVariation) {
      const keys = [...new Set([String(doc.id ?? "").trim(), String(doc.templateId ?? "").trim()].filter(Boolean))];
      if (keys.length) {
        const childCount = await Template.countDocuments({
          _id: { $ne: doc._id },
          parentId: { $in: keys },
        });
        if (childCount > 0) {
          return res.status(400).json({
            error: "Delete all variations before deleting the parent product.",
          });
        }
      }
    }

    await Template.deleteOne({ _id: doc._id });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Create order (legacy, no Stripe) - only when no DB ----------
app.post("/api/orders", async (req, res) => {
  try {
    if (dbConnected()) {
      console.warn("[orders] POST /api/orders 400: DB mode — use create-checkout-session");
      return res.status(400).json({ error: "Use POST /api/orders/create-checkout-session for payment" });
    }
    const { customer, items, totalCents, shippingCents, notes, createAccount } = req.body;
    if (!customer || !items || !Array.isArray(items) || items.length === 0) {
      console.warn("[orders] POST /api/orders 400: missing customer or items");
      return res.status(400).json({ error: "customer and items (non-empty array) required" });
    }
    const { email, firstName, lastName, phone, address } = customer;
    if (!email?.trim() || !firstName?.trim() || !lastName?.trim()) {
      console.warn("[orders] POST /api/orders 400: missing customer name/email");
      return res.status(400).json({ error: "customer.email, firstName, lastName required" });
    }
    const order = createOrder({
      customer: { email: String(email).trim(), firstName: String(firstName).trim(), lastName: String(lastName).trim(), phone: phone ? String(phone).trim() : undefined, address: address ? String(address).trim() : undefined },
      items,
      totalCents: totalCents ?? 0,
      shippingCents: shippingCents ?? 0,
      notes: notes ? String(notes).trim() : undefined,
      createAccount: Boolean(createAccount),
    });
    console.log("[orders] POST /api/orders ok (in-memory)", { id: order.id, itemCount: items.length, status: order.status });
    invalidateAdminStatsCache();
    res.status(201).json(order);
  } catch (e) {
    console.error("[orders] POST /api/orders failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/** JWT secret for short-lived headless PDF worker tokens (defaults to JWT_SECRET). */
function orderPdfJwtSecret() {
  return String(process.env.ORDER_CARD_PDF_JWT_SECRET || process.env.JWT_SECRET || "").trim();
}

/**
 * Used only by the storefront worker page (Puppeteer) to load order rows for full-card PDF generation.
 * Query: token (JWT: typ order-card-pdf, orderId, purpose email-admin | email-customer | admin-download).
 * Response: { pdfItemRows, pdfExport? } — omit pdfExport for admin-download so the worker matches in-app PDF sizing.
 */
app.get("/api/orders/internal/order-items-for-pdf", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not configured" });
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });
    const secret = orderPdfJwtSecret();
    if (!secret) return res.status(503).json({ error: "JWT secret not configured" });
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    if (payload.typ !== "order-card-pdf" || !payload.orderId) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const purpose =
      payload.purpose === "email-customer"
        ? "email-customer"
        : payload.purpose === "admin-download"
          ? "admin-download"
          : "email-admin";
    const order = await Order.findById(payload.orderId).select("items").lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (purpose === "email-customer") {
      const { pdfItemRows } = filterItemsForCustomerEmailCardPdf(order.items || []);
      return res.json({
        pdfItemRows,
        pdfExport: { layout: "email-customer" },
      });
    }
    if (purpose === "admin-download") {
      const { captureItemRows } = filterDesignedItemsForCardCapture(order.items || []);
      const pdfItemRows = captureItemRows.map((r) => ({
        item: r.item,
        nominalInches: { w: 2.5, h: 3.5 },
      }));
      return res.json({ pdfItemRows });
    }
    const { pdfItemRows } = filterItemsForAdminEmailCardPdf(order.items || []);
    return res.json({
      pdfItemRows,
      pdfExport: { layout: "email-admin" },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Storefront worker `/__order-card-capture` (Puppeteer): JWT typ `order-card-capture`, same secret as PDF worker.
 * Response: `{ captureItemRows: [{ item }] }` — one row per cart line with a non-empty design snapshot.
 */
app.get("/api/orders/internal/order-items-for-capture", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not configured" });
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });
    const secret = orderPdfJwtSecret();
    if (!secret) return res.status(503).json({ error: "JWT secret not configured" });
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    if (payload.typ !== "order-card-capture" || !payload.orderId) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const order = await Order.findById(payload.orderId).select("items").lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    const { captureItemRows } = filterDesignedItemsForCardCapture(order.items || []);
    try {
      const debugRows = captureItemRows.map((r, idx) => {
        const snap = r?.item?.designSnapshot && typeof r.item.designSnapshot === "object" ? r.item.designSnapshot : {};
        const keys = Object.keys(snap || {});
        const backImageKeys = keys.filter((k) => /^back[_-]?image[_-]?\d+$/i.test(k) || /back.*image/i.test(k));
        return {
          lineIndex: idx,
          templateId: r?.item?.templateId,
          keyCount: keys.length,
          backImageKeys,
        };
      });
      console.info("[order-items-for-capture] debug", {
        orderId: String(payload.orderId),
        rows: debugRows,
      });
    } catch (e) {
      console.warn("[order-items-for-capture] debug logging failed:", e?.message || e);
    }
    res.json({ captureItemRows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Stripe checkout (create session, confirm) ----------
// Checkout client uploads must live under /api/orders so nginx/proxies that route `/api/orders` reach Node (many setups skip `/api/admin`).
registerCheckoutDesignUpload(app);
app.use("/api/orders", stripeRouter);

// ---------- Customer (store) auth: login, register, orders ----------
app.use("/api/user", userAuthRouter);

// NOTE: app.use("/api/admin", adminAuthRouter) is registered AFTER all explicit /api/admin/* routes
// so GET /api/admin/customers (and similar) are not swallowed by the sub-router (which only defines /login and /seed-admin).

// ---------- Admin: Seed default categories (URL-style ids) ----------
app.post("/api/admin/categories/seed-defaults", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      for (const c of DEFAULT_CATEGORIES) {
        await upsertCategory(c);
      }
      for (const s of DEFAULT_SUBCATEGORIES) {
        await upsertSubcategory(s);
      }
      return res.json({ ok: true, message: "Categories and subcategories seeded." });
    }
    res.status(503).json({ error: "Database not connected" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Categories CRUD ----------
app.post("/api/admin/categories", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const { id, name, order } = req.body || {};
    if (!id || !String(id).trim() || !name || !String(name).trim()) {
      return res.status(400).json({ error: "id and name required" });
    }
    const ok = await upsertCategory({ id: String(id).trim(), name: String(name).trim(), order: Number(order) || 0 });
    if (!ok) return res.status(400).json({ error: "Invalid category" });
    const list = await listCategories();
    res.status(201).json(list.find((c) => c.id === String(id).trim()) || { id: String(id).trim(), name: String(name).trim(), order: Number(order) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/categories/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing category id" });
    const existing = await getCategoryById(id);
    if (!existing) return res.status(404).json({ error: "Category not found" });
    const { name, order } = req.body || {};
    const merged = {
      id,
      name: name != null ? String(name).trim() : (existing.name || id),
      order: order != null ? Number(order) : (existing.order ?? 0),
    };
    const ok = await upsertCategory(merged);
    if (!ok) return res.status(400).json({ error: "Invalid category" });
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/categories/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing category id" });
    const ok = await deleteCategoryById(id);
    if (!ok) return res.status(404).json({ error: "Category not found" });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Subcategories CRUD ----------
app.post("/api/admin/subcategories", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const { id, name, categoryId, order } = req.body || {};
    if (!id || !String(id).trim() || !name || !String(name).trim() || !categoryId || !String(categoryId).trim()) {
      return res.status(400).json({ error: "id, name, and categoryId required" });
    }
    const ok = await upsertSubcategory({
      id: String(id).trim(),
      name: String(name).trim(),
      categoryId: String(categoryId).trim(),
      order: Number(order) || 0,
    });
    if (!ok) return res.status(400).json({ error: "Invalid subcategory" });
    const list = await listSubcategories();
    const created = list.find((s) => s.id === String(id).trim()) || { id: String(id).trim(), name: String(name).trim(), categoryId: String(categoryId).trim(), order: Number(order) || 0 };
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/subcategories/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing subcategory id" });
    const existing = await getSubcategoryById(id);
    if (!existing) return res.status(404).json({ error: "Subcategory not found" });
    const { name, categoryId, order } = req.body || {};
    const merged = {
      id,
      name: name != null ? String(name).trim() : (existing.name || id),
      categoryId: categoryId != null ? String(categoryId).trim() : (existing.categoryId || ""),
      order: order != null ? Number(order) : (existing.order ?? 0),
    };
    const ok = await upsertSubcategory(merged);
    if (!ok) return res.status(400).json({ error: "Invalid subcategory" });
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/subcategories/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing subcategory id" });
    const ok = await deleteSubcategoryById(id);
    if (!ok) return res.status(404).json({ error: "Subcategory not found" });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Customers (DB only) ----------
function customerUserToJson(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id?.toString(),
    publicId: resolveCustomerPublicDisplayId(o),
    email: o.email,
    firstName: o.firstName,
    lastName: o.lastName,
    phone: o.phone,
    address: o.address,
    addressLine2: o.addressLine2,
    city: o.city,
    state: o.state,
    zip: o.zip,
    country: o.country,
    isRegistered: Boolean(o.isRegistered),
    avatarImageRef: o.avatarImageRef,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

app.get("/api/admin/customers", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const page = Math.max(1, parseInt(String(firstQueryParam(req.query.page) ?? "1"), 10) || 1);
    const limitRaw = parseInt(String(firstQueryParam(req.query.limit) ?? "20"), 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20));
    const q = req.query.q ? String(req.query.q).trim() : "";
    const skip = (page - 1) * limit;
    const filter = {};
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ email: re }, { firstName: re }, { lastName: re }, { phone: re }, { publicId: re }];
    }
    const [total, docs] = await Promise.all([
      CustomerUser.countDocuments(filter),
      CustomerUser.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    const ids = docs.map((c) => c._id);
    let orderCountById = new Map();
    if (ids.length) {
      const counts = await Order.aggregate([
        { $match: { customerId: { $in: ids } } },
        { $group: { _id: "$customerId", n: { $sum: 1 } } },
      ]);
      orderCountById = new Map(counts.map((x) => [String(x._id), x.n]));
    }
    const customers = docs.map((c) => ({
      ...customerUserToJson(c),
      orderCount: orderCountById.get(String(c._id)) ?? 0,
    }));
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ customers, total, page, limit, totalPages });
  } catch (e) {
    console.error("[admin] GET /api/admin/customers failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/customers/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });
    const doc = await CustomerUser.findById(id).lean();
    if (!doc) return res.status(404).json({ error: "Customer not found" });
    const [orderCount, recentOrders] = await Promise.all([
      Order.countDocuments({ customerId: id }),
      Order.find({ customerId: id })
        .sort({ createdAt: -1 })
        .limit(30)
        .select("status totalCents shippingCents createdAt orderCode")
        .lean(),
    ]);
    return res.json({
      customer: customerUserToJson(doc),
      orderCount,
      recentOrders: recentOrders.map((o) => ({
        id: o._id.toString(),
        orderCode: o.orderCode || undefined,
        status: o.status,
        totalCents: o.totalCents,
        shippingCents: o.shippingCents,
        createdAt: o.createdAt,
      })),
    });
  } catch (e) {
    console.error(`[admin] GET /api/admin/customers/:id failed id=${req.params.id}:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/customers", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const body = req.body || {};
    const p = profileFromBody(body);
    if (!p) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    const existing = await CustomerUser.findOne({ email: p.email });
    if (existing) {
      return res.status(409).json({ error: "A customer with this email already exists" });
    }
    const pass = body.password != null ? String(body.password).trim() : "";
    if (pass && pass.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const payload = {
      email: p.email,
      firstName: p.firstName,
      lastName: p.lastName,
      phone: p.phone,
      address: p.address,
      addressLine2: p.addressLine2,
      city: p.city,
      state: p.state,
      zip: p.zip,
      country: p.country,
      isRegistered: false,
    };
    if (pass) {
      payload.passwordHash = await hashCustomerPassword(pass);
    }
    const created = await CustomerUser.create(payload);
    return res.status(201).json({ customer: customerUserToJson(created) });
  } catch (e) {
    console.error("[admin] POST /api/admin/customers failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/admin/customers/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });
    const u = await CustomerUser.findById(id);
    if (!u) return res.status(404).json({ error: "Customer not found" });
    const body = req.body || {};
    if (body.email !== undefined) {
      const ne = String(body.email).trim().toLowerCase();
      if (!ne) return res.status(400).json({ error: "Email cannot be empty" });
      if (ne !== u.email) {
        const other = await CustomerUser.findOne({ email: ne });
        if (other) return res.status(409).json({ error: "A customer with this email already exists" });
        u.email = ne;
      }
    }
    const str = (k) => (body[k] !== undefined ? (String(body[k]).trim() || undefined) : undefined);
    if (body.firstName !== undefined) u.firstName = str("firstName");
    if (body.lastName !== undefined) u.lastName = str("lastName");
    if (body.phone !== undefined) u.phone = str("phone");
    if (body.address !== undefined) u.address = str("address");
    if (body.addressLine2 !== undefined) u.addressLine2 = str("addressLine2");
    if (body.city !== undefined) u.city = str("city");
    if (body.state !== undefined) u.state = str("state");
    if (body.zip !== undefined) u.zip = str("zip");
    if (body.country !== undefined) u.country = str("country");
    await u.save();
    if (body.password != null && String(body.password).trim() !== "") {
      await setCustomerPasswordById(id, body.password);
    }
    const fresh = await CustomerUser.findById(id).lean();
    return res.json({ customer: customerUserToJson(fresh) });
  } catch (e) {
    console.error(`[admin] PATCH /api/admin/customers/:id failed id=${req.params.id}:`, e?.message || e);
    const status = e.message === "Password must be at least 6 characters" ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.delete("/api/admin/customers/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });
    const u = await CustomerUser.findById(id).lean();
    if (!u) return res.status(404).json({ error: "Customer not found" });
    const n = await Order.countDocuments({ customerId: id });
    if (n > 0) {
      return res.status(409).json({
        error: `This customer has ${n} order(s). Delete or archive orders first, or keep the record.`,
      });
    }
    await CustomerUser.findByIdAndDelete(id);
    return res.status(204).send();
  } catch (e) {
    console.error(`[admin] DELETE /api/admin/customers/:id failed id=${req.params.id}:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * One-time: assign `orderCode` and `publicId` to existing rows. Safe to run multiple times (skips filled fields).
 * POST body: { "confirm": "backfill-public-codes" }
 */
app.post("/api/admin/backfill-public-codes", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    if (String(req.body?.confirm || "").trim() !== "backfill-public-codes") {
      return res.status(400).json({ error: 'Send JSON: { "confirm": "backfill-public-codes" }' });
    }
    const missingOrders = await Order.find({
      $or: [{ orderCode: { $exists: false } }, { orderCode: null }, { orderCode: "" }],
    })
      .select("_id")
      .lean();
    let ordersUpdated = 0;
    for (const row of missingOrders) {
      const code = await ensureUniqueOrderCode(Order);
      await Order.updateOne({ _id: row._id }, { $set: { orderCode: code } });
      ordersUpdated += 1;
    }
    const missingCustomers = await CustomerUser.find({
      $or: [{ publicId: { $exists: false } }, { publicId: null }, { publicId: "" }],
    })
      .select("_id isRegistered")
      .lean();
    let customersUpdated = 0;
    for (const row of missingCustomers) {
      const full = await CustomerUser.findById(row._id).select("+passwordHash isRegistered");
      if (!full) continue;
      const prefix = full.isRegistered || full.passwordHash ? "R" : "G";
      const publicId = await ensureUniqueCustomerPublicId(CustomerUser, prefix, full._id);
      await CustomerUser.updateOne({ _id: full._id }, { $set: { publicId } });
      customersUpdated += 1;
    }
    const needUpgrade = await CustomerUser.find({ publicId: { $regex: /^G/ }, isRegistered: true }).lean();
    let guestIdsUpgradedToRegistered = 0;
    for (const row of needUpgrade) {
      const doc = await CustomerUser.findById(row._id);
      if (!doc || !doc.publicId?.startsWith("G")) continue;
      const tail = doc.publicId.slice(1);
      if (tail.length !== 8) continue;
      const candidate = "R" + tail;
      const taken = await CustomerUser.exists({ publicId: candidate, _id: { $ne: doc._id } });
      if (!taken) {
        doc.publicId = candidate;
        await doc.save();
        guestIdsUpgradedToRegistered += 1;
      }
    }
    return res.json({
      ok: true,
      ordersUpdated,
      customersUpdated,
      guestIdsUpgradedToRegistered,
    });
  } catch (e) {
    console.error("[admin] backfill-public-codes failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Orders (protected when DB) ----------
app.get("/api/admin/orders", maybeRequireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(firstQueryParam(req.query.page) ?? "1"), 10) || 1);
    const limitRaw = parseInt(String(firstQueryParam(req.query.limit) ?? "10"), 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10));
    const status = req.query.status ? String(req.query.status).trim() : "";
    const email = req.query.email ? String(req.query.email).trim() : "";

    if (dbConnected()) {
      const and = [];
      if (status) and.push({ status });
      if (email) {
        const emailRe = new RegExp(escapeRegex(email), "i");
        const matchingUsers = await CustomerUser.find({ email: emailRe }).select("_id").lean();
        const cids = matchingUsers.map((u) => u._id);
        const byPublicId = await CustomerUser.find({ publicId: emailRe }).select("_id").lean();
        const pubCids = byPublicId.map((u) => u._id);
        const or = [{ "customer.email": emailRe }, { orderCode: emailRe }];
        if (cids.length) or.push({ customerId: { $in: cids } });
        if (pubCids.length) or.push({ customerId: { $in: pubCids } });
        and.push({ $or: or });
      }
      const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and };
      const skip = (page - 1) * limit;
      // Exclude `items` (Mixed / large cart+design data). List view only needs summary fields; full line items load on order detail.
      const [total, docs] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter)
          .select("-items")
          .populate({ path: "customerId", select: CUSTOMER_ID_POPULATE_SELECT })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);
      const orders = docs.map((raw) => {
        const o = raw;
        const obj = o;
        const cid = obj.customerId;
        const customerIdOut =
          cid && typeof cid === "object" && cid._id != null
            ? String(cid._id)
            : cid
              ? String(cid)
              : null;
        return {
          ...obj,
          id: obj._id.toString(),
          items: [],
          customer: getOrderCustomerView(obj) || {},
          customerId: customerIdOut,
        };
      });
      const totalPages = Math.max(1, Math.ceil(total / limit));
      console.log("[orders] GET /api/admin/orders", { page, limit, total, status: status || "(all)", hasEmailFilter: Boolean(email) });
      return res.json({ orders, total, page, limit, totalPages });
    }
    const payload = getOrdersPage({
      status: status || undefined,
      email: email || undefined,
      page,
      limit,
    });
    console.log("[orders] GET /api/admin/orders (in-memory)", { page, limit, total: payload.total, status: status || "(all)" });
    return res.json(payload);
  } catch (e) {
    console.error("[orders] GET /api/admin/orders failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/** PDF of embedded design images for printing (same as email attachment). */
app.get("/api/admin/orders/:id/print-pdf", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) {
      console.warn("[orders] GET /api/admin/orders/:id/print-pdf 503: no DB");
      return res.status(503).json({ error: "Database not connected" });
    }
    const order = await Order.findById(req.params.id);
    if (!order) {
      console.warn(`[orders] GET /api/admin/orders/${req.params.id}/print-pdf 404`);
      return res.status(404).json({ error: "Order not found" });
    }
    const buf = await buildOrderPrintPdfBuffer(order);
    const ref = getOrderRef(order);
    console.log(`[orders] print-pdf ok order=${order._id.toString()}`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="order-${ref}-print.pdf"`);
    return res.send(buf);
  } catch (e) {
    console.error(`[orders] print-pdf failed id=${req.params.id}:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/** Zip of card faces (JPEG) via headless Chrome + storefront worker. Requires PUBLIC_APP_URL (or ORDER_CARD_CAPTURE_PAGE_URL) and Puppeteer. */
app.get("/api/admin/orders/:id/card-images.zip", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) {
      console.warn("[orders] GET card-images.zip 503: no DB");
      return res.status(503).json({ error: "Database not connected" });
    }
    const order = await Order.findById(req.params.id).lean();
    if (!order) {
      console.warn(`[orders] GET card-images.zip 404 id=${req.params.id}`);
      return res.status(404).json({ error: "Order not found" });
    }
    const zipResult = await buildOrderCardImagesZipHeadless(order);
    if (!zipResult?.buffer?.length) {
      const { captureItemRows } = filterDesignedItemsForCardCapture(order.items || []);
      if (captureItemRows.length === 0) {
        return res.status(404).json({ error: "No designed card lines to export" });
      }
      return res.status(503).json({
        error:
          "Headless capture unavailable. Set PUBLIC_APP_URL (storefront) and JWT secret; ensure Puppeteer runs on this server. Optional: ORDER_CARD_CAPTURE_PAGE_URL.",
      });
    }
    const ref = getOrderRef(order);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="order-${ref}-card-images.zip"`);
    return res.send(zipResult.buffer);
  } catch (e) {
    console.error(`[orders] card-images.zip failed id=${req.params.id}:`, e?.message || e);
    const msg = augmentPuppeteerLaunchError(e);
    const code =
      /Code:\s*127|shared libraries|libatk-bridge|Failed to launch the browser/i.test(msg) ||
      /Capture page did not signal ready|waitForFunction failed|Navigation timeout/i.test(msg)
        ? 503
        : 500;
    res.status(code).json({ error: msg });
  }
});

/** Full-card PDF (html2canvas + jsPDF inside headless Chrome via /__order-card-pdf). Same layout as admin in-app PDF when headless works. */
app.get("/api/admin/orders/:id/full-card.pdf", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) {
      console.warn("[orders] GET full-card.pdf 503: no DB");
      return res.status(503).json({ error: "Database not connected" });
    }
    const orderLean = await Order.findById(req.params.id).lean();
    if (!orderLean) {
      console.warn(`[orders] GET full-card.pdf 404 id=${req.params.id}`);
      return res.status(404).json({ error: "Order not found" });
    }
    const buf = await buildFullOrderCardPdfBufferHeadless(req.params.id, { purpose: "admin-download" });
    if (!buf?.length) {
      return res.status(503).json({
        error:
          "Headless PDF unavailable. Admin PDF uses the same capture as card-images.zip: set PUBLIC_APP_URL (or ORDER_CARD_CAPTURE_PAGE_URL), JWT_SECRET (or ORDER_CARD_PDF_JWT_SECRET), API_PUBLIC_URL, and Puppeteer on this server.",
      });
    }
    const ref = getOrderRef(orderLean);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="order-${ref}-full-card.pdf"`);
    return res.send(buf);
  } catch (e) {
    console.error(`[orders] full-card.pdf failed id=${req.params.id}:`, e?.message || e);
    const msg = augmentPuppeteerLaunchError(e);
    const code =
      /Code:\s*127|shared libraries|libatk-bridge|Failed to launch the browser/i.test(msg) ||
      /Navigation timeout|waitForFunction|timeout exceeded/i.test(msg)
        ? 503
        : 500;
    res.status(code).json({ error: msg });
  }
});

app.get("/api/admin/orders/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const order = await Order.findById(req.params.id).populate({
        path: "customerId",
        select: CUSTOMER_ID_POPULATE_SELECT,
      });
      if (!order) {
        console.warn(`[orders] GET /api/admin/orders/:id 404 id=${req.params.id}`);
        return res.status(404).json({ error: "Order not found" });
      }
      console.log(`[orders] GET /api/admin/orders/:id ok id=${order._id.toString()} status=${order.status}`);
      return res.json(orderToJson(order));
    }
    const order = getOrderById(req.params.id);
    if (!order) {
      console.warn(`[orders] GET /api/admin/orders/:id 404 (in-memory) id=${req.params.id}`);
      return res.status(404).json({ error: "Order not found" });
    }
    console.log(`[orders] GET /api/admin/orders/:id ok (in-memory) id=${order.id} status=${order.status}`);
    res.json(order);
  } catch (e) {
    console.error(`[orders] GET /api/admin/orders/:id failed id=${req.params.id}:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/admin/orders/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const body = req.body || {};
      const allowed = [
        "status",
        "notes",
        "trackingNumber",
        "trackingCarrier",
        "trackingUrl",
        "customerId",
        "designFixRequestedAt",
        "designFixNote",
        "designFixLastSubmittedAt",
      ];
      const updates = {};
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key];
      }
      /** Resolve customerId: Mongo ObjectId string or explicit null to unlink. */
      if (body.customerId !== undefined) {
        const cid = body.customerId === null || body.customerId === "" ? null : String(body.customerId).trim();
        if (!cid) {
          updates.customerId = null;
        } else if (!mongoose.Types.ObjectId.isValid(cid)) {
          return res.status(400).json({ error: "Invalid customerId" });
        } else {
          const exists = await CustomerUser.exists({ _id: cid });
          if (!exists) return res.status(404).json({ error: "Customer not found" });
          updates.customerId = cid;
        }
      }
      if (body.designFixRequestedAt !== undefined) {
        if (body.designFixRequestedAt === null || body.designFixRequestedAt === "") {
          updates.designFixRequestedAt = null;
        } else {
          const d = new Date(body.designFixRequestedAt);
          if (Number.isNaN(d.getTime())) {
            return res.status(400).json({ error: "Invalid designFixRequestedAt (use ISO date string or null)" });
          }
          updates.designFixRequestedAt = d;
        }
      }
      if (body.designFixNote !== undefined) {
        updates.designFixNote =
          body.designFixNote === null || body.designFixNote === ""
            ? null
            : String(body.designFixNote).trim().slice(0, 4000);
      }
      if (body.designFixLastSubmittedAt !== undefined) {
        if (body.designFixLastSubmittedAt === null || body.designFixLastSubmittedAt === "") {
          updates.designFixLastSubmittedAt = null;
        } else {
          const d = new Date(body.designFixLastSubmittedAt);
          if (Number.isNaN(d.getTime())) {
            return res.status(400).json({ error: "Invalid designFixLastSubmittedAt" });
          }
          updates.designFixLastSubmittedAt = d;
        }
      }
      const prev = await Order.findById(req.params.id);
      if (!prev) {
        console.warn(`[orders] PATCH /api/admin/orders/:id 404 id=${req.params.id}`);
        return res.status(404).json({ error: "Order not found" });
      }
      if (updates.designFixRequestedAt && body.designFixRequestedAt !== null && body.designFixRequestedAt !== "") {
        const effectiveCustomerId =
          updates.customerId !== undefined ? updates.customerId : prev.customerId;
        if (!effectiveCustomerId) {
          return res.status(400).json({
            error:
              "Design fix requires a linked customer account (customerId). Guest-only orders cannot receive this request.",
          });
        }
      }
      const order = await Order.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true }).populate({
        path: "customerId",
        select: CUSTOMER_ID_POPULATE_SELECT,
      });
      if (!order) {
        console.warn(`[orders] PATCH /api/admin/orders/:id 404 after update id=${req.params.id}`);
        return res.status(404).json({ error: "Order not found" });
      }

      if (prev.status !== order.status) {
        if (order.status === "request_review") {
          /** Status-driven review-request workflow: email the customer with links to update their design. */
          sendDesignFixRequestedCustomerEmail(order).catch((err) =>
            console.error("[admin] request-review customer email:", err?.message || err)
          );
        } else {
          sendOrderStatusChangedCustomerEmail(order, prev.status).catch((err) =>
            console.error("[admin] status email:", err?.message || err)
          );
        }
      }
      const prevTrack = String(prev.trackingNumber || "").trim();
      const nextTrack = String(order.trackingNumber || "").trim();
      if (nextTrack && prevTrack !== nextTrack) {
        sendTrackingInfoCustomerEmail(order).catch((err) =>
          console.error("[admin] tracking email:", err?.message || err)
        );
      }

      console.log("[orders] PATCH /api/admin/orders/:id", {
        id: req.params.id,
        statusChange: prev.status !== order.status ? { from: prev.status, to: order.status } : undefined,
        updatedKeys: Object.keys(updates),
      });
      invalidateAdminStatsCache();
      return res.json(orderToJson(order));
    }
    const { status, ...rest } = req.body || {};
    const id = req.params.id;
    const updated = status != null ? updateOrderStatus(id, status) : updateOrder(id, rest);
    if (!updated) {
      console.warn(`[orders] PATCH /api/admin/orders/:id 404 (in-memory) id=${id}`);
      return res.status(404).json({ error: "Order not found" });
    }
    console.log(`[orders] PATCH /api/admin/orders/:id ok (in-memory) id=${id} status=${updated.status}`);
    invalidateAdminStatsCache();
    res.json(updated);
  } catch (e) {
    console.error(`[orders] PATCH /api/admin/orders/:id failed id=${req.params.id}:`, e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/** Delete every order (admin only). Requires JSON body: { "confirm": "delete-all-orders" }. */
app.delete("/api/admin/orders", maybeRequireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (String(body.confirm || "").trim() !== "delete-all-orders") {
      console.warn("[orders] DELETE /api/admin/orders 400: confirm string missing/wrong");
      return res.status(400).json({
        error: 'Send JSON body: { "confirm": "delete-all-orders" }',
      });
    }
    if (dbConnected()) {
      const result = await Order.deleteMany({});
      const n = result.deletedCount ?? 0;
      console.warn(`[orders] DELETE /api/admin/orders (all) deletedCount=${n}`);
      invalidateAdminStatsCache();
      return res.json({ deletedCount: n });
    }
    const n = deleteAllOrders();
    console.warn(`[orders] DELETE /api/admin/orders (all, in-memory) deletedCount=${n}`);
    invalidateAdminStatsCache();
    return res.json({ deletedCount: n });
  } catch (e) {
    console.error("[orders] DELETE /api/admin/orders failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/orders/:id", maybeRequireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) {
      console.warn("[orders] DELETE /api/admin/orders/:id 400: missing id");
      return res.status(400).json({ error: "Missing order id" });
    }
    if (dbConnected()) {
      const deleted = await Order.findByIdAndDelete(id);
      if (!deleted) {
        console.warn(`[orders] DELETE /api/admin/orders/:id 404 id=${id}`);
        return res.status(404).json({ error: "Order not found" });
      }
      console.log(`[orders] DELETE /api/admin/orders/:id ok id=${id}`);
      invalidateAdminStatsCache();
      return res.status(204).send();
    }
    if (!deleteOrderById(id)) {
      console.warn(`[orders] DELETE /api/admin/orders/:id 404 (in-memory) id=${id}`);
      return res.status(404).json({ error: "Order not found" });
    }
    console.log(`[orders] DELETE /api/admin/orders/:id ok (in-memory) id=${id}`);
    invalidateAdminStatsCache();
    return res.status(204).send();
  } catch (e) {
    const msg = e?.message || String(e);
    if (e?.name === "CastError" || /Cast to ObjectId failed/i.test(msg)) {
      console.warn(`[orders] DELETE /api/admin/orders/:id 400: invalid id id=${req.params.id}`);
      return res.status(400).json({ error: "Invalid order id" });
    }
    console.error(`[orders] DELETE /api/admin/orders/:id failed id=${req.params.id}:`, msg);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/admin/order-statuses", (req, res) => {
  res.json(dbConnected() ? ORDER_STATUSES_WITH_PAYMENT : ORDER_STATUSES);
});

// ---------- Admin: Dashboard stats (protected when DB) ----------
app.get("/api/admin/stats", maybeRequireAdmin, async (req, res) => {
  try {
    const cached = getCachedAdminStats();
    if (cached) {
      res.setHeader("X-Admin-Stats-Cache", "hit");
      return res.json(cached);
    }
    const paidStatuses = ["confirmed", "in_production", "shipped", "delivered"];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (dbConnected()) {
      const [
        totalOrders,
        byStatus,
        revenueResult,
        ordersLast7DaysAgg,
        paidOrderCount,
        revenueLast7DaysAgg,
        totalTemplates,
        categoriesCount,
        subcategoriesCount,
      ] = await Promise.all([
        Order.countDocuments(),
        Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
        Order.aggregate([
          { $match: { status: { $in: paidStatuses } } },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $subtract: [
                    { $add: ["$totalCents", { $ifNull: ["$shippingCents", 0] }, { $ifNull: ["$taxCents", 0] }] },
                    { $ifNull: ["$discountCents", 0] },
                  ],
                },
              },
            },
          },
        ]),
        Order.aggregate([
          { $match: { createdAt: { $gte: sevenDaysAgo } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Order.countDocuments({ status: { $in: paidStatuses } }),
        Order.aggregate([
          {
            $match: {
              createdAt: { $gte: sevenDaysAgo },
              status: { $in: paidStatuses },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              revenueCents: {
                $sum: {
                  $subtract: [
                    { $add: ["$totalCents", { $ifNull: ["$shippingCents", 0] }, { $ifNull: ["$taxCents", 0] }] },
                    { $ifNull: ["$discountCents", 0] },
                  ],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Template.countDocuments(),
        Category.countDocuments(),
        Subcategory.countDocuments(),
      ]);
      const ordersByStatus = {};
      byStatus.forEach((x) => { ordersByStatus[x._id] = x.count; });
      const totalRevenueCents = revenueResult[0]?.total ?? 0;
      const avgOrderValueCents =
        paidOrderCount > 0 ? Math.round(totalRevenueCents / paidOrderCount) : 0;
      const last7Days = [];
      const revenueLast7Days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const found = ordersLast7DaysAgg.find((x) => x._id === dateStr);
        last7Days.push({ date: dateStr, count: found ? found.count : 0 });
        const revFound = revenueLast7DaysAgg.find((x) => x._id === dateStr);
        revenueLast7Days.push({ date: dateStr, revenueCents: revFound ? revFound.revenueCents : 0 });
      }
      const body = {
        totalOrders,
        ordersByStatus,
        totalRevenueCents,
        ordersLast7Days: last7Days,
        revenueLast7Days,
        paidOrderCount,
        avgOrderValueCents,
        totalTemplates,
        categoriesCount,
        subcategoriesCount,
      };
      setCachedAdminStats(body);
      res.setHeader("X-Admin-Stats-Cache", "miss");
      return res.json(body);
    }
    const list = getAllOrders();
    const totalOrders = list.length;
    const ordersByStatus = {};
    list.forEach((o) => { ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1; });
    let totalRevenueCents = 0;
    list.forEach((o) => {
      if (paidStatuses.includes(o.status)) {
        totalRevenueCents +=
          (o.totalCents || 0) + (o.shippingCents || 0) + (o.taxCents || 0) - (o.discountCents || 0);
      }
    });
    const paidOrderCount = list.filter((o) => paidStatuses.includes(o.status)).length;
    const avgOrderValueCents =
      paidOrderCount > 0 ? Math.round(totalRevenueCents / paidOrderCount) : 0;
    const ordersLast7DaysList = [];
    const revenueLast7DaysList = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = list.filter((o) => o.createdAt && o.createdAt.startsWith(dateStr)).length;
      ordersLast7DaysList.push({ date: dateStr, count });
      let rev = 0;
      list.forEach((o) => {
        if (!paidStatuses.includes(o.status) || !o.createdAt || !o.createdAt.startsWith(dateStr)) return;
        rev += (o.totalCents || 0) + (o.shippingCents || 0) + (o.taxCents || 0) - (o.discountCents || 0);
      });
      revenueLast7DaysList.push({ date: dateStr, revenueCents: rev });
    }
    const bodyNoDb = {
      totalOrders,
      ordersByStatus,
      totalRevenueCents,
      ordersLast7Days: ordersLast7DaysList,
      revenueLast7Days: revenueLast7DaysList,
      paidOrderCount,
      avgOrderValueCents,
      totalTemplates: 0,
      categoriesCount: 0,
      subcategoriesCount: 0,
    };
    setCachedAdminStats(bodyNoDb);
    res.setHeader("X-Admin-Stats-Cache", "miss");
    return res.json(bodyNoDb);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Prices (protected when DB) ----------
app.get("/api/admin/prices", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const config = await getPriceConfig();
      return res.json(config);
    }
    res.json(getPrices());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/prices", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const updated = await setPriceConfig(req.body || {});
      return res.json(updated);
    }
    const updated = setPrices(req.body || {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Blog posts (DB) — admin CRUD; public list/read for storefront ----------
function slugifyBlogTitle(title) {
  const base = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "post";
}

async function ensureUniqueBlogSlug(slugInput, excludeMongoId) {
  const base = slugifyBlogTitle(slugInput);
  let candidate = base;
  let n = 2;
  for (;;) {
    const q = { slug: candidate };
    if (excludeMongoId) q._id = { $ne: excludeMongoId };
    const exists = await BlogPost.exists(q);
    if (!exists) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

function normalizeBlogFaqs(input) {
  if (!input || !Array.isArray(input)) return [];
  const out = [];
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const question = row.question != null ? String(row.question).trim() : "";
    const answer = row.answer != null ? String(row.answer).trim() : "";
    if (!question && !answer) continue;
    out.push({
      question: question.slice(0, 500),
      answer: answer.slice(0, 8000),
    });
  }
  return out.slice(0, 80);
}

function blogPostToJson(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const faqsRaw = o.faqs;
  const faqs = Array.isArray(faqsRaw)
    ? faqsRaw.map((f) => ({
        question: f?.question != null ? String(f.question) : "",
        answer: f?.answer != null ? String(f.answer) : "",
      }))
    : [];
  return {
    id: o._id?.toString() ?? o.id,
    title: o.title,
    slug: o.slug,
    excerpt: o.excerpt ?? "",
    contentHtml: o.contentHtml ?? "",
    published: Boolean(o.published),
    publishedAt: o.publishedAt,
    metaTitle: o.metaTitle ?? "",
    metaDescription: o.metaDescription ?? "",
    canonicalUrl: o.canonicalUrl ?? "",
    ogTitle: o.ogTitle ?? "",
    ogDescription: o.ogDescription ?? "",
    ogImageId: o.ogImageId ?? "",
    authorName: o.authorName ?? "",
    featuredImageId: o.featuredImageId ?? "",
    faqs,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function blogPostAdminSaveErrorResponse(e) {
  const code = e?.code;
  if (code === 11000) {
    return { status: 409, message: "A post with this URL slug already exists. Change the slug and try again." };
  }
  const msg = e?.message ? String(e.message) : "Save failed";
  return { status: 500, message: msg };
}

function trimBlogString(v, maxLen) {
  const s = v != null ? String(v).trim() : "";
  if (!maxLen || s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

/** Published posts for the public blog (optional storefront use). */
app.get("/api/blog/posts", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const list = await BlogPost.find({ published: true })
      .sort({ publishedAt: -1, updatedAt: -1 })
      .select("title slug excerpt published publishedAt updatedAt createdAt metaTitle metaDescription featuredImageId")
      .lean();
    const out = list.map((row) => ({
      ...row,
      id: row._id?.toString(),
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Published blog post by slug or null */
async function getPublishedBlogPostIdBySlug(slug) {
  const s = String(slug || "").trim();
  if (!s) return null;
  const doc = await BlogPost.findOne({ slug: s, published: true }).select("_id").lean();
  return doc || null;
}

app.get("/api/blog/posts/:slug/comments", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    const post = await getPublishedBlogPostIdBySlug(slug);
    if (!post) return res.status(404).json({ error: "Not found" });

    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = Math.max(0, parseInt(String(req.query.skip || "0"), 10) || 0);

    const [total, docs] = await Promise.all([
      BlogComment.countDocuments({ blogPost: post._id }),
      BlogComment.find({ blogPost: post._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("authorId", "firstName lastName")
        .lean(),
    ]);

    const customerId = req.customerUser?._id ? String(req.customerUser._id) : null;

    const comments = docs.map((c) => {
      const aid = c.authorId;
      const authorMongoId =
        aid && typeof aid === "object" && aid._id != null
          ? String(aid._id)
          : aid
            ? String(aid)
            : "";
      const firstName = aid && typeof aid === "object" ? aid.firstName : "";
      const lastName = aid && typeof aid === "object" ? aid.lastName : "";
      const displayName = [firstName, lastName].filter(Boolean).join(" ").trim() || "Member";
      const isMine = Boolean(customerId && authorMongoId && customerId === authorMongoId);
      return {
        id: c._id?.toString(),
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        author: { displayName, id: authorMongoId },
        isMine,
      };
    });

    res.json({ comments, total, skip, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/blog/posts/:slug/comments", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    const post = await getPublishedBlogPostIdBySlug(slug);
    if (!post) return res.status(404).json({ error: "Not found" });

    const raw = req.body?.body != null ? String(req.body.body) : "";
    const body = raw.trim();
    if (!body) return res.status(400).json({ error: "Comment cannot be empty" });
    if (body.length > 2000) return res.status(400).json({ error: "Comment is too long" });

    const doc = await BlogComment.create({
      blogPost: post._id,
      authorId: req.customerUser._id,
      body,
    });
    await doc.populate("authorId", "firstName lastName");
    const aid = doc.authorId;
    const displayName =
      [aid?.firstName, aid?.lastName].filter(Boolean).join(" ").trim() || "Member";
    res.status(201).json({
      id: doc._id.toString(),
      body: doc.body,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      author: { displayName, id: String(req.customerUser._id) },
      isMine: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/blog/posts/:slug/comments/:commentId", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    const commentId = String(req.params.commentId || "").trim();
    if (!slug || !commentId) return res.status(400).json({ error: "Invalid request" });
    if (!mongoose.Types.ObjectId.isValid(commentId)) return res.status(400).json({ error: "Invalid comment id" });

    const post = await getPublishedBlogPostIdBySlug(slug);
    if (!post) return res.status(404).json({ error: "Not found" });

    const c = await BlogComment.findOne({ _id: commentId, blogPost: post._id });
    if (!c) return res.status(404).json({ error: "Not found" });
    if (String(c.authorId) !== String(req.customerUser._id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await BlogComment.deleteOne({ _id: c._id });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/blog/posts/:slug/likes", optionalCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    const post = await getPublishedBlogPostIdBySlug(slug);
    if (!post) return res.status(404).json({ error: "Not found" });

    const [count, likedRow] = await Promise.all([
      BlogLike.countDocuments({ blogPost: post._id }),
      req.customerUser
        ? BlogLike.findOne({ blogPost: post._id, userId: req.customerUser._id }).select("_id").lean()
        : Promise.resolve(null),
    ]);

    res.json({
      count,
      likedByMe: Boolean(likedRow),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/blog/posts/:slug/likes/toggle", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    const post = await getPublishedBlogPostIdBySlug(slug);
    if (!post) return res.status(404).json({ error: "Not found" });

    const existing = await BlogLike.findOne({ blogPost: post._id, userId: req.customerUser._id });
    let liked;
    if (existing) {
      await BlogLike.deleteOne({ _id: existing._id });
      liked = false;
    } else {
      await BlogLike.create({ blogPost: post._id, userId: req.customerUser._id });
      liked = true;
    }

    const count = await BlogLike.countDocuments({ blogPost: post._id });
    res.json({ liked, count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/blog/posts/:slug", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });
    const doc = await BlogPost.findOne({ slug, published: true }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({
      ...doc,
      id: doc._id?.toString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/blog-posts", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const list = await BlogPost.find({}).sort({ updatedAt: -1 }).lean();
    res.json(list.map((row) => blogPostToJson(row)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/blog-posts/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const doc = await BlogPost.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(blogPostToJson(doc));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/blog-posts", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const body = req.body || {};
    const title = body.title != null ? String(body.title).trim() : "";
    if (!title) return res.status(400).json({ error: "title required" });
    const slugSource = body.slug != null && String(body.slug).trim() ? String(body.slug).trim() : title;
    const slug = await ensureUniqueBlogSlug(slugSource);
    const published = Boolean(body.published);
    const publishedAt =
      published ? (body.publishedAt ? new Date(body.publishedAt) : new Date()) : undefined;
    const doc = await BlogPost.create({
      title,
      slug,
      excerpt: body.excerpt != null ? String(body.excerpt) : "",
      contentHtml: body.contentHtml != null ? String(body.contentHtml) : "",
      published,
      publishedAt,
      metaTitle: trimBlogString(body.metaTitle, 200),
      metaDescription: trimBlogString(body.metaDescription, 500),
      canonicalUrl: trimBlogString(body.canonicalUrl, 2000),
      ogTitle: trimBlogString(body.ogTitle, 200),
      ogDescription: trimBlogString(body.ogDescription, 500),
      ogImageId: trimBlogString(body.ogImageId, 120),
      authorName: trimBlogString(body.authorName, 200),
      featuredImageId: trimBlogString(body.featuredImageId, 120),
      faqs: normalizeBlogFaqs(body.faqs),
    });
    res.status(201).json(blogPostToJson(doc));
  } catch (e) {
    const { status, message } = blogPostAdminSaveErrorResponse(e);
    res.status(status).json({ error: message });
  }
});

app.put("/api/admin/blog-posts/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const doc = await BlogPost.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const body = req.body || {};
    if (body.title !== undefined) doc.title = String(body.title).trim();
    if (body.excerpt !== undefined) doc.excerpt = String(body.excerpt);
    if (body.contentHtml !== undefined) doc.contentHtml = String(body.contentHtml);
    if (body.metaTitle !== undefined) doc.metaTitle = trimBlogString(body.metaTitle, 200);
    if (body.metaDescription !== undefined) doc.metaDescription = trimBlogString(body.metaDescription, 500);
    if (body.canonicalUrl !== undefined) doc.canonicalUrl = trimBlogString(body.canonicalUrl, 2000);
    if (body.ogTitle !== undefined) doc.ogTitle = trimBlogString(body.ogTitle, 200);
    if (body.ogDescription !== undefined) doc.ogDescription = trimBlogString(body.ogDescription, 500);
    if (body.ogImageId !== undefined) doc.ogImageId = trimBlogString(body.ogImageId, 120);
    if (body.authorName !== undefined) doc.authorName = trimBlogString(body.authorName, 200);
    if (body.featuredImageId !== undefined) doc.featuredImageId = trimBlogString(body.featuredImageId, 120);
    if (body.slug !== undefined) {
      const next = await ensureUniqueBlogSlug(String(body.slug).trim() || doc.title, doc._id);
      doc.slug = next;
    }
    if (body.published !== undefined) {
      const nextPub = Boolean(body.published);
      doc.published = nextPub;
      if (nextPub && !doc.publishedAt) doc.publishedAt = new Date();
      if (!nextPub) doc.publishedAt = undefined;
    }
    if (body.publishedAt !== undefined && doc.published) {
      doc.publishedAt = body.publishedAt ? new Date(body.publishedAt) : new Date();
    }
    if (body.faqs !== undefined) {
      doc.faqs = normalizeBlogFaqs(body.faqs);
    }
    await doc.save();
    res.json(blogPostToJson(doc));
  } catch (e) {
    const { status, message } = blogPostAdminSaveErrorResponse(e);
    res.status(status).json({ error: message });
  }
});

app.delete("/api/admin/blog-posts/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const deleted = await BlogPost.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Upsert the four legacy featured blogs (same slugs as storefront routes) so /api/blog/posts lists them. */
app.post("/api/admin/blog-posts/seed-featured", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    if (String(req.body?.confirm || "").trim() !== "seed-featured-blogs") {
      return res.status(400).json({
        error: 'Send JSON: { "confirm": "seed-featured-blogs" }',
      });
    }
    const now = new Date();
    let count = 0;
    for (const row of FEATURED_BLOG_SEEDS) {
      await BlogPost.findOneAndUpdate(
        { slug: row.slug },
        {
          $set: {
            slug: row.slug,
            title: row.title,
            excerpt: row.excerpt,
            contentHtml: seedContentHtml(row.excerpt),
            published: true,
            publishedAt: now,
            metaTitle: row.title,
            metaDescription: row.excerpt,
          },
        },
        { upsert: true, new: true }
      );
      count += 1;
    }
    res.json({ ok: true, seeded: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Contact form ----------
function contactSubmissionToJson(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id?.toString() ?? o.id,
    firstName: o.firstName ?? "",
    lastName: o.lastName ?? "",
    phone: o.phone ?? "",
    email: o.email ?? "",
    message: o.message ?? "",
    read: Boolean(o.read),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function isValidContactEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post("/api/contact", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const body = req.body || {};
    const firstName = body.firstName != null ? String(body.firstName).trim() : "";
    const lastName = body.lastName != null ? String(body.lastName).trim() : "";
    const phone = body.phone != null ? String(body.phone).trim() : "";
    const email = body.email != null ? String(body.email).trim().toLowerCase() : "";
    const message = body.message != null ? String(body.message).trim() : "";

    if (!firstName) return res.status(400).json({ error: "First name is required" });
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!isValidContactEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });
    if (!message) return res.status(400).json({ error: "Message is required" });
    if (message.length > 10000) return res.status(400).json({ error: "Message is too long" });

    const doc = await ContactSubmission.create({
      firstName: firstName.slice(0, 120),
      lastName: lastName.slice(0, 120),
      phone: phone.slice(0, 40),
      email: email.slice(0, 320),
      message: message.slice(0, 10000),
    });

    emitAdminNotification({
      kind: "contact_submission",
      contactId: doc._id.toString(),
      email: doc.email,
    });

    res.status(201).json({ ok: true, id: doc._id.toString() });
  } catch (e) {
    console.error("[contact] POST /api/contact failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin: Contact submissions ----------
app.get("/api/admin/contact-submissions", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const page = Math.max(1, parseInt(String(firstQueryParam(req.query.page) ?? "1"), 10) || 1);
    const limitRaw = parseInt(String(firstQueryParam(req.query.limit) ?? "20"), 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20));
    const q = req.query.q ? String(req.query.q).trim() : "";
    const unreadOnly = String(firstQueryParam(req.query.unread) ?? "").trim() === "1";
    const skip = (page - 1) * limit;
    const filter = {};
    if (unreadOnly) filter.read = false;
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ email: re }, { firstName: re }, { lastName: re }, { phone: re }, { message: re }];
    }
    const [total, docs] = await Promise.all([
      ContactSubmission.countDocuments(filter),
      ContactSubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    const submissions = docs.map((row) => contactSubmissionToJson(row));
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ submissions, total, page, limit, totalPages });
  } catch (e) {
    console.error("[admin] GET /api/admin/contact-submissions failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/contact-submissions/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    const doc = await ContactSubmission.findById(id).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    return res.json(contactSubmissionToJson(doc));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/admin/contact-submissions/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    const doc = await ContactSubmission.findById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (req.body?.read !== undefined) doc.read = Boolean(req.body.read);
    await doc.save();
    return res.json(contactSubmissionToJson(doc));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/contact-submissions/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const id = (req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    const deleted = await ContactSubmission.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    return res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin auth (no auth middleware) — after other /api/admin/* so those routes match first ----------
app.use("/api/admin", adminAuthRouter);

// ---------- Health ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: dbConnected() });
});

// Register uploads + static SPA only after all /api routes so DELETE/PUT/POST handlers always match.
registerUploadsRouter(app);

/** robots.txt / sitemap.xml: Vite emits these into frontend `dist`, but the API often serves from `cwd`/dist only — explicit lookup avoids SPA fallback returning HTML. Optional: PUBLIC_SEO_DIR=absolute/path/to/folder containing both files. */
function seoFileCandidateDirs() {
  const extra = process.env.PUBLIC_SEO_DIR && String(process.env.PUBLIC_SEO_DIR).trim();
  const base = [
    extra || null,
    path.join(process.cwd(), "dist"),
    path.join(__dirname, "..", "sports-cards-frontend", "dist"),
    path.join(__dirname, "..", "sports-cards-frontend", "public"),
    path.join(process.cwd(), "..", "sports-cards-frontend", "dist"),
    path.join(process.cwd(), "..", "sports-cards-frontend", "public"),
  ].filter(Boolean);
  return [...new Set(base)];
}

async function sendSeoPublicFile(res, filename, contentType) {
  for (const dir of seoFileCandidateDirs()) {
    const fp = path.join(dir, filename);
    try {
      await fs.access(fp);
      const buf = await fs.readFile(fp);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).send(buf);
    } catch {
      /* try next */
    }
  }
  return false;
}

app.get("/robots.txt", async (req, res) => {
  const ok = await sendSeoPublicFile(res, "robots.txt", "text/plain; charset=utf-8");
  if (!ok) res.status(404).type("text/plain").send("robots.txt not found on server");
});

/**
 * Sitemaps (Yoast-style): `/sitemap.xml` is a sitemap index pointing to four URL sitemaps below.
 * Submit `https://<site>/sitemap.xml` to Google Search Console; the others are discovered automatically.
 * URLs render against `PUBLIC_APP_URL` so they always look like the canonical storefront origin even when
 * Vercel proxies these paths to the API. Each route is cached briefly so crawlers/CDNs don't re-render
 * the XML for every hit, but the TTL is short enough that newly published content is picked up quickly.
 */
function sendSitemapXml(res, xml, { maxAgeSeconds = 600 } = {}) {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`);
  res.status(200).send(xml);
}

function handleSitemapError(res, e) {
  if (!dbConnected()) return res.status(503).type("text/plain").send("Database not connected");
  return res.status(500).type("text/plain").send(e?.message || "Sitemap generation failed");
}

app.get("/sitemap.xml", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).type("text/plain").send("Database not connected");
    const xml = await buildSitemapIndex(resolvePublicBaseUrl(req));
    sendSitemapXml(res, xml);
  } catch (e) {
    handleSitemapError(res, e);
  }
});

app.get("/page-sitemap.xml", (req, res) => {
  try {
    const xml = buildPageSitemap(resolvePublicBaseUrl(req));
    sendSitemapXml(res, xml, { maxAgeSeconds: 3600 });
  } catch (e) {
    handleSitemapError(res, e);
  }
});

app.get("/product-sitemap.xml", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).type("text/plain").send("Database not connected");
    const xml = await buildProductSitemap(resolvePublicBaseUrl(req));
    sendSitemapXml(res, xml);
  } catch (e) {
    handleSitemapError(res, e);
  }
});

app.get("/category-sitemap.xml", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).type("text/plain").send("Database not connected");
    const xml = await buildCategorySitemap(resolvePublicBaseUrl(req));
    sendSitemapXml(res, xml);
  } catch (e) {
    handleSitemapError(res, e);
  }
});

app.get("/post-sitemap.xml", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).type("text/plain").send("Database not connected");
    const xml = await buildPostSitemap(resolvePublicBaseUrl(req));
    sendSitemapXml(res, xml);
  } catch (e) {
    handleSitemapError(res, e);
  }
});

// Serve built frontend (dist) so the app loads when opening the server URL (e.g. after npm run build).
const distDir = path.join(process.cwd(), "dist");
app.use(express.static(distDir, { index: false }));

app.get("/", async (req, res) => {
  try {
    // Prefer built SPA so /assets/* and index work
    const distHtml = path.join(distDir, "index.html");
    try {
      await fs.access(distHtml);
      const html = await fs.readFile(distHtml, "utf-8");
      return res.send(html);
    } catch {
      // No build yet: serve root index.html (only works when using Vite dev server for assets)
    }
    const html = await fs.readFile(path.join(process.cwd(), "index.html"), "utf-8");
    res.send(html);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// SPA fallback: non-API GET requests serve index so client-side routes work
app.get("*", async (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  try {
    const distHtml = path.join(distDir, "index.html");
    await fs.access(distHtml);
    const html = await fs.readFile(distHtml, "utf-8");
    return res.send(html);
  } catch {
    try {
      const html = await fs.readFile(path.join(process.cwd(), "index.html"), "utf-8");
      return res.send(html);
    } catch {
      next();
    }
  }
});

/** On server start only: create default admin (admin@admin.com / admin123) if no admin exists in DB. */
async function seedAdminIfNeeded() {
  if (!dbConnected()) return;
  try {
    const count = await AdminUser.countDocuments();
    if (count > 0) return;
    const passwordHash = await hashPassword("admin123");
    await AdminUser.create({ email: "admin@admin.com", passwordHash });
    console.log("Default admin created (first run): admin@admin.com / admin123");
  } catch (err) {
    console.error("Seed admin failed:", err.message);
  }
}

// Start
(async () => {
  try {
    await connectDB();
    await seedAdminIfNeeded();
  } catch (err) {
    console.error("DB connect failed:", err.message);
  }
  const server = http.createServer(app);
  initAdminSocket(server);
  server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
})();
