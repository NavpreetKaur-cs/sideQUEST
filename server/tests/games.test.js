import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../app.js";

process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
process.env.NODE_ENV = "test";

let mongoServer;
let app;
let userId;
const clientOrigin = "http://localhost:5173";
const uploadsRoot = fileURLToPath(new URL("../uploads/games/", import.meta.url));

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = createApp({ clientOrigin });
});

after(async () => {
  if (userId) await fs.rm(path.join(uploadsRoot, userId), { recursive: true, force: true });
  await mongoose.disconnect();
  await mongoServer?.stop();
});

test("game thumbnails can be uploaded and served on published games", async () => {
  const agent = request.agent(app);
  const origin = { Origin: clientOrigin };
  const registered = await agent.post("/api/auth/register").set(origin).send({
    username: "thumbnail_creator",
    email: "thumbnail_creator@example.com",
    password: "long-password-123"
  });
  assert.equal(registered.status, 201);
  userId = registered.body.user.id;

  const zip = new AdmZip();
  zip.addFile("index.html", Buffer.from("<html><body>Game</body></html>"));
  const uploaded = await agent.post("/api/games/upload")
    .set(origin)
    .field("title", "Thumbnail game")
    .field("engine", "html5")
    .field("hosting", "standalone")
    .field("creatorAcknowledgement", "true")
    .attach("game", zip.toBuffer(), { filename: "game.zip", contentType: "application/zip" });
  assert.equal(uploaded.status, 201, uploaded.text);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r4sAAAAASUVORK5CYII=",
    "base64"
  );
  const thumbnail = await agent.post(`/api/games/${uploaded.body.game.id}/thumbnail`)
    .set(origin)
    .attach("thumbnail", png, { filename: "cover.png", contentType: "image/png" });
  assert.equal(thumbnail.status, 200, thumbnail.text);
  assert.match(thumbnail.body.game.thumbnail, /^\/uploads\/games\//);

  const published = await agent.post(`/api/games/${uploaded.body.game.id}/publish`).set(origin);
  assert.equal(published.status, 200);
  assert.equal(published.body.game.thumbnail, thumbnail.body.game.thumbnail);

  const publicGames = await request(app).get("/api/games/public");
  assert.equal(publicGames.status, 200);
  assert.equal(publicGames.body.games[0].thumbnail, thumbnail.body.game.thumbnail);

  const image = await request(app).get(thumbnail.body.game.thumbnail);
  assert.equal(image.status, 200);
  assert.match(image.headers["content-type"], /image\/png/);

  const previousBuild = await request(app).get(`/games/play/${published.body.game.publicSlug}`).redirects(0);
  assert.equal(previousBuild.status, 302);
  const gamePage = await request(app).get(previousBuild.headers.location);
  assert.equal(gamePage.status, 200);
  assert.equal(gamePage.headers["access-control-allow-origin"], "*");
  assert.match(gamePage.headers["content-security-policy"], /'unsafe-inline'/);
  assert.match(gamePage.headers["content-security-policy"], /'wasm-unsafe-eval'/);
  assert.match(gamePage.headers["content-security-policy"], /sandbox allow-scripts/);
  assert.match(gamePage.headers["content-security-policy"], new RegExp(`frame-ancestors ${clientOrigin}`));
  assert.doesNotMatch(gamePage.headers["content-security-policy"], /allow-same-origin/);

  const updatedZip = new AdmZip();
  updatedZip.addFile("index.html", Buffer.from("<html><body>Updated Unity build</body></html>"));
  const updated = await agent.put(`/api/games/${uploaded.body.game.id}/build`)
    .set(origin)
    .field("engine", "Unity WebGL")
    .attach("game", updatedZip.toBuffer(), { filename: "updated.zip", contentType: "application/zip" });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.body.game.engine, "Unity WebGL");
  assert.equal(updated.body.game.status, "published");
  assert.equal(updated.body.game.publicSlug, published.body.game.publicSlug);

  const currentBuild = await request(app).get(`/games/play/${published.body.game.publicSlug}`).redirects(0);
  assert.equal(currentBuild.status, 302);
  assert.notEqual(currentBuild.headers.location, previousBuild.headers.location);
  assert.match(currentBuild.headers.location, /index\.html$/);
  const updatedThumbnail = await request(app).get(updated.body.game.thumbnail);
  assert.equal(updatedThumbnail.status, 200);
  assert.match(updatedThumbnail.headers["content-type"], /image\/png/);
});
