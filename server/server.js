import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";
import { attachRealtime } from "./realtime.js";

const port = Number(process.env.PORT) || 5000;

try {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }

  await connectDB(process.env.MONGODB_URI);
  const app = createApp();
  const server = createServer(app);
  server.requestTimeout = 15 * 60 * 1000;
  attachRealtime(server, app);
  server.listen(port, () => console.log(`API listening on port ${port}`));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
} catch (error) {
  console.error(`Server startup failed: ${error.message}`);
  process.exitCode = 1;
}