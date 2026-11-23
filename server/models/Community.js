import mongoose from "mongoose";

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["owner", "admin", "moderator", "member"], default: "member" },
    joinedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    icon: { type: String, trim: true, maxlength: 2048, default: "" },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: { type: [memberSchema], default: [] },
    isPublic: { type: Boolean, default: true }
  },
  { timestamps: true }
);

communitySchema.index({ isPublic: 1, name: 1 });
export default mongoose.model("Community", communitySchema);
