import mongoose from "mongoose";

export async function connectDB(uri) {
  if (!uri) throw new Error("MONGODB_URI is not configured");

  try {
    await mongoose.connect(uri);
    console.log("MongoDB connected");
  } catch (atlasError) {
    if (process.env.NODE_ENV === "production") throw atlasError;

    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
    console.warn("Atlas unavailable; using temporary in-memory MongoDB for development.");
    return memoryServer;
  }
}