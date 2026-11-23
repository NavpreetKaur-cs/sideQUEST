import User from "../models/User.js";

export async function loadCurrentUser(req, res, next) {
  try {
    req.user = await User.findById(req.auth.userId).select("username");
    if (!req.user) return res.status(401).json({ message: "Session user no longer exists" });
    return next();
  } catch (error) {
    return next(error);
  }
}
