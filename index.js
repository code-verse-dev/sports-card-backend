import "./load-env.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { connectDB, dbConnected } from "./db.js";
import { requireAdmin } from "./middleware/auth.js";
import adminAuthRouter from "./routes/adminAuth.js";
import userAuthRouter from "./routes/userAuth.js";
import stripeRouter from "./routes/stripe.js";
import { registerUploadsRouter } from "./uploads-router.js";
import { listCategories, listSubcategories, upsertCategory, upsertSubcategory } from "./categories-db.js";
import { DEFAULT_CATEGORIES, DEFAULT_SUBCATEGORIES } from "./seed-categories.js";
import {
  getAllOrders,
  getOrderById,
  createOrder,
  updateOrderStatus,
  updateOrder,
  ORDER_STATUSES,
} from "./store/orders.js";
import { getPrices, setPrices } from "./store/prices.js";
import { Order } from "./models/Order.js";
import { Template } from "./models/Template.js";
import { getPriceConfig, setPriceConfig } from "./models/PriceConfig.js";
import { AdminUser, hashPassword } from "./models/AdminUser.js";

const app = express();
const PORT = Number(process.env.PORT) || 4043;
const HOST = (process.env.HOST && String(process.env.HOST).trim() && process.env.HOST !== "null") ? process.env.HOST.trim() : "0.0.0.0";

app.use(cors({ origin: true, credentials: true, allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "10mb" }));

// ----- Helpers when using DB -----
function orderToJson(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id?.toString() ?? o.id,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    stripeSessionId: o.stripeSessionId,
    customer: o.customer,
    items: o.items,
    totalCents: o.totalCents,
    shippingCents: o.shippingCents,
    notes: o.notes,
    createAccount: o.createAccount,
  };
}

const ORDER_STATUSES_WITH_PAYMENT = [...new Set([...ORDER_STATUSES, "pending_payment"])];

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
    const list = await Template.find(filter).lean();
    const withId = list.map((doc) => ({ ...doc, id: (doc.id && String(doc.id).trim()) || (doc.templateId && String(doc.templateId).trim()) || doc._id?.toString() }));
    return res.json(withId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/templates/:idOrSlug – accepts full id, templateId, legacyIds, or slug (last segment).
// Frontend uses slug-only in URLs; backend resolves slug to template so frontend never needs to send internal id.
app.get("/api/templates/:idOrSlug", async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Database not connected" });
    const param = (req.params.idOrSlug || "").trim();
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
      doc = await Template.findOne({
        $or: [
          { id: new RegExp(`/${param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
          { templateId: new RegExp(`/${param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
        ],
      }).lean();
    }
    if (!doc) return res.status(404).json({ error: "Template not found" });
    const id = (doc.id && String(doc.id).trim()) || (doc.templateId && String(doc.templateId).trim()) || doc._id?.toString();
    res.json({ ...doc, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

registerUploadsRouter(app);

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

// SPA fallback: non-API GET requests serve index so client-side routes work (when using dist)
app.get("*", async (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  try {
    const distHtml = path.join(distDir, "index.html");
    await fs.access(distHtml);
    const html = await fs.readFile(distHtml, "utf-8");
    return res.send(html);
  } catch {
    next();
  }
});

// ---------- Public: Create order (legacy, no Stripe) - only when no DB ----------
app.post("/api/orders", async (req, res) => {
  try {
    if (dbConnected()) {
      return res.status(400).json({ error: "Use POST /api/orders/create-checkout-session for payment" });
    }
    const { customer, items, totalCents, shippingCents, notes, createAccount } = req.body;
    if (!customer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "customer and items (non-empty array) required" });
    }
    const { email, firstName, lastName, phone, address } = customer;
    if (!email?.trim() || !firstName?.trim() || !lastName?.trim()) {
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
    res.status(201).json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Public: Stripe checkout (create session, confirm) ----------
app.use("/api/orders", stripeRouter);

// ---------- Admin auth (no auth middleware) ----------
app.use("/api/admin", adminAuthRouter);

// ---------- Customer (store) auth: login, register, orders ----------
app.use("/api/user", userAuthRouter);

// Optional admin auth when DB is connected
const maybeRequireAdmin = (req, res, next) => {
  if (!dbConnected()) return next();
  requireAdmin(req, res, next);
};

// ---------- Admin: Templates (PUT update) ----------
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
    await doc.save();
    const out = doc.toObject();
    const id = (out.id && String(out.id).trim()) || (out.templateId && String(out.templateId).trim()) || out._id?.toString();
    res.json({ ...out, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ---------- Admin: Orders (protected when DB) ----------
app.get("/api/admin/orders", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const status = req.query.status;
      const email = req.query.email;
      let list = await Order.find().sort({ createdAt: -1 }).lean();
      if (status) list = list.filter((o) => o.status === status);
      if (email) {
        const q = String(email).toLowerCase();
        list = list.filter((o) => (o.customer?.email || "").toLowerCase().includes(q));
      }
      return res.json(list.map((o) => ({ ...o, id: o._id.toString() })));
    }
    const list = getAllOrders({ status: req.query.status, email: req.query.email });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/orders/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      return res.json(orderToJson(order));
    }
    const order = getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/admin/orders/:id", maybeRequireAdmin, async (req, res) => {
  try {
    if (dbConnected()) {
      const { status, ...rest } = req.body || {};
      const order = await Order.findByIdAndUpdate(req.params.id, status != null ? { status } : rest, { new: true });
      if (!order) return res.status(404).json({ error: "Order not found" });
      return res.json(orderToJson(order));
    }
    const { status, ...rest } = req.body || {};
    const id = req.params.id;
    const updated = status != null ? updateOrderStatus(id, status) : updateOrder(id, rest);
    if (!updated) return res.status(404).json({ error: "Order not found" });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/order-statuses", (req, res) => {
  res.json(dbConnected() ? ORDER_STATUSES_WITH_PAYMENT : ORDER_STATUSES);
});

// ---------- Admin: Dashboard stats (protected when DB) ----------
app.get("/api/admin/stats", maybeRequireAdmin, async (req, res) => {
  try {
    const paidStatuses = ["confirmed", "in_production", "shipped", "delivered"];
    if (dbConnected()) {
      const [totalOrders, byStatus, revenueResult, ordersLast7Days] = await Promise.all([
        Order.countDocuments(),
        Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
        Order.aggregate([
          { $match: { status: { $in: paidStatuses } } },
          { $group: { _id: null, total: { $sum: { $add: ["$totalCents", { $ifNull: ["$shippingCents", 0] }] } } } },
        ]),
        Order.aggregate([
          {
            $match: {
              createdAt: {
                $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);
      const ordersByStatus = {};
      byStatus.forEach((x) => { ordersByStatus[x._id] = x.count; });
      const totalRevenueCents = revenueResult[0]?.total ?? 0;
      const last7Days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const found = ordersLast7Days.find((x) => x._id === dateStr);
        last7Days.push({ date: dateStr, count: found ? found.count : 0 });
      }
      return res.json({
        totalOrders,
        ordersByStatus,
        totalRevenueCents,
        ordersLast7Days: last7Days,
      });
    }
    const list = getAllOrders();
    const totalOrders = list.length;
    const ordersByStatus = {};
    list.forEach((o) => { ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1; });
    let totalRevenueCents = 0;
    list.forEach((o) => {
      if (paidStatuses.includes(o.status)) {
        totalRevenueCents += (o.totalCents || 0) + (o.shippingCents || 0);
      }
    });
    const ordersLast7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = list.filter((o) => o.createdAt && o.createdAt.startsWith(dateStr)).length;
      ordersLast7Days.push({ date: dateStr, count });
    }
    res.json({ totalOrders, ordersByStatus, totalRevenueCents, ordersLast7Days });
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

// ---------- Health ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: dbConnected() });
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
  app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
})();
