/**
 * Load server/.env before any other module that uses process.env.
 * Must be the first import in index.js so MONGODB_URI etc. are set before db.js loads.
 * Tries: server/.env, cwd/.env, cwd/server/.env (so it works from root or server dir).
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = __dirname;
const cwd = process.cwd();

const pathsToTry = [
  path.join(serverDir, ".env"),
  path.join(cwd, ".env"),
  path.join(cwd, "server", ".env"),
];

for (const p of pathsToTry) {
  try {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      if (process.env.MONGODB_URI) break;
    }
  } catch (_) {}
}
