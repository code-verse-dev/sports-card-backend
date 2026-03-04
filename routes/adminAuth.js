import { Router } from "express";
import { AdminUser, hashPassword } from "../models/AdminUser.js";
import { signToken } from "../middleware/auth.js";
import { dbConnected } from "../db.js";

const router = Router();

/** POST /api/admin/login - body: { email, password }. Returns { token, user: { email } }. */
router.post("/login", async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Database not configured" });
  }
  const { email, password } = req.body || {};
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "").trim();
  if (!e || !p) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const user = await AdminUser.findOne({ email: e });
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const ok = await user.comparePassword(p);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = signToken({ userId: user._id.toString() });
  res.json({ token, user: { email: user.email } });
});

/** POST /api/admin/seed-admin - one-time seed default admin (admin@admin.com / admin123). */
router.post("/seed-admin", async (req, res) => {
  if (!dbConnected()) {
    return res.status(503).json({ error: "Database not configured" });
  }
  const existing = await AdminUser.findOne({ email: "admin@admin.com" });
  if (existing) {
    return res.json({ message: "Admin already exists" });
  }
  const passwordHash = await hashPassword("admin123");
  await AdminUser.create({ email: "admin@admin.com", passwordHash });
  res.status(201).json({ message: "Admin created. Use admin@admin.com / admin123" });
});

export default router;
