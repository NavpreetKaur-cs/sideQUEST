import mongoose from "mongoose";

const gameSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  description: { type: String, default: "", trim: true, maxlength: 1000 },
  engine: { type: String, trim: true, maxlength: 40, default: "HTML5" },
  genre: { type: String, enum: ["Action", "Adventure", "Arcade", "Multiplayer", "Puzzle", "Racing", "RPG", "Sandbox", "Strategy", "Other"], default: "Other", index: true },
  hosting: { type: String, enum: ["standalone", "external"], default: "standalone" },
  externalServiceUrl: { type: String, trim: true, maxlength: 500, default: "" },
  entryPoint: { type: String, required: true, maxlength: 255 },
  buildPath: { type: String, required: true, maxlength: 2048 },
  thumbnailPath: { type: String, default: "", maxlength: 255 },
  publicSlug: { type: String, unique: true, sparse: true, lowercase: true, match: /^[a-z0-9-]+$/ },
  status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
  originalSize: { type: Number, required: true },
  plays: { type: Number, default: 0 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  likesCount: { type: Number, default: 0, index: true }
}, { timestamps: true });

export default mongoose.model("Game", gameSchema);
