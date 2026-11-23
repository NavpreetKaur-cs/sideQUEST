export function trustedOrigin(clientOrigin) {
  const allowedOrigins = new Set(Array.isArray(clientOrigin) ? clientOrigin : [clientOrigin]);
  return (req, res, next) => {
    const origin = req.get("origin");
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method);

    if (!safeMethod && origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ message: "Request origin is not allowed" });
    }
    return next();
  };
}