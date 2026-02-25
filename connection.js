/**
 * Mongoose connection. Set MONGODB_URI in .env.
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI || "";
const defaultDbFromUri = uri.match(/\/\/(?:[^/]+@)?[^/]+\/([^?]+)/)?.[1];
const dbName = process.env.MONGODB_DB_NAME || defaultDbFromUri || "sports-card-demo";

export { dbName };

let connected = false;

export async function connect() {
  if (!uri) return false;
  if (connected) return true;
  await mongoose.connect(uri, { dbName });
  connected = true;
  return true;
}

export function isConnected() {
  return mongoose.connection.readyState === 1;
}

/** For code that needs the underlying MongoClient. Ensures connected first. */
export async function getClient() {
  if (!uri) return null;
  await connect();
  return mongoose.connection.getClient();
}
