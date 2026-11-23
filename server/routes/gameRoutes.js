import multer from "multer";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { param } from "express-validator";
import { authenticate } from "../middleware/authenticate.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { parseGameThumbnail } from "../middleware/gameThumbnailUpload.js";
import {
  deleteGame, listMyGames, listPublicGames, publishGame, updateGameBuild, updateGameThumbnail, uploadGame,
  getPublicGame, updateGame, previewGame, toggleLike, createComment, deleteComment, getSave, putSave
} from "../controllers/gameController.js";

const router = Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `sidequest-${crypto.randomUUID()}${path.extname(file.originalname) || ".zip"}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});

function parseGameUpload(req, res, next) {
  upload.single("game")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "Game ZIP exceeds the 500 MB upload limit" });
      }
      return res.status(400).json({ message: "Could not read the uploaded game ZIP" });
    }
    if (error) return next(error);
    return next();
  });
}

router.get("/public", listPublicGames);
router.get("/public/:slug", getPublicGame);
router.get("/mine", authenticate, listMyGames);
router.post("/upload", authenticate, parseGameUpload, uploadGame);
router.put("/:id/build", authenticate, param("id").isMongoId(), validateRequest, parseGameUpload, updateGameBuild);
router.post("/:id/thumbnail", authenticate, param("id").isMongoId(), validateRequest, parseGameThumbnail, updateGameThumbnail);
router.post("/:id/publish", authenticate, publishGame);
router.patch("/:id", authenticate, param("id").isMongoId(), validateRequest, updateGame);
router.get("/:id/preview", authenticate, param("id").isMongoId(), validateRequest, previewGame);
router.post("/:id/like", authenticate, param("id").isMongoId(), validateRequest, toggleLike);
router.post("/:id/comments", authenticate, param("id").isMongoId(), validateRequest, createComment);
router.delete("/:id/comments/:commentId", authenticate, param("id").isMongoId(), param("commentId").isMongoId(), validateRequest, deleteComment);
router.get("/:id/save", authenticate, param("id").isMongoId(), validateRequest, getSave);
router.put("/:id/save", authenticate, param("id").isMongoId(), validateRequest, putSave);
router.delete("/:id", authenticate, deleteGame);

export default router;
