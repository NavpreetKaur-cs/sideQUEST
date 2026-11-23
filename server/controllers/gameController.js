import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import Game from "../models/Game.js";
import GameSave from "../models/GameSave.js";
import GameComment from "../models/GameComment.js";

const uploadsRoot = fileURLToPath(new URL("../uploads/games/", import.meta.url));
const maxZipSize = 500 * 1024 * 1024;
const maxExtractedSize = 500 * 1024 * 1024;
const blockedExtensions = new Set([".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".sh", ".php", ".py"]);

function validateEngine(value) {
  const engine = String(value || "Other").trim();
  return engine.length > 0 && engine.length <= 40 ? engine : null;
}

function validateHosting(value) {
  return ["standalone", "external"].includes(value) ? value : null;
}
const genres = new Set(["Action", "Adventure", "Arcade", "Multiplayer", "Puzzle", "Racing", "RPG", "Sandbox", "Strategy", "Other"]);
function validateGenre(value) { return genres.has(value) ? value : null; }

function validateExternalServiceUrl(value, hosting) {
  const url = String(value || "").trim();
  if (hosting === "standalone") return "";
  if (!url || url.length > 500) return null;
  try {
    const parsed = new URL(url);
    return ["https:", "http:", "wss:", "ws:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

async function extractGameBuild(file, userId) {
  let zip;
  try {
    zip = new AdmZip(file.path);
  } catch {
    return { error: "Uploaded file is not a valid ZIP archive" };
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    return { error: "Uploaded file is not a valid ZIP archive" };
  }
  if (entries.length > 1000) return { error: "ZIP contains too many files" };

  let extractedSize = 0;
  let manifestEntry = null;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const normalized = entry.entryName.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      path.posix.isAbsolute(normalized) ||
      /^[a-z]:\//i.test(normalized)
    ) {
      return { error: "ZIP contains an unsafe file path" };
    }
    if (blockedExtensions.has(path.posix.extname(normalized).toLowerCase())) {
      return { error: `ZIP contains a blocked executable: ${normalized}` };
    }
    extractedSize += entry.header?.size || entry.getData().length;
    if (normalized.toLowerCase() === "manifest.json" && !manifestEntry) manifestEntry = entry;
    if (extractedSize > maxExtractedSize) return { error: "Extracted game exceeds the 500 MB limit" };
  }

  let manifest = {};
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    } catch {
      return { error: "manifest.json must contain valid JSON" };
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { error: "manifest.json must contain a JSON object" };
    }
  }

  const entryPoint = String(manifest.entryPoint || "index.html").replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !entryPoint ||
    entryPoint.startsWith("../") ||
    entryPoint.includes("/../") ||
    path.posix.isAbsolute(entryPoint) ||
    /^[a-z]:\//i.test(entryPoint) ||
    path.posix.extname(entryPoint).toLowerCase() !== ".html"
  ) {
    return { error: "manifest entryPoint must be a safe HTML file" };
  }

  const buildPath = path.join(userId, crypto.randomUUID());
  const diskPath = path.join(uploadsRoot, buildPath);
  await fs.mkdir(diskPath, { recursive: true });
  try {
    zip.extractAllTo(diskPath, true);
    await fs.access(path.join(diskPath, entryPoint));
  } catch (error) {
    await fs.rm(diskPath, { recursive: true, force: true });
    if (error.code === "ENOENT") {
      return {
        error: `Entry point not found: ${entryPoint}. ZIP the web export contents so the HTML file is not inside an extra folder.`
      };
    }
    throw error;
  }

  return { buildPath, entryPoint };
}

function publicGame(game) {
  return {
    id: game._id,
    title: game.title,
    description: game.description,
    engine: game.engine,
    genre: game.genre,
    hosting: game.hosting,
    externalServiceUrl: game.externalServiceUrl,
    entryPoint: game.entryPoint,
    thumbnail: game.thumbnailPath
      ? `/uploads/games/${game.buildPath.replace(/\\/g, "/")}/${game.thumbnailPath}`
      : "",
    publicSlug: game.publicSlug,
    status: game.status,
    originalSize: game.originalSize,
    plays: game.plays,
    likesCount: game.likesCount || 0,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt
  };
}

export async function uploadGame(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "A ZIP game build is required" });
    if (req.file.size > maxZipSize) return res.status(413).json({ message: "Game ZIP exceeds the 500 MB upload limit" });

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const engine = validateEngine(req.body.engine);
    const hosting = validateHosting(req.body.hosting);
    const genre = validateGenre(req.body.genre || "Other");
    const externalServiceUrl = validateExternalServiceUrl(req.body.externalServiceUrl, hosting);
    if (title.length < 2 || title.length > 80) return res.status(400).json({ message: "Title must be 2-80 characters" });
    if (!engine) return res.status(400).json({ message: "Engine name must be 1-40 characters" });
    if (!hosting) return res.status(400).json({ message: "Choose whether the game is standalone or uses external services" });
    if (!genre) return res.status(400).json({ message: "Choose a valid genre" });
    if (externalServiceUrl === null) return res.status(400).json({ message: "External-service games need a valid HTTP(S) or WebSocket service URL" });
    if (req.body.creatorAcknowledgement !== "true") return res.status(400).json({ message: "Confirm that you are responsible for this game's external services" });

    const build = await extractGameBuild(req.file, req.auth.userId);
    if (build.error) return res.status(400).json({ message: build.error });

    const game = await Game.create({
      owner: req.auth.userId,
      title,
      description,
      engine,
      genre,
      hosting,
      externalServiceUrl,
      entryPoint: build.entryPoint,
      buildPath: build.buildPath,
      originalSize: req.file.size
    });
    return res.status(201).json({ game: publicGame(game) });
  } catch (error) {
    return next(error);
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}

export async function updateGameBuild(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "A ZIP game build is required" });
    if (req.file.size > maxZipSize) return res.status(413).json({ message: "Game ZIP exceeds the 500 MB upload limit" });

    const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId });
    if (!game) return res.status(404).json({ message: "Game not found" });
    const engine = req.body.engine === undefined ? game.engine : validateEngine(req.body.engine);
    if (!engine) return res.status(400).json({ message: "Engine name must be 1-40 characters" });

    const build = await extractGameBuild(req.file, req.auth.userId);
    if (build.error) return res.status(400).json({ message: build.error });

    const newBuildDirectory = path.join(uploadsRoot, build.buildPath);
    const previousBuildPath = game.buildPath;
    if (game.thumbnailPath) {
      try {
        await fs.copyFile(
          path.join(uploadsRoot, previousBuildPath, game.thumbnailPath),
          path.join(newBuildDirectory, game.thumbnailPath)
        );
      } catch (error) {
        await fs.rm(newBuildDirectory, { recursive: true, force: true });
        throw error;
      }
    }

    game.buildPath = build.buildPath;
    game.entryPoint = build.entryPoint;
    game.engine = engine;
    game.originalSize = req.file.size;
    try {
      await game.save();
    } catch (error) {
      await fs.rm(newBuildDirectory, { recursive: true, force: true });
      throw error;
    }

    try {
      await fs.rm(path.join(uploadsRoot, previousBuildPath), { recursive: true, force: true });
    } catch (error) {
      console.error("Could not remove the previous game build", error);
    }
    return res.json({ game: publicGame(game) });
  } catch (error) {
    return next(error);
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}

export async function listMyGames(req, res, next) {
  try {
    const games = await Game.find({ owner: req.auth.userId }).sort({ updatedAt: -1 });
    return res.json({ games: games.map(publicGame) });
  } catch (error) {
    return next(error);
  }
}

export async function listPublicGames(req, res, next) {
  try {
    const filter = { status: "published" };
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ title: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { description: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }];
    if (genres.has(req.query.genre)) filter.genre = req.query.genre;
    const sort = req.query.sort === "popular" ? { likesCount: -1, plays: -1 } : req.query.sort === "trending" ? { plays: -1, likesCount: -1, updatedAt: -1 } : { createdAt: -1 };
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 100);
    const games = await Game.find(filter).populate("owner", "username avatar").sort(sort).limit(limit);
    return res.json({ games: games.map((game) => ({ ...publicGame(game), owner: game.owner })) });
  } catch (error) {
    return next(error);
  }
}

export async function publishGame(req, res, next) {
  try {
    const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId });
    if (!game) return res.status(404).json({ message: "Game not found" });
    if (!game.publicSlug) {
      const base = game.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "game";
      game.publicSlug = `${base}-${crypto.randomBytes(3).toString("hex")}`;
    }
    game.status = "published";
    await game.save();
    return res.json({ game: publicGame(game) });
  } catch (error) {
    return next(error);
  }
}

function thumbnailExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export async function updateGameThumbnail(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "Choose a thumbnail image" });
    const extension = thumbnailExtension(req.file.buffer);
    if (!extension) return res.status(400).json({ message: "Uploaded file is not a valid JPEG, PNG, or WebP image" });

    const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId });
    if (!game) return res.status(404).json({ message: "Game not found" });

    const thumbnailName = `thumbnail-${crypto.randomUUID()}.${extension}`;
    const gameDirectory = path.join(uploadsRoot, game.buildPath);
    const thumbnailDiskPath = path.join(gameDirectory, thumbnailName);
    await fs.writeFile(thumbnailDiskPath, req.file.buffer, { flag: "wx" });

    const previousThumbnail = game.thumbnailPath;
    game.thumbnailPath = thumbnailName;
    try {
      await game.save();
    } catch (error) {
      await fs.rm(thumbnailDiskPath, { force: true }).catch((cleanupError) => {
        console.error("Could not remove a failed game thumbnail upload", cleanupError);
      });
      throw error;
    }

    if (previousThumbnail) {
      try {
        await fs.rm(path.join(gameDirectory, previousThumbnail), { force: true });
      } catch (error) {
        console.error("Could not remove the previous game thumbnail", error);
      }
    }
    return res.json({ game: publicGame(game) });
  } catch (error) {
    return next(error);
  }
}

export async function deleteGame(req, res, next) {
  try {
    const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId });
    if (!game) return res.status(404).json({ message: "Game not found" });
    await fs.rm(path.join(uploadsRoot, game.buildPath), { recursive: true, force: true });
    await Promise.all([game.deleteOne(), GameComment.deleteMany({ game: game._id }), GameSave.deleteMany({ game: game._id })]);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function getPublicGame(req, res, next) {
  try {
    const game = await Game.findOne({ publicSlug: req.params.slug, status: "published" }).populate("owner", "username avatar");
    if (!game) return res.status(404).json({ message: "Game not found" });
    const [comments, leaderboard] = await Promise.all([
      GameComment.find({ game: game._id }).populate("author", "username avatar").sort({ createdAt: -1 }).limit(30),
      GameSave.find({ game: game._id }).populate("user", "username avatar").sort({ highScore: -1, updatedAt: 1 }).limit(20)
    ]);
    const likedByMe = Boolean(req.auth?.userId && game.likes.some((id) => id.equals(req.auth.userId)));
    return res.json({ game: { ...publicGame(game), owner: game.owner, likedByMe }, comments, leaderboard: leaderboard.map((save) => ({ user: save.user, highScore: save.highScore })) });
  } catch (error) { return next(error); }
}

export async function updateGame(req, res, next) {
  try {
    const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId });
    if (!game) return res.status(404).json({ message: "Game not found" });
    for (const field of ["title", "description", "engine", "genre", "hosting", "externalServiceUrl", "status"]) if (req.body[field] !== undefined) game[field] = req.body[field];
    if (game.title.trim().length < 2 || game.title.length > 80 || !validateEngine(game.engine) || !validateGenre(game.genre) || !validateHosting(game.hosting) || !["draft", "published"].includes(game.status)) return res.status(400).json({ message: "Invalid game details" });
    const external = validateExternalServiceUrl(game.externalServiceUrl, game.hosting);
    if (external === null) return res.status(400).json({ message: "External-service games need a valid HTTP(S) or WebSocket service URL" });
    game.externalServiceUrl = external;
    if (game.status === "published" && !game.publicSlug) game.publicSlug = `${game.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "game"}-${crypto.randomBytes(3).toString("hex")}`;
    await game.save(); return res.json({ game: publicGame(game) });
  } catch (error) { return next(error); }
}

export async function previewGame(req, res, next) {
  try { const game = await Game.findOne({ _id: req.params.id, owner: req.auth.userId }); if (!game) return res.status(404).json({ message: "Game not found" }); return res.redirect(`/uploads/games/${game.buildPath.replace(/\\/g, "/")}/${game.entryPoint}`); } catch (error) { return next(error); }
}
export async function toggleLike(req, res, next) {
  try { const game = await Game.findOne({ _id: req.params.id, status: "published" }); if (!game) return res.status(404).json({ message: "Game not found" }); const liked = game.likes.some((id) => id.equals(req.auth.userId)); game.likes = liked ? game.likes.filter((id) => !id.equals(req.auth.userId)) : [...game.likes, req.auth.userId]; game.likesCount = game.likes.length; await game.save(); return res.json({ liked: !liked, likesCount: game.likesCount }); } catch (error) { return next(error); }
}
export async function createComment(req, res, next) {
  try { const game = await Game.findOne({ _id: req.params.id, status: "published" }); const content = String(req.body.content || "").trim(); if (!game) return res.status(404).json({ message: "Game not found" }); if (!content || content.length > 1000) return res.status(400).json({ message: "Comment must be 1-1000 characters" }); const comment = await GameComment.create({ game: game._id, author: req.auth.userId, content }); await comment.populate("author", "username avatar"); return res.status(201).json({ comment }); } catch (error) { return next(error); }
}
export async function deleteComment(req, res, next) {
  try { const comment = await GameComment.findOne({ _id: req.params.commentId, game: req.params.id }); if (!comment) return res.status(404).json({ message: "Comment not found" }); const game = await Game.findById(req.params.id).select("owner"); if (!comment.author.equals(req.auth.userId) && !game?.owner.equals(req.auth.userId)) return res.status(403).json({ message: "Permission denied" }); await comment.deleteOne(); return res.status(204).end(); } catch (error) { return next(error); }
}
export async function getSave(req, res, next) { try { const game = await Game.findById(req.params.id); if (!game) return res.status(404).json({ message: "Game not found" }); const save = await GameSave.findOne({ game: game._id, user: req.auth.userId }); return res.json({ data: save?.data || {}, highScore: save?.highScore || 0 }); } catch (error) { return next(error); } }
export async function putSave(req, res, next) { try { const game = await Game.findById(req.params.id); if (!game) return res.status(404).json({ message: "Game not found" }); const data = req.body.data ?? {}; const encoded = JSON.stringify(data); if (encoded.length > 32 * 1024) return res.status(413).json({ message: "Save data exceeds 32 KB" }); const highScore = Number(req.body.highScore); const save = await GameSave.findOneAndUpdate({ game: game._id, user: req.auth.userId }, { data, ...(Number.isFinite(highScore) ? { highScore } : {}) }, { upsert: true, new: true, runValidators: true }); return res.json({ data: save.data, highScore: save.highScore }); } catch (error) { return next(error); } }

export async function playGame(req, res, next) {
  try {
    const game = await Game.findOne({ publicSlug: req.params.slug, status: "published" });
    if (!game) return res.status(404).json({ message: "Game not found" });
    await Game.updateOne({ _id: game._id }, { $inc: { plays: 1 } });
    return res.redirect(`/uploads/games/${game.buildPath.replace(/\\/g, "/")}/${game.entryPoint}`);
  } catch (error) {
    return next(error);
  }
}
