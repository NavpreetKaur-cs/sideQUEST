import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

function toPublicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    bio: user.bio,
    status: user.status,
    createdAt: user.createdAt
  };
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.COOKIE_SAME_SITE || "lax",
    maxAge: sessionLifetimeMs,
    path: "/"
  };
}

function clearSession(res) {
  const options = sessionCookieOptions();
  delete options.maxAge;
  res.clearCookie("session", options);
}

function googleClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured");
  }
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL || `${process.env.SERVER_ORIGIN || "http://localhost:5000"}/api/auth/google/callback`
  );
}

function issueSession(res, user) {
  const token = jwt.sign(
    { sub: user._id.toString() },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
  res.cookie("session", token, sessionCookieOptions());
}

export async function register(req, res, next) {
  try {
    const { username, email, password } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email, password: passwordHash });

    issueSession(res, user);
    return res.status(201).json({ user: toPublicUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({
        message: field === "email" ? "Email is already registered" : "Username is already taken"
      });
    }
    return next(error);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");
    const validPassword = user?.password && await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ message: "Email or password is incorrect" });
    }

    issueSession(res, user);
    return res.json({ user: toPublicUser(user) });
  } catch (error) {
    return next(error);
  }
}

export async function logout(_req, res) {
  clearSession(res);
  return res.status(204).end();
}

export function getGoogleUrl(_req, res) {
  try {
    const client = googleClient();
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "select_account",
      scope: ["openid", "email", "profile"]
    });
    return res.json({ url });
  } catch (error) {
    return res.status(503).json({ message: error.message });
  }
}

export async function getGoogleCallback(req, res, next) {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ message: "Google authorization code is required" });

    const client = googleClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ message: "Google account could not be verified" });
    }

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ email }).select("+providers");
    if (!user) {
      const base = (payload.name || payload.email.split("@")[0])
        .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(.{24}).*/, "$1").replace(/_+/g, "_");
      let username = base.length >= 3 ? base : `player_${payload.sub.slice(-8)}`;
      let suffix = 0;
      while (await User.exists({ username })) {
        suffix += 1;
        username = `${base.slice(0, 20)}_${suffix}`;
      }
      user = await User.create({
        username,
        email,
        avatar: payload.picture || "",
        providers: [{ provider: "google", providerId: payload.sub }]
      });
    } else if (!user.providers?.some((item) => item.provider === "google" && item.providerId === payload.sub)) {
      user.providers = [...(user.providers || []), { provider: "google", providerId: payload.sub }];
      await user.save();
    }

    issueSession(res, user);
    const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
    return res.redirect(`${clientOrigin}/`);
  } catch (error) {
    return next(error);
  }
}

export async function getSession(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      clearSession(res);
      return res.status(401).json({ message: "Session user no longer exists" });
    }
    return res.json({ user: toPublicUser(user) });
  } catch (error) {
    return next(error);
  }
}