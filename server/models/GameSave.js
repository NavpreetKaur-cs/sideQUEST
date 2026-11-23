import mongoose from "mongoose";

const gameSaveSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  highScore: { type: Number, default: 0, index: true }
}, { timestamps: true });
gameSaveSchema.index({ game: 1, user: 1 }, { unique: true });
gameSaveSchema.index({ game: 1, highScore: -1 });
export default mongoose.model("GameSave", gameSaveSchema);
