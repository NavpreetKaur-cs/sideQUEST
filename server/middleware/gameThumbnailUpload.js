import multer from "multer";

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      callback(new Error("Thumbnail must be a JPEG, PNG, or WebP image"));
      return;
    }
    callback(null, true);
  }
});

export function parseGameThumbnail(req, res, next) {
  parser.single("thumbnail")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        message: error.code === "LIMIT_FILE_SIZE"
          ? "Thumbnail must be 5 MB or smaller"
          : "Invalid thumbnail upload"
      });
    }
    if (error) return res.status(400).json({ message: error.message });
    return next();
  });
}
