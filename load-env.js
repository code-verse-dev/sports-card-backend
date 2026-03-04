/**
 * Load server/.env before any other module that uses process.env.
 * Must be the first import in index.js so MONGODB_URI etc. are set before db.js loads.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
