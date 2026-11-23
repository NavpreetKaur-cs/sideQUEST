import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: ["friend_request", "friend_accepted", "server_invite", "game_invite", "mention", "direct_message", "announcement"],
      required: true
    },
    message: { type: String, required: true, maxlength: 240 },
    link: { type: String, maxlength: 240, default: "" },
    readAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export default mongoose.model("Notification", notificationSchema);
