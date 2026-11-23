import mongoose from "mongoose";

const invitationSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, select: false },
    community: { type: mongoose.Schema.Types.ObjectId, ref: "Community", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  { timestamps: true }
);

export default mongoose.model("Invitation", invitationSchema);
