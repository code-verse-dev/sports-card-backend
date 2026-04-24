/**
 * Create a new AdminUser in MongoDB (bcrypt hash, same as app login).
 *
 * Usage (from sports-card-backend):
 *   npm run admin:add -- <email> <password>
 *
 * Password must be strong: 12+ characters, uppercase, lowercase, digit, and special character.
 * Use quotes around the password if it contains shell metacharacters (e.g. !).
 *
 * Example:
 *   npm run admin:add -- ops@example.com 'MyStr0ng!PassPhrase'
 */
import "../load-env.js";
import mongoose from "mongoose";
import { connectDB } from "../db.js";
import { AdminUser, hashPassword } from "../models/AdminUser.js";

const emailRe =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function normalizeEmail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function validateEmail(email) {
  if (!email || email.length > 254) return "Email is required (max 254 characters).";
  if (!emailRe.test(email)) return "Email format is invalid.";
  if (email.includes("..") || email.startsWith(".") || email.includes("@.") || email.includes(".@")) {
    return "Email format is invalid.";
  }
  return null;
}

/** Strong password: length + mixed case + digit + symbol (NIST-style length-first, plus complexity). */
function validateStrongPassword(password) {
  const p = String(password || "");
  if (p.length < 12) return "Password must be at least 12 characters.";
  if (p.length > 200) return "Password is too long (max 200).";
  if (!/[a-z]/.test(p)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(p)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(p)) return "Password must include at least one digit.";
  if (!/[^a-zA-Z0-9]/.test(p)) return "Password must include at least one special character (e.g. !@#$%^&*).";
  const common = /^(password|admin|12345|qwerty|letmein)/i;
  if (common.test(p.slice(0, 12))) return "Password is too common at the start; choose something less predictable.";
  return null;
}

async function main() {
  const email = normalizeEmail(process.argv[2]);
  const password = process.argv[3] != null ? String(process.argv[3]) : "";

  if (!email || !password) {
    console.error(
      "Usage: npm run admin:add -- <email> <password>\n\n" +
        "Requirements:\n" +
        "  • Valid email address\n" +
        "  • Password: 12+ chars, uppercase, lowercase, digit, special character\n" +
        "  • Quote the password if it contains ! or other shell characters\n\n" +
        "Example:\n" +
        "  npm run admin:add -- you@example.com 'MyStr0ng!Phrase'"
    );
    process.exit(1);
  }

  const emailErr = validateEmail(email);
  if (emailErr) {
    console.error("[add-admin]", emailErr);
    process.exit(1);
  }

  const passErr = validateStrongPassword(password);
  if (passErr) {
    console.error("[add-admin]", passErr);
    process.exit(1);
  }

  const connected = await connectDB().catch((e) => {
    console.error("[add-admin] MongoDB connection failed:", e?.message || e);
    return false;
  });
  if (!connected) {
    console.error("[add-admin] Set MONGODB_URI in .env and ensure MongoDB is reachable.");
    process.exit(1);
  }

  try {
    const existing = await AdminUser.findOne({ email });
    if (existing) {
      console.error("[add-admin] An admin with this email already exists.");
      process.exit(1);
    }

    const passwordHash = await hashPassword(password);
    await AdminUser.create({ email, passwordHash, role: "admin" });
    console.log("[add-admin] Created admin:", email);
    console.log("[add-admin] Password was not printed. Sign in at your admin login with this email.");
  } catch (e) {
    if (e?.code === 11000) {
      console.error("[add-admin] Duplicate email (unique index).");
    } else {
      console.error("[add-admin] Failed:", e?.message || e);
    }
    process.exit(1);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[add-admin] Unexpected:", e?.message || e);
  process.exit(1);
});
