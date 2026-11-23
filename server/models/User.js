import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 24,
      match: /^[a-z0-9_]+$/,
      unique: true
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      unique: true
    },
    password: {
      type: String,
      select: false
    },
    providers: {
      type: [{ provider: { type: String, enum: ["google"], required: true }, providerId: { type: String, required: true } }],
      default: [],
      select: false
    },
    avatar: {
      type: String,
      default: "",
      maxlength: 2048
    },
    bio:{
      type: String,
      default: "",
      maxlength: 300
    },
    status: {
      type: String,
      enum: ["offline", "idle", "dnd"],
      default: "offline"
    }
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);