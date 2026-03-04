import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "";

export async function connectDB() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI not set – using in-memory store for orders/prices. Admin auth and Stripe require DB.");
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB connected");
    return true;
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    throw err;
  }
}

export const dbConnected = () => !!MONGODB_URI && mongoose.connection.readyState === 1;
