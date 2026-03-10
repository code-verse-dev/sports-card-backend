import { Router } from "express";
import mongoose from "mongoose";
import { CustomerUser, hashCustomerPassword } from "../models/CustomerUser.js";
import { signToken, requireCustomer } from "../middleware/auth.js";
import { dbConnected } from "../db.js";
import { Order } from "../models/Order.js";
import { UserSavedDesign } from "../models/UserSavedDesign.js";

const router = Router();

/** POST /api/user/register - body: { email, password, firstName?, lastName? }. Creates customer account. */
router.post("/register", async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Registration is not available" });
  }
  const { email, password, firstName, lastName } = req.body || {};
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "").trim();
  if (!e || !p) {
    return res.status(400).json({ error: "Email and password required" });
  }
  if (p.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const existing = await CustomerUser.findOne({ email: e });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }
  try {
    const passwordHash = await hashCustomerPassword(p);
    const user = await CustomerUser.create({
      email: e,
      passwordHash,
      firstName: firstName != null ? String(firstName).trim() : undefined,
      lastName: lastName != null ? String(lastName).trim() : undefined,
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
  if (!dbConnected()) {
    return res.status(503).json({ error: "Login is not available" });
  }
  const { email, password } = req.body || {};
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "").trim();
  if (!e || !p) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const user = await CustomerUser.findOne({ email: e });
  if (!user) {
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
});

/** GET /api/user/me - requires auth. Returns current user profile including saved billing. */
router.get("/me", requireCustomer, (req, res) => {
  const u = req.customerUser;
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    company: u.company,
    address: u.address,
    addressLine2: u.addressLine2,
    city: u.city,
    state: u.state,
    zip: u.zip,
    country: u.country,
  });
});

/** PATCH /api/user/me - requires auth. Body: { firstName?, lastName?, phone?, company?, address?, addressLine2?, city?, state?, zip?, country? }. */
router.patch("/me", requireCustomer, async (req, res) => {
  try {
    const user = req.customerUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { firstName, lastName, phone, company, address, addressLine2, city, state, zip, country } = req.body || {};
    if (firstName !== undefined) user.firstName = String(firstName).trim() || undefined;
    if (lastName !== undefined) user.lastName = String(lastName).trim() || undefined;
    if (phone !== undefined) user.phone = String(phone).trim() || undefined;
    if (company !== undefined) user.company = String(company).trim() || undefined;
    if (address !== undefined) user.address = String(address).trim() || undefined;
    if (addressLine2 !== undefined) user.addressLine2 = String(addressLine2).trim() || undefined;
    if (city !== undefined) user.city = String(city).trim() || undefined;
    if (state !== undefined) user.state = String(state).trim() || undefined;
    if (zip !== undefined) user.zip = String(zip).trim() || undefined;
    if (country !== undefined) user.country = String(country).trim() || undefined;
    await user.save();
    res.json({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      company: user.company,
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
    res.json(withId);
  } catch (e) {
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
    const { templateId, templateName, name, designSnapshot, designFontOverrides } = req.body || {};
    const tid = String(templateId || "").trim();
    if (!tid) return res.status(400).json({ error: "templateId required" });
    const doc = await UserSavedDesign.create({
      userId,
      templateId: tid,
      templateName: templateName != null ? String(templateName).trim() : undefined,
      name: name != null ? String(name).trim() : undefined,
      designSnapshot: designSnapshot && typeof designSnapshot === "object" ? designSnapshot : {},
      designFontOverrides: designFontOverrides && typeof designFontOverrides === "object" ? designFontOverrides : {},
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
    const { name, designSnapshot, designFontOverrides, templateName } = req.body || {};
    if (name !== undefined) doc.name = String(name).trim() || undefined;
    if (templateName !== undefined) doc.templateName = String(templateName).trim() || undefined;
    if (designSnapshot !== undefined && typeof designSnapshot === "object") doc.designSnapshot = designSnapshot;
    if (designFontOverrides !== undefined && typeof designFontOverrides === "object") doc.designFontOverrides = designFontOverrides;
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
