/**
 * Mongoose connection. Set MONGODB_URI in .env.
 */
import mongoose from "mongoose";

function getUri() {
  return process.env.MONGODB_URI || "";
}

function getDbName() {
  const uri = getUri();
  const defaultDbFromUri = uri.match(/\/\/(?:[^/]+@)?[^/]+\/([^?]+)/)?.[1];
  return process.env.MONGODB_DB_NAME || defaultDbFromUri || "sports-card-demo";
}

export { getDbName as dbName };

let connected = false;

export async function connect() {
  const uri = getUri();
  const dbName = getDbName();
  if (!uri) return false;
  if (connected || mongoose.connection.readyState === 1) return true;
  await mongoose.connect(uri, { dbName });
  connected = true;
  return true;
}

export function isConnected() {
  return mongoose.connection.readyState === 1;
}

/** For code that needs the underlying MongoClient. Ensures connected first. */
export async function getClient() {
  const uri = getUri();
  if (!uri) return null;
  await connect();
  return mongoose.connection.getClient();
}
