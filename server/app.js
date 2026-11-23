import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { trustedOrigin } from "./middleware/trustedOrigin.js";
import authRoutes from "./routes/authRoutes.js";
import socialRoutes from "./routes/socialRoutes.js";
import gameRoutes from "./routes/gameRoutes.js";
import { playGame } from "./controllers/gameController.js";
import { getClientOrigins } from "./config/clientOrigins.js";
import { requireCsrf } from "./middleware/csrf.js";

export function createApp({ clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173" } = {}) {
  const app = express();
  const allowedOrigins = getClientOrigins(clientOrigin);
  const corsOptions = {
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true
  };

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use(mongoSanitize());
  app.use(requireCsrf);
  app.use(trustedOrigin(allowedOrigins));
  app.use(
    "/uploads/games",
    (req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      // Helmet sets SAMEORIGIN globally. Uploaded games are intentionally framed by
      // the configured client origin and remain sandboxed by the CSP below.
      res.removeHeader("X-Frame-Options");
      if (req.path.toLowerCase().endsWith(".html")) {
        res.setHeader("Content-Security-Policy", [
          "default-src 'self' data: blob: http: https:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: http: https:",
          "style-src 'self' 'unsafe-inline' data: blob: http: https:",
          "img-src 'self' data: blob: http: https:",
          "font-src 'self' data: blob: http: https:",
          "media-src 'self' data: blob: http: https:",
          "connect-src 'self' data: blob: http: https: ws: wss:",
          "worker-src 'self' data: blob: http: https:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          `frame-ancestors ${allowedOrigins.join(" ")}`,
          "sandbox allow-scripts allow-pointer-lock"
        ].join("; "));
      }
      return next();
    }
  );
  app.use(
    "/uploads",
    helmet.crossOriginResourcePolicy({ policy: "cross-origin" }),
    express.static(fileURLToPath(new URL("./uploads/", import.meta.url)), {
      fallthrough: false, index: false, maxAge: "7d", immutable: true
    })
  );

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use(
    "/api/auth",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }),
    authRoutes
  );
  app.use(
    "/api/games",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }),
    gameRoutes
  );
  app.get("/games/play/:slug", playGame);
  app.use(
    "/api/social",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 240, standardHeaders: "draft-7", legacyHeaders: false }),
    socialRoutes
  );

  app.use((_req, res) => res.status(404).json({ message: "Route not found" }));
  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
