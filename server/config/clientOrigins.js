export function getClientOrigins(clientOrigin) {
  const origins = new Set([clientOrigin]);
  if (process.env.NODE_ENV === "production") return [...origins];

  const parsed = new URL(clientOrigin);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    const alias = new URL(clientOrigin);
    alias.hostname = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(alias.origin);
  }
  return [...origins];
}
