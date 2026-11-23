import mongoose from "mongoose";
const gameCommentSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true, index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true, trim: true, minlength: 1, maxlength: 1000 }
}, { timestamps: true });
export default mongoose.model("GameComment", gameCommentSchema);
