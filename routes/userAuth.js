import { Router } from "express";
import mongoose from "mongoose";
import { CustomerUser, hashCustomerPassword } from "../models/CustomerUser.js";
import { resolveCustomerPublicDisplayId } from "../services/publicCodes.js";
import { signToken, requireCustomer } from "../middleware/auth.js";
import { dbConnected } from "../db.js";
import { Order } from "../models/Order.js";
import { UserSavedDesign } from "../models/UserSavedDesign.js";
import { materializeInlineSnapshotsInItems } from "../services/checkoutSnapshotMaterialize.js";
import {
  hasInlineImageDataUrlInItems,
  hasInlineImageRefPlaceholderInItems,
} from "../services/orderSnapshotValidation.js";

const router = Router();

/** POST /api/user/register - body: { email, password, firstName?, lastName?, phone?, address?, addressLine2?, city?, state?, zip?, country? }. Creates customer account. */
router.post("/register", async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Registration is not available" });
  }
  const {
    email,
    password,
    firstName,
    lastName,
    phone,
    address,
    addressLine2,
    city,
    state,
    zip,
    country,
  } = req.body || {};
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "").trim();
  if (!e || !p) {
    return res.status(400).json({ error: "Email and password required" });
  }
  if (p.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const opt = (v) => (v != null && String(v).trim() ? String(v).trim() : undefined);
  try {
    const existing = await CustomerUser.findOne({ email: e }).select("+passwordHash");
    if (existing?.passwordHash) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    if (existing) {
      existing.passwordHash = await hashCustomerPassword(p);
      if (opt(firstName) !== undefined) existing.firstName = opt(firstName);
      if (opt(lastName) !== undefined) existing.lastName = opt(lastName);
      if (opt(phone) !== undefined) existing.phone = opt(phone);
      if (opt(address) !== undefined) existing.address = opt(address);
      if (opt(addressLine2) !== undefined) existing.addressLine2 = opt(addressLine2);
      if (opt(city) !== undefined) existing.city = opt(city);
      if (opt(state) !== undefined) existing.state = opt(state);
      if (opt(zip) !== undefined) existing.zip = opt(zip);
      if (opt(country) !== undefined) existing.country = opt(country);
      await existing.save();
      return res.status(201).json({
        message: "Account created",
        user: {
          email: existing.email,
          firstName: existing.firstName,
          lastName: existing.lastName,
        },
      });
    }
    const passwordHash = await hashCustomerPassword(p);
    const user = await CustomerUser.create({
      email: e,
      passwordHash,
      firstName: opt(firstName),
      lastName: opt(lastName),
      phone: opt(phone),
      address: opt(address),
      addressLine2: opt(addressLine2),
      city: opt(city),
      state: opt(state),
      zip: opt(zip),
      country: opt(country),
    });
    res.status(201).json({
      message: "Account created",
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Registration failed" });
  }
});

/** POST /api/user/login - body: { email, password }. Returns { token, user: { email, firstName, lastName } }. */
router.post("/login", async (req, res) => {
  try {
    if (!dbConnected()) {
      return res.status(503).json({ error: "Login is not available" });
    }
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "").trim();
    if (!e || !p) {
      return res.status(400).json({ error: "Email and password required" });
    }
    const user = await CustomerUser.findOne({ email: e }).select("+passwordHash");
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const ok = await user.comparePassword(p);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = signToken({ userId: user._id.toString(), type: "customer" });
    res.json({
      token,
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Login failed" });
  }
});

/** GET /api/user/me - requires auth. Returns current user profile including saved billing. */
router.get("/me", requireCustomer, (req, res) => {
  const u = req.customerUser;
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    email: u.email,
    publicId: resolveCustomerPublicDisplayId(u),
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    address: u.address,
    addressLine2: u.addressLine2,
    city: u.city,
    state: u.state,
    zip: u.zip,
    country: u.country,
  });
});

/** PATCH /api/user/me - requires auth. Body: { firstName?, lastName?, phone?, address?, addressLine2?, city?, state?, zip?, country? }. */
router.patch("/me", requireCustomer, async (req, res) => {
  try {
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { firstName, lastName, phone, address, addressLine2, city, state, zip, country } = req.body || {};
    if (firstName !== undefined) user.firstName = String(firstName).trim() || undefined;
    if (lastName !== undefined) user.lastName = String(lastName).trim() || undefined;
    if (phone !== undefined) user.phone = String(phone).trim() || undefined;
    if (address !== undefined) user.address = String(address).trim() || undefined;
    if (addressLine2 !== undefined) user.addressLine2 = String(addressLine2).trim() || undefined;
    if (city !== undefined) user.city = String(city).trim() || undefined;
    if (state !== undefined) user.state = String(state).trim() || undefined;
    if (zip !== undefined) user.zip = String(zip).trim() || undefined;
    if (country !== undefined) user.country = String(country).trim() || undefined;
    await user.save();
    res.json({
      email: user.email,
      publicId: resolveCustomerPublicDisplayId(user),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      address: user.address,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      zip: user.zip,
      country: user.country,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/user/change-password - requires auth. Body: { currentPassword, newPassword }. */
router.post("/change-password", requireCustomer, async (req, res) => {
  try {
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { currentPassword, newPassword } = req.body || {};
    const current = String(currentPassword || "").trim();
    const newP = String(newPassword || "").trim();
    if (!current || !newP) {
      return res.status(400).json({ error: "Current password and new password required" });
    }
    if (newP.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    const ok = await user.comparePassword(current);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    user.passwordHash = await hashCustomerPassword(newP);
    await user.save();
    res.json({ message: "Password updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/user/orders - requires Authorization: Bearer <token>. Returns orders for this customer (by customerId if set, else by customer.email case-insensitive). */
router.get("/orders", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) {
      console.warn("[orders] GET /api/user/orders 503: database not available");
      return res.status(503).json({ error: "Orders not available" });
    }
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const emailRegex = new RegExp(`^${String(user.email || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const conditions = [{ "customer.email": emailRegex }];
    if (user._id) {
      try {
        const oid = user._id instanceof mongoose.Types.ObjectId ? user._id : new mongoose.Types.ObjectId(String(user._id));
        conditions.unshift({ customerId: oid });
      } catch {
        // ignore invalid id
      }
    }
    const query = conditions.length > 1 ? { $or: conditions } : { "customer.email": emailRegex };
    const list = await Order.find(query).sort({ createdAt: -1 }).lean();
    const withId = list.map((o) => ({
      ...o,
      id: o._id?.toString(),
    }));
    console.log(`[orders] GET /api/user/orders count=${withId.length} userId=${user._id?.toString?.() || "unknown"}`);
    res.json(withId);
  } catch (e) {
    console.error("[orders] GET /api/user/orders failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/** Whether this logged-in customer may see/update this order (linked account or same email as order snapshot). */
function customerMayAccessOrder(user, orderLean) {
  if (!user || !orderLean) return false;
  const uid = user._id;
  const cid = orderLean.customerId;
  if (cid && uid && String(cid) === String(uid)) return true;
  const ue = String(user.email || "").trim().toLowerCase();
  const oe = String(orderLean.customer?.email || "").trim().toLowerCase();
  return ue.length > 0 && oe.length > 0 && ue === oe;
}

/** Status that lets the customer edit their order's design without paying. Set by admin via status change. */
const DESIGN_FIX_STATUS = "request_review";
/** After the customer submits their edits, the order returns to this status so admin can re-review. */
const DESIGN_FIX_RESOLVED_STATUS = "confirmed";

/** GET /api/user/orders/:orderId — one order (for fix-design flow). */
router.get("/orders/:orderId", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Orders not available" });
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const oid = String(req.params.orderId || "").trim();
    if (!oid || !mongoose.Types.ObjectId.isValid(oid)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await Order.findById(oid).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!customerMayAccessOrder(user, order)) return res.status(403).json({ error: "Forbidden" });
    res.json({ ...order, id: order._id?.toString() });
  } catch (e) {
    console.error("[orders] GET /api/user/orders/:orderId failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/user/orders/:orderId/design-fix — merge image fields into one line's designSnapshot without payment.
 * Requires admin-set designFixRequestedAt. Converts inline data URLs to uploads server-side.
 */
router.patch("/orders/:orderId/design-fix", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Orders not available" });
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const oid = String(req.params.orderId || "").trim();
    if (!oid || !mongoose.Types.ObjectId.isValid(oid)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const { lineIndex, designSnapshotPatch, designFontOverridesPatch } = req.body || {};
    const idx = Number(lineIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ error: "lineIndex must be a non-negative integer" });
    }
    if (!designSnapshotPatch || typeof designSnapshotPatch !== "object" || Array.isArray(designSnapshotPatch)) {
      return res.status(400).json({ error: "designSnapshotPatch (object) required" });
    }
    const fontPatchProvided =
      designFontOverridesPatch != null &&
      typeof designFontOverridesPatch === "object" &&
      !Array.isArray(designFontOverridesPatch);

    const order = await Order.findById(oid);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const lean = order.toObject ? order.toObject() : order;
    if (!customerMayAccessOrder(user, lean)) return res.status(403).json({ error: "Forbidden" });
    if (order.status !== DESIGN_FIX_STATUS) {
      return res.status(400).json({
        error:
          "This order is not open for edits right now. It is only editable when our team sets the status to “request review.”",
      });
    }

    const items = JSON.parse(JSON.stringify(Array.isArray(order.items) ? order.items : []));
    if (idx >= items.length) {
      return res.status(400).json({ error: "lineIndex out of range" });
    }

    const patch = {};
    for (const [k, v] of Object.entries(designSnapshotPatch)) {
      const key = String(k || "").trim();
      if (!key || key.length > 160) continue;
      if (typeof v !== "string") continue;
      patch[key] = v.trim();
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "designSnapshotPatch must include at least one string field value." });
    }

    const row = items[idx] && typeof items[idx] === "object" ? { ...items[idx] } : {};
    const prevSnap =
      row.designSnapshot && typeof row.designSnapshot === "object" && !Array.isArray(row.designSnapshot)
        ? { ...row.designSnapshot }
        : {};
    row.designSnapshot = { ...prevSnap, ...patch };
    if (fontPatchProvided) {
      const prevFontOverrides =
        row.designFontOverrides && typeof row.designFontOverrides === "object" && !Array.isArray(row.designFontOverrides)
          ? { ...row.designFontOverrides }
          : {};
      const cleanedFontOverrides = {};
      for (const [fieldId, value] of Object.entries(designFontOverridesPatch)) {
        const key = String(fieldId || "").trim();
        if (!key || key.length > 160) continue;
        if (value == null) {
          cleanedFontOverrides[key] = undefined;
          continue;
        }
        if (typeof value !== "object" || Array.isArray(value)) continue;
        const v = {};
        for (const fontKey of ["family", "size", "weight", "transform"]) {
          if (value[fontKey] != null) v[fontKey] = String(value[fontKey]).slice(0, 200);
        }
        cleanedFontOverrides[key] = v;
      }
      row.designFontOverrides = { ...prevFontOverrides, ...cleanedFontOverrides };
    }
    items[idx] = row;

    /**
     * Legacy orders (pre-eager-upload) carry `__inline_image_ref__:…` placeholders whose
     * underlying bytes lived in the customer's sessionStorage and are long gone. Walk every
     * line item's snapshot and drop them so they don't fail the placeholder validation below.
     * Only the line the customer is editing has fresh values to apply; for any other line we
     * just clean up the dead reference (its image stays empty until someone re-uploads).
     */
    for (const it of items) {
      const snap = it && typeof it === "object" ? it.designSnapshot : null;
      if (!snap || typeof snap !== "object" || Array.isArray(snap)) continue;
      for (const [k, v] of Object.entries(snap)) {
        if (typeof v === "string" && v.startsWith("__inline_image_ref__:")) snap[k] = "";
      }
    }

    try {
      await materializeInlineSnapshotsInItems(items);
    } catch (e) {
      return res.status(400).json({ error: String(e?.message || "Could not store uploaded images.") });
    }
    if (hasInlineImageRefPlaceholderInItems(items)) {
      return res.status(400).json({
        error: "Some image placeholders are invalid. Re-upload each photo or contact support.",
      });
    }
    if (hasInlineImageDataUrlInItems(items)) {
      return res.status(400).json({
        error: "Images could not be saved on the server. Try again or use smaller files.",
      });
    }

    /** Submission auto-restores status (admin can re-review) and clears any legacy fix-request flags. */
    await Order.findByIdAndUpdate(oid, {
      $set: {
        items,
        status: DESIGN_FIX_RESOLVED_STATUS,
        designFixLastSubmittedAt: new Date(),
        designFixRequestedAt: null,
        designFixNote: null,
      },
    });
    const fresh = await Order.findById(oid).lean();
    res.json({ ...fresh, id: fresh._id?.toString() });
  } catch (e) {
    console.error("[orders] PATCH /api/user/orders/:orderId/design-fix failed:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Saved designs (user's created templates) ----------

/** GET /api/user/templates - list saved designs for the current user. */
router.get("/templates", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Saved designs not available" });
    const userId = req.customerUser?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const list = await UserSavedDesign.find({ userId }).sort({ updatedAt: -1 }).lean();
    const withId = list.map((d) => ({
      ...d,
      id: d._id?.toString(),
    }));
    res.json(withId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/user/templates - save a new design. Body: { templateId, templateName?, name?, designSnapshot?, designFontOverrides? }. */
router.post("/templates", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Saved designs not available" });
    const userId = req.customerUser?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { templateId, templateName, name, designSnapshot, designFontOverrides, cartSelection } = req.body || {};
    const tid = String(templateId || "").trim();
    if (!tid) return res.status(400).json({ error: "templateId required" });
    const doc = await UserSavedDesign.create({
      userId,
      templateId: tid,
      templateName: templateName != null ? String(templateName).trim() : undefined,
      name: name != null ? String(name).trim() : undefined,
      designSnapshot: designSnapshot && typeof designSnapshot === "object" ? designSnapshot : {},
      designFontOverrides: designFontOverrides && typeof designFontOverrides === "object" ? designFontOverrides : {},
      cartSelection: cartSelection && typeof cartSelection === "object" ? cartSelection : undefined,
    });
    const out = doc.toObject();
    res.status(201).json({ ...out, id: out._id?.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/user/templates/:id - get one saved design (must belong to current user). */
router.get("/templates/:id", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Saved designs not available" });
    const userId = req.customerUser?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const doc = await UserSavedDesign.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Saved design not found" });
    res.json({ ...doc, id: doc._id?.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/user/templates/:id - update saved design. Body: { name?, designSnapshot?, designFontOverrides?, templateName? }. */
router.patch("/templates/:id", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Saved designs not available" });
    const userId = req.customerUser?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const doc = await UserSavedDesign.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Saved design not found" });
    const { name, designSnapshot, designFontOverrides, templateName, cartSelection } = req.body || {};
    if (name !== undefined) doc.name = String(name).trim() || undefined;
    if (templateName !== undefined) doc.templateName = String(templateName).trim() || undefined;
    if (designSnapshot !== undefined && typeof designSnapshot === "object") doc.designSnapshot = designSnapshot;
    if (designFontOverrides !== undefined && typeof designFontOverrides === "object") doc.designFontOverrides = designFontOverrides;
    if (cartSelection !== undefined) doc.cartSelection = cartSelection && typeof cartSelection === "object" ? cartSelection : undefined;
    await doc.save();
    const out = doc.toObject();
    res.json({ ...out, id: out._id?.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/user/templates/:id - delete saved design (must belong to current user). */
router.delete("/templates/:id", requireCustomer, async (req, res) => {
  try {
    if (!dbConnected()) return res.status(503).json({ error: "Saved designs not available" });
    const userId = req.customerUser?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const result = await UserSavedDesign.deleteOne({ _id: req.params.id, userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Saved design not found" });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
