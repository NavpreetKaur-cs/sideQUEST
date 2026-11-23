import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["direct", "group"], required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    pairKey: { type: String, unique: true, sparse: true },
    name: { type: String, trim: true, maxlength: 80, default: "" }
  },
  { timestamps: true }
);

export default mongoose.model("Conversation", conversationSchema);
