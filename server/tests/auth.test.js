import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../app.js";
import User from "../models/User.js";

process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
process.env.JWT_EXPIRES_IN = "7d";
process.env.NODE_ENV = "test";

let mongoServer;
let app;
const clientOrigin = "http://localhost:5173";

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = createApp({ clientOrigin });
});

after(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

test("registers, authenticates, and clears a session", async () => {
  const agent = request.agent(app);
  const originHeaders = { Origin: clientOrigin };
  const registration = await agent
    .post("/api/auth/register")
    .set(originHeaders)
    .send({ username: "Player_One", email: "PLAYER@example.com", password: "long-password-123" });

  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.username, "player_one");
  assert.equal(registration.body.user.email, "player@example.com");
  assert.equal("password" in registration.body.user, false);
  assert.match(registration.headers["set-cookie"][0], /HttpOnly/i);
  assert.match(registration.headers["set-cookie"][0], /SameSite=Lax/i);
  const storedUser = await User.findOne({ email: "player@example.com" }).select("+password");
  assert.notEqual(storedUser.password, "long-password-123");
  assert.equal(await bcrypt.compare("long-password-123", storedUser.password), true);

  const session = await agent.get("/api/auth/me").set(originHeaders);
  assert.equal(session.status, 200);
  assert.equal(session.body.user.username, "player_one");

  const duplicate = await request(app)
    .post("/api/auth/register")
    .set(originHeaders)
    .send({ username: "player_one", email: "other@example.com", password: "long-password-123" });
  assert.equal(duplicate.status, 409);

  const duplicateEmail = await request(app)
    .post("/api/auth/register")
    .set(originHeaders)
    .send({ username: "player_two", email: "player@example.com", password: "long-password-123" });
  assert.equal(duplicateEmail.status, 409);

  const rejectedLogin = await request(app)
    .post("/api/auth/login")
    .set(originHeaders)
    .send({ email: "player@example.com", password: "wrong-password" });
  assert.equal(rejectedLogin.status, 401);

  const login = await agent
    .post("/api/auth/login")
    .set(originHeaders)
    .send({ email: "player@example.com", password: "long-password-123" });
  assert.equal(login.status, 200);

  const logout = await agent.post("/api/auth/logout").set(originHeaders);
  assert.equal(logout.status, 204);
  const expiredSession = await agent.get("/api/auth/me").set(originHeaders);
  assert.equal(expiredSession.status, 401);
});

test("validates input and rejects untrusted mutation origins", async () => {
  const loopbackOrigin = await request(app)
    .post("/api/auth/login")
    .set("Origin", "http://127.0.0.1:5173")
    .send({ email: "missing@example.com", password: "long-password-123" });
  assert.equal(loopbackOrigin.status, 401);

  const invalid = await request(app)
    .post("/api/auth/register")
    .set("Origin", clientOrigin)
    .send({ username: "x", email: "bad", password: "short" });
  assert.equal(invalid.status, 400);
  assert.ok(Array.isArray(invalid.body.errors));

  const overlongPassword = await request(app)
    .post("/api/auth/register")
    .set("Origin", clientOrigin)
    .send({ username: "player_three", email: "three@example.com", password: "x".repeat(73) });
  assert.equal(overlongPassword.status, 400);

  const rejectedOrigin = await request(app)
    .post("/api/auth/login")
    .set("Origin", "https://untrusted.example")
    .send({ email: "player@example.com", password: "long-password-123" });
  assert.equal(rejectedOrigin.status, 403);
});