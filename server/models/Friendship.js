import mongoose from "mongoose";

const friendshipSchema = new mongoose.Schema(
  {
    pairKey: { type: String, required: true, unique: true },
    requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" }
  },
  { timestamps: true }
);

export default mongoose.model("Friendship", friendshipSchema);
