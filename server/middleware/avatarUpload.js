import multer from "multer";

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      callback(new Error("Avatar must be a JPEG, PNG, or WebP image"));
      return;
    }
    callback(null, true);
  }
});

export function parseAvatar(req, res, next) {
  parser.single("avatar")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE"
        ? "Avatar must be 2 MB or smaller" : "Invalid avatar upload" });
    }
    if (error) return res.status(400).json({ message: error.message });
    return next();
  });
}
