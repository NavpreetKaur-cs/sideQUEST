import crypto from "node:crypto";

export function issueCsrfToken(req, res) {
  let token = req.cookies?.csrf;
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
  }
  res.cookie("csrf", token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.COOKIE_SAME_SITE || "lax",
    maxAge: 24 * 60 * 60 * 1000,
    path: "/"
  });
  return res.json({ csrfToken: token });
}

export function requireCsrf(req, res, next) {
  if (process.env.NODE_ENV === "test") return next();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const cookieToken = req.cookies?.csrf;
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ message: "Invalid CSRF token" });
  }
  return next();
}
