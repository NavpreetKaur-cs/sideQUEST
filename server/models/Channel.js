import mongoose from "mongoose";

const channelSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: "Community", required: true, index: true },
    name: { type: String, required: true, trim: true, lowercase: true, minlength: 2, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    type: { type: String, enum: ["text", "voice"], default: "text" },
    position: { type: Number, default: 0 },
    allowedRoles: {
      type: [{ type: String, enum: ["owner", "admin", "moderator", "member"] }],
      default: ["owner", "admin", "moderator", "member"]
    }
  },
  { timestamps: true }
);

channelSchema.index({ community: 1, position: 1 });
export default mongoose.model("Channel", channelSchema);
