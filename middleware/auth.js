import jwt from "jsonwebtoken";
import { AdminUser } from "../models/AdminUser.js";

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Require Authorization: Bearer <token> and valid admin. Attach req.adminUser. */
export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const decoded = verifyToken(token);
  if (!decoded?.userId) {
    return res.status(401).json({ error: "Invalid token" });
  }
  AdminUser.findById(decoded.userId)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "User not found" });
      req.adminUser = user;
      next();
    })
    .catch((err) => res.status(500).json({ error: err.message }));
}
