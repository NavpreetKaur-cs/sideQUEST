import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Channel from "../models/Channel.js";
import Community from "../models/Community.js";
import Conversation from "../models/Conversation.js";
import Friendship from "../models/Friendship.js";
import Invitation from "../models/Invitation.js";
import Message from "../models/Message.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import Game from "../models/Game.js";
import { publishPresenceForUser } from "../realtime.js";

const userFields = "username avatar bio status createdAt";
const uploadDirectory = fileURLToPath(new URL("../uploads/", import.meta.url));
const isId = mongoose.isValidObjectId;
const pairKey = (left, right) => [left.toString(), right.toString()].sort().join(":");
const emitToUser = (req, userId, event, data) => req.app.get("io")?.to(`user:${userId}`).emit(event, data);
const refreshSocial = (req, ...userIds) => {
  for (const userId of new Set(userIds.map((id) => id.toString()))) {
    emitToUser(req, userId, "social:refresh", {});
  }
};

async function notify(req, { recipient, actor, type, message, link = "" }) {
  const notification = await Notification.create({ recipient, actor, type, message, link });
  const populated = await notification.populate("actor", userFields);
  emitToUser(req, recipient, "notification:new", populated);
  return populated;
}

export async function updateCommunityMember(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canManageServer(membership.role)) return res.status(403).json({ message: "Manage members permission required" });
    const target = community.members.find((entry) => entry.user.equals(req.params.userId));
    if (!target || target.role === "owner") return res.status(404).json({ message: "Member not found" });
    if (membership.role !== "owner" && req.body.role === "admin") {
      return res.status(403).json({ message: "Only the owner can assign admin roles" });
    }
    target.role = req.body.role;
    await community.save();
    await revokeUnauthorizedChannelSockets(req, community._id);
    refreshSocial(req, ...community.members.map((entry) => entry.user), req.params.userId);
    return res.json({ member: target });
  } catch (error) {
    return next(error);
  }
}

export async function removeCommunityMember(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canManageServer(membership.role)) return res.status(403).json({ message: "Manage members permission required" });
    const target = community.members.find((entry) => entry.user.equals(req.params.userId));
    if (!target || target.role === "owner") return res.status(404).json({ message: "Member not found" });
    if (membership.role === "admin" && target.role === "admin") return res.status(403).json({ message: "Admins cannot remove another admin" });
    community.members = community.members.filter((entry) => !entry.user.equals(req.params.userId));
    await community.save();
    await revokeUnauthorizedChannelSockets(req, community._id);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function getMembership(communityId, userId) {
  const community = await Community.findById(communityId);
  const membership = community?.members.find((entry) => entry.user.equals(userId));
  return { community, membership };
}

async function revokeUnauthorizedChannelSockets(req, communityId) {
  const io = req.app.get("io");
  if (!io) return;
  const [community, channels] = await Promise.all([
    Community.findById(communityId).select("members"),
    Channel.find({ community: communityId }).select("_id allowedRoles")
  ]);
  for (const channel of channels) {
    const room = `channel:${channel._id}`;
    const sockets = await io.in(room).fetchSockets();
    for (const socket of sockets) {
      const membership = community?.members.find((entry) => entry.user.equals(socket.data.user._id));
      if (!membership || !channel.allowedRoles.includes(membership.role)) {
        io.to(room).except(socket.id).emit("voice:peer-left", { socketId: socket.id });
        await io.in(socket.id).socketsLeave(room);
        socket.emit("channel:access-revoked", {
          channelId: channel._id.toString(),
          communityId: communityId.toString(),
          message: "Your access to this channel has changed."
        });
      }
    }
  }
}

async function closeChannelSockets(req, channelIds, communityId) {
  const io = req.app.get("io");
  if (!io || !channelIds.length) return;
  for (const channelId of channelIds) {
    const room = `channel:${channelId}`;
    const sockets = await io.in(room).fetchSockets();
    for (const socket of sockets) {
      io.to(room).except(socket.id).emit("voice:peer-left", { socketId: socket.id });
      await io.in(socket.id).socketsLeave(room);
      socket.emit("channel:access-revoked", {
        channelId: channelId.toString(),
        communityId: communityId.toString(),
        message: "This channel is no longer available."
      });
    }
  }
}

export async function getConversationMessages(req, res, next) {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId, participants: req.auth.userId
    });
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });
    await Message.updateMany({
      conversation: conversation._id, author: { $ne: req.auth.userId },
      readBy: { $ne: req.auth.userId }
    }, { $addToSet: { readBy: req.auth.userId } });
    req.app.get("io")?.to(`conversation:${conversation._id}`).emit("message:read", {
      conversationId: conversation._id, userId: req.auth.userId, readAt: new Date()
    });
    const messages = await Message.find({ conversation: conversation._id }).populate("author", userFields)
      .sort({ createdAt: -1 }).limit(100);
    return res.json({ conversation, messages: messages.reverse().map(asMessage) });
  } catch (error) {
    return next(error);
  }
}

function canManageServer(role) {
  return role === "owner" || role === "admin";
}

function canManageChannels(role) {
  return ["owner", "admin", "moderator"].includes(role);
}

function canInvite(role) {
  return ["owner", "admin", "moderator"].includes(role);
}

function asMessage(message) {
  return {
    id: message._id,
    channelId: message.channel || null,
    conversationId: message.conversation || null,
    content: message.deletedAt ? "This message was deleted." : message.content,
    deleted: Boolean(message.deletedAt),
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    readBy: message.readBy,
    author: message.author
  };
}

export async function searchUsers(req, res, next) {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2) return res.json({ users: [] });
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await User.find({
      username: { $regex: escaped, $options: "i" },
      _id: { $ne: req.auth.userId }
    }).select(userFields).limit(20);
    const relationships = await Friendship.find({
      pairKey: { $in: users.map((user) => pairKey(req.auth.userId, user._id)) },
      status: { $in: ["pending", "accepted"] }
    }).select("pairKey requester recipient status");
    const byPair = new Map(relationships.map((relation) => [relation.pairKey, relation]));
    return res.json({
      users: users.map((user) => {
        const relation = byPair.get(pairKey(req.auth.userId, user._id));
        return {
          ...user.toObject(),
          relationship: relation?.status || "none",
          requestDirection: relation?.status === "pending"
            ? (relation.requester.equals(req.auth.userId) ? "outgoing" : "incoming")
            : null,
          requestId: relation?.status === "pending" ? relation._id : null
        };
      })
    });
  } catch (error) {
    return next(error);
  }
}

export async function getProfile(req, res, next) {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).select(userFields);
    if (!user) return res.status(404).json({ message: "User not found" });
    const [friendsCount, friendship, publishedGames, communities] = await Promise.all([
      Friendship.countDocuments({ status: "accepted", $or: [{ requester: user._id }, { recipient: user._id }] }),
      Friendship.findOne({ pairKey: pairKey(req.auth.userId, user._id), status: { $in: ["pending", "accepted"] } }),
      Game.find({ owner: user._id, status: "published" }).select("title publicSlug thumbnailPath plays likesCount genre createdAt").sort({ createdAt: -1 }).limit(20),
      Community.find({ "members.user": user._id }).select("name icon description isPublic members createdAt").limit(30)
    ]);
    const relations = await Friendship.find({ status: "accepted", $or: [{ requester: user._id }, { recipient: user._id }] });
    const friendIds = relations.map((item) => item.requester.equals(user._id) ? item.recipient : item.requester);
    const friends = await User.find({ _id: { $in: friendIds } }).select(userFields).limit(30);
    return res.json({
      user: { ...user.toObject(), friendsCount, gamesCount: publishedGames.length, communitiesCount: communities.length },
      publishedGames, communities, friends, activity: publishedGames.map((game) => ({ type: "game_published", game, createdAt: game.createdAt })),
      relationship: friendship?.status || "none",
      requestDirection: friendship?.status === "pending"
        ? (friendship.requester.equals(req.auth.userId) ? "outgoing" : "incoming")
        : null,
      requestId: friendship?._id || null
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateProfile(req, res, next) {
  try {
    const updates = {};
    for (const field of ["username", "bio", "avatar", "status"]) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (req.file) {
      const { buffer } = req.file;
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isWebp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
      if (!isJpeg && !isPng && !isWebp) return res.status(400).json({ message: "Uploaded file is not a valid image" });
      const extension = isJpeg ? "jpg" : isPng ? "png" : "webp";
      const filename = `${crypto.randomUUID()}.${extension}`;
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(path.join(uploadDirectory, filename), buffer, { flag: "wx" });
      updates.avatar = `/uploads/${filename}`;
    }
    if (updates.avatar && !req.file && !/^https?:\/\//i.test(updates.avatar)) {
      return res.status(400).json({ message: "Avatar must be an HTTPS or HTTP image URL" });
    }
    const user = await User.findByIdAndUpdate(req.auth.userId, updates, {
      new: true, runValidators: true
    }).select(userFields);
    return res.json({ user });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "Username is already taken" });
    return next(error);
  }
}

export async function listFriends(req, res, next) {
  try {
    const relations = await Friendship.find({
      status: "accepted",
      $or: [{ requester: req.auth.userId }, { recipient: req.auth.userId }]
    });
    const ids = relations.map((relation) =>
      relation.requester.equals(req.auth.userId) ? relation.recipient : relation.requester
    );
    const friends = await User.find({ _id: { $in: ids } }).select(userFields).sort({ username: 1 });
    return res.json({ friends });
  } catch (error) {
    return next(error);
  }
}

export async function listFriendRequests(req, res, next) {
  try {
    const requests = await Friendship.find({
      status: "pending",
      $or: [{ requester: req.auth.userId }, { recipient: req.auth.userId }]
    }).populate("requester recipient", userFields).sort({ createdAt: -1 });
    return res.json({
      incoming: requests.filter((item) => item.recipient._id.equals(req.auth.userId)),
      outgoing: requests.filter((item) => item.requester._id.equals(req.auth.userId))
    });
  } catch (error) {
    return next(error);
  }
}

export async function sendFriendRequest(req, res, next) {
  try {
    const { userId } = req.params;
    if (!isId(userId) || userId === req.auth.userId) {
      return res.status(400).json({ message: "Choose another valid user" });
    }
    const recipient = await User.findById(userId).select("username");
    if (!recipient) return res.status(404).json({ message: "User not found" });
    const key = pairKey(req.auth.userId, userId);
    const existing = await Friendship.findOne({ pairKey: key });
    if (existing?.status === "accepted") return res.status(409).json({ message: "You are already friends" });
    if (existing?.status === "pending") return res.status(409).json({ message: "A request already exists" });
    const request = existing
      ? await Friendship.findByIdAndUpdate(existing._id, {
        requester: req.auth.userId, recipient: userId, status: "pending"
      }, { new: true })
      : await Friendship.create({ pairKey: key, requester: req.auth.userId, recipient: userId });
    await notify(req, {
      recipient: userId, actor: req.auth.userId, type: "friend_request",
      message: `@${req.user.username} sent you a friend request`
    });
    refreshSocial(req, userId);
    return res.status(201).json({ request });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "A request already exists" });
    return next(error);
  }
}

export async function respondFriendRequest(req, res, next) {
  try {
    const { requestId, decision } = req.params;
    if (!isId(requestId) || !["accept", "reject"].includes(decision)) {
      return res.status(400).json({ message: "Invalid request or decision" });
    }
    const request = await Friendship.findOne({
      _id: requestId, recipient: req.auth.userId, status: "pending"
    }).populate("requester", "username");
    if (!request) return res.status(404).json({ message: "Friend request not found" });
    request.status = decision === "accept" ? "accepted" : "rejected";
    await request.save();
    if (decision === "accept") {
      const io = req.app.get("io");
      if (io) {
        await publishPresenceForUser(io, request.requester._id);
        await publishPresenceForUser(io, req.auth.userId);
      }
      await notify(req, {
        recipient: request.requester._id, actor: req.auth.userId, type: "friend_accepted",
        message: `@${req.user.username} accepted your friend request`
      });
    }
    refreshSocial(req, request.requester._id, req.auth.userId);
    return res.json({ request });
  } catch (error) {
    return next(error);
  }
}

export async function cancelFriendRequest(req, res, next) {
  try {
    const request = await Friendship.findOneAndDelete({
      _id: req.params.requestId, requester: req.auth.userId, status: "pending"
    });
    if (!request) return res.status(404).json({ message: "Outgoing request not found" });
    refreshSocial(req, request.requester, request.recipient);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function removeFriend(req, res, next) {
  try {
    if (!isId(req.params.userId) || req.params.userId === req.auth.userId) {
      return res.status(400).json({ message: "Choose another valid user" });
    }
    const removed = await Friendship.findOneAndDelete({
      pairKey: pairKey(req.auth.userId, req.params.userId), status: "accepted"
    });
    if (!removed) return res.status(404).json({ message: "Friend not found" });
    const io = req.app.get("io");
    io?.to(`user:${req.params.userId}`).emit("presence:remove", { userId: req.auth.userId });
    io?.to(`user:${req.auth.userId}`).emit("presence:remove", { userId: req.params.userId });
    refreshSocial(req, req.auth.userId, req.params.userId);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function searchCommunities(req, res, next) {
  try {
    const query = String(req.query.q || "").trim();
    const filter = { isPublic: true };
    if (query) {
      const pattern = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      filter.$or = [{ name: pattern }, { description: pattern }];
    }
    const communities = await Community.find(filter)
      .select("name description icon owner members createdAt").populate("owner", "username avatar")
      .sort({ createdAt: -1 }).limit(30);
    return res.json({
      communities: communities.map((community) => ({
        ...community.toObject(),
        isMember: community.members.some((member) => member.user.equals(req.auth.userId)),
        memberCount: community.members.length,
        members: undefined
      }))
    });
  } catch (error) {
    return next(error);
  }
}

export async function listMyCommunities(req, res, next) {
  try {
    const communities = await Community.find({ "members.user": req.auth.userId })
      .select("name description icon owner members isPublic createdAt").sort({ updatedAt: -1 });
    return res.json({
      communities: communities.map((community) => ({
        ...community.toObject(),
        memberCount: community.members.length,
        members: undefined
      }))
    });
  } catch (error) {
    return next(error);
  }
}

export async function createCommunity(req, res, next) {
  try {
    const community = await Community.create({
      name: req.body.name,
      description: req.body.description || "",
      isPublic: req.body.isPublic !== false,
      owner: req.auth.userId,
      members: [{ user: req.auth.userId, role: "owner" }]
    });
    await Channel.create([
      { community: community._id, name: "general", type: "text", position: 0 },
      { community: community._id, name: "lounge", type: "voice", position: 1 }
    ]);
    return res.status(201).json({ community });
  } catch (error) {
    return next(error);
  }
}

export async function getCommunity(req, res, next) {
  try {
    if (!isId(req.params.communityId)) return res.status(404).json({ message: "Community not found" });
    const community = await Community.findById(req.params.communityId)
      .populate("owner", "username avatar").populate("members.user", userFields);
    if (!community) return res.status(404).json({ message: "Community not found" });
    const member = community.members.find((entry) => entry.user._id.equals(req.auth.userId));
    if (!community.isPublic && !member) return res.status(403).json({ message: "This community is invite-only" });
    const allChannels = member ? await Channel.find({ community: community._id }).sort({ position: 1 }) : [];
    const channels = member
      ? allChannels.filter((channel) => channel.allowedRoles.includes(member.role))
      : [];
    const publicCommunity = community.toObject();
    publicCommunity.memberCount = publicCommunity.members.length;
    if (!member) publicCommunity.members = [];
    return res.json({ community: publicCommunity, channels, isMember: Boolean(member), role: member?.role || null });
  } catch (error) {
    return next(error);
  }
}

export async function getChannel(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const { community, membership } = await getMembership(channel.community, req.auth.userId);
    if (!membership || !channel.allowedRoles.includes(membership.role)) {
      return res.status(403).json({ message: "Channel access denied" });
    }
    return res.json({ channel, community });
  } catch (error) {
    return next(error);
  }
}

export async function updateCommunity(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canManageServer(membership.role)) return res.status(403).json({ message: "Manage server permission required" });
    for (const field of ["name", "description", "icon", "isPublic"]) {
      if (req.body[field] !== undefined) community[field] = req.body[field];
    }
    await community.save();
    return res.json({ community });
  } catch (error) {
    return next(error);
  }
}

export async function deleteCommunity(req, res, next) {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!community.owner.equals(req.auth.userId)) return res.status(403).json({ message: "Only the owner can delete this community" });
    const channelIds = await Channel.find({ community: community._id }).distinct("_id");
    await closeChannelSockets(req, channelIds, community._id);
    await Promise.all([
      Community.deleteOne({ _id: community._id }),
      Channel.deleteMany({ community: community._id }),
      Invitation.deleteMany({ community: community._id }),
      Message.deleteMany({ channel: { $in: channelIds } })
    ]);
    refreshSocial(req, ...community.members.map((entry) => entry.user));
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function joinCommunity(req, res, next) {
  try {
    const community = await Community.findOneAndUpdate(
      { _id: req.params.communityId, isPublic: true, "members.user": { $ne: req.auth.userId } },
      { $push: { members: { user: req.auth.userId, role: "member" } } },
      { new: true }
    );
    if (!community) {
      const current = await Community.findById(req.params.communityId);
      if (!current) return res.status(404).json({ message: "Community not found" });
      if (!current.isPublic) return res.status(403).json({ message: "An invitation is required" });
      return res.status(409).json({ message: "You are already a member" });
    }
    return res.status(201).json({ community });
  } catch (error) {
    return next(error);
  }
}

export async function leaveCommunity(req, res, next) {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (community.owner.equals(req.auth.userId)) return res.status(400).json({ message: "The owner must transfer ownership before leaving" });
    const result = await Community.updateOne(
      { _id: community._id },
      { $pull: { members: { user: req.auth.userId } } }
    );
    if (!result.modifiedCount) return res.status(404).json({ message: "You are not a member" });
    await revokeUnauthorizedChannelSockets(req, community._id);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function transferCommunityOwnership(req, res, next) {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!community.owner.equals(req.auth.userId)) return res.status(403).json({ message: "Only the owner can transfer ownership" });
    const target = community.members.find((entry) => entry.user.equals(req.body.userId));
    if (!target || target.user.equals(req.auth.userId)) return res.status(400).json({ message: "Choose another community member" });
    const previous = community.members.find((entry) => entry.user.equals(req.auth.userId));
    previous.role = "admin"; target.role = "owner"; community.owner = target.user;
    await community.save(); refreshSocial(req, ...community.members.map((entry) => entry.user));
    return res.json({ community });
  } catch (error) { return next(error); }
}

export async function inviteFriendToGame(req, res, next) {
  try {
    const friend = await Friendship.exists({ status: "accepted", $or: [{ requester: req.auth.userId, recipient: req.params.userId }, { requester: req.params.userId, recipient: req.auth.userId }] });
    if (!friend) return res.status(403).json({ message: "You can only invite friends" });
    const game = await Game.findOne({ _id: req.body.gameId, status: "published" }).select("title publicSlug");
    if (!game) return res.status(404).json({ message: "Published game not found" });
    await notify(req, { recipient: req.params.userId, actor: req.auth.userId, type: "game_invite", message: `@${req.user.username} invited you to play ${game.title}`, link: `/play/${game.publicSlug}` });
    return res.status(201).json({ invited: true });
  } catch (error) { return next(error); }
}

export async function listCommunityMembers(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership) return res.status(403).json({ message: "Server membership required" });
    const members = await Community.findById(community._id).populate("members.user", userFields);
    const query = String(req.query.q || "").trim();
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const visibleMembers = query
      ? members.members.filter((entry) => new RegExp(escaped, "i").test(entry.user.username))
      : members.members;
    return res.json({ members: visibleMembers });
  } catch (error) {
    return next(error);
  }
}

export async function createInvitation(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canInvite(membership.role)) return res.status(403).json({ message: "Create invitation permission required" });
    if (community.isPublic) return res.status(400).json({ message: "Public communities do not need invitations" });
    const token = crypto.randomBytes(24).toString("base64url");
    const invitation = await Invitation.create({
      token, community: community._id, createdBy: req.auth.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    return res.status(201).json({ invitation: { token, expiresAt: invitation.expiresAt } });
  } catch (error) {
    return next(error);
  }
}

export async function acceptInvitation(req, res, next) {
  try {
    const invitation = await Invitation.findOne({ token: req.params.token }).select("+token");
    if (!invitation || invitation.expiresAt <= new Date()) return res.status(404).json({ message: "Invitation is invalid or expired" });
    const result = await Community.updateOne(
      { _id: invitation.community, "members.user": { $ne: req.auth.userId } },
      { $push: { members: { user: req.auth.userId, role: "member" } } }
    );
    if (!result.modifiedCount) return res.status(409).json({ message: "You are already a member or the community no longer exists" });
    await notify(req, {
      recipient: invitation.createdBy, actor: req.auth.userId, type: "server_invite",
      message: `@${req.user.username} joined your community`,
      link: `/communities/${invitation.community}`
    });
    return res.status(201).json({ communityId: invitation.community });
  } catch (error) {
    return next(error);
  }
}

export async function createChannel(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canManageChannels(membership.role)) return res.status(403).json({ message: "Manage channels permission required" });
    const position = await Channel.countDocuments({ community: community._id });
    const channel = await Channel.create({
      community: community._id, name: req.body.name,
      description: req.body.description || "", type: req.body.type || "text", position,
      ...(req.body.allowedRoles ? { allowedRoles: req.body.allowedRoles } : {})
    });
    return res.status(201).json({ channel });
  } catch (error) {
    return next(error);
  }
}

export async function updateChannel(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel || channel.community.toString() !== req.params.communityId) return res.status(404).json({ message: "Channel not found" });
    const { membership } = await getMembership(channel.community, req.auth.userId);
    if (!membership || !canManageChannels(membership.role)) return res.status(403).json({ message: "Manage channels permission required" });
    const typeChanged = req.body.type !== undefined && req.body.type !== channel.type;
    for (const field of ["name", "description", "type", "position", "allowedRoles"]) {
      if (req.body[field] !== undefined) channel[field] = req.body[field];
    }
    await channel.save();
    if (typeChanged) await closeChannelSockets(req, [channel._id], channel.community);
    else await revokeUnauthorizedChannelSockets(req, channel.community);
    return res.json({ channel });
  } catch (error) {
    return next(error);
  }
}

export async function deleteChannel(req, res, next) {
  try {
    const channel = await Channel.findOne({ _id: req.params.channelId, community: req.params.communityId });
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const { membership } = await getMembership(channel.community, req.auth.userId);
    if (!membership || !canManageChannels(membership.role)) return res.status(403).json({ message: "Manage channels permission required" });
    await closeChannelSockets(req, [channel._id], channel.community);
    await Promise.all([channel.deleteOne(), Message.deleteMany({ channel: channel._id })]);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function getOrCreateDirect(userId, otherId) {
  const key = pairKey(userId, otherId);
  try {
    return await Conversation.findOneAndUpdate(
      { pairKey: key },
      { $setOnInsert: { pairKey: key, type: "direct", participants: [userId, otherId] } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const conversation = await Conversation.findOne({ pairKey: key });
    if (!conversation) throw error;
    return conversation;
  }
}

export async function listConversations(req, res, next) {
  try {
    const conversations = await Conversation.find({ participants: req.auth.userId })
      .populate("participants", userFields).sort({ updatedAt: -1 });
    const ids = conversations.map((item) => item._id);
    const [latest, unreadMessages] = await Promise.all([
      Message.aggregate([
        { $match: { conversation: { $in: ids } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$conversation", content: { $first: "$content" }, createdAt: { $first: "$createdAt" } } }
      ]),
      Message.find({
        conversation: { $in: ids },
        author: { $ne: req.auth.userId },
        readBy: { $ne: req.auth.userId }
      }).populate("author", userFields).sort({ createdAt: -1 })
    ]);
    const lastById = new Map(latest.map((item) => [item._id.toString(), item]));
    const unreadById = new Map();
    for (const message of unreadMessages) {
      const key = message.conversation.toString();
      const entry = unreadById.get(key) || { unreadCount: 0, latestUnread: asMessage(message) };
      entry.unreadCount += 1;
      unreadById.set(key, entry);
    }
    return res.json({
      conversations: conversations.map((item) => {
        const key = item._id.toString();
        const unread = unreadById.get(key);
        return {
          ...item.toObject(),
          lastMessage: lastById.get(key) || null,
          unreadCount: unread?.unreadCount || 0,
          latestUnread: unread?.latestUnread || null
        };
      }).sort((first, second) =>
        new Date(second.lastMessage?.createdAt || second.updatedAt) -
        new Date(first.lastMessage?.createdAt || first.updatedAt)
      )
    });
  } catch (error) {
    return next(error);
  }
}

export async function createGroupConversation(req, res, next) {
  try {
    const uniqueIds = [...new Set([req.auth.userId, ...req.body.participantIds])];
    if (uniqueIds.length < 3 || uniqueIds.length > 20 || uniqueIds.some((id) => !isId(id))) {
      return res.status(400).json({ message: "Group conversations need 2 to 19 valid other participants" });
    }
    const users = await User.countDocuments({ _id: { $in: uniqueIds } });
    if (users !== uniqueIds.length) return res.status(400).json({ message: "One or more participants do not exist" });
    const conversation = await Conversation.create({
      type: "group", participants: uniqueIds, name: req.body.name || ""
    });
    return res.status(201).json({ conversation });
  } catch (error) {
    return next(error);
  }
}

export async function getDirectMessages(req, res, next) {
  try {
    if (!isId(req.params.userId) || req.params.userId === req.auth.userId) return res.status(400).json({ message: "Choose another valid user" });
    const other = await User.findById(req.params.userId).select(userFields);
    if (!other) return res.status(404).json({ message: "User not found" });
    const conversation = await getOrCreateDirect(req.auth.userId, req.params.userId);
    await conversation.populate("participants", userFields);
    await Message.updateMany({
      conversation: conversation._id,
      author: { $ne: req.auth.userId },
      readBy: { $ne: req.auth.userId }
    }, { $addToSet: { readBy: req.auth.userId } });
    req.app.get("io")?.to(`conversation:${conversation._id}`).emit("message:read", {
      conversationId: conversation._id, userId: req.auth.userId, readAt: new Date()
    });
    const messages = await Message.find({ conversation: conversation._id }).populate("author", userFields)
      .sort({ createdAt: -1 }).limit(100);
    return res.json({ conversation, messages: messages.reverse().map(asMessage) });
  } catch (error) {
    return next(error);
  }
}

export async function getChannelMessages(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const { membership } = await getMembership(channel.community, req.auth.userId);
    if (!membership || !channel.allowedRoles.includes(membership.role)) {
      return res.status(403).json({ message: "Channel access denied" });
    }
    await Message.updateMany({
      channel: channel._id, author: { $ne: req.auth.userId },
      readBy: { $ne: req.auth.userId }
    }, { $addToSet: { readBy: req.auth.userId } });
    req.app.get("io")?.to(`channel:${channel._id}`).emit("message:read", {
      channelId: channel._id, userId: req.auth.userId, readAt: new Date()
    });
    const messages = await Message.find({ channel: channel._id }).populate("author", userFields)
      .sort({ createdAt: -1 }).limit(100);
    return res.json({ messages: messages.reverse().map(asMessage) });
  } catch (error) {
    return next(error);
  }
}

async function createMessage(req, res, channel, conversation) {
  const message = await Message.create({
    author: req.auth.userId, content: req.body.content,
    readBy: [req.auth.userId],
    ...(channel ? { channel: channel._id } : { conversation: conversation._id })
  });
  await message.populate("author", userFields);
  const response = asMessage(message);
  const io = req.app.get("io");
  if (channel) {
    io?.to(`channel:${channel._id}`).emit("message:new", response);
  } else {
    for (const participant of conversation.participants) {
      emitToUser(req, participant, "message:new", response);
      if (participant.toString() !== req.auth.userId) {
        await notify(req, {
          recipient: participant, actor: req.auth.userId, type: "direct_message",
          message: `New message from @${req.user.username}`
        });
      }
    }
  }
  const mentions = [...new Set([...message.content.matchAll(/@([a-z0-9_]{3,24})/gi)].map((match) => match[1].toLowerCase()))];
  if (mentions.length) {
    const mentionedUsers = await User.find({
      username: { $in: mentions }, _id: { $ne: req.auth.userId }
    }).select("_id");
    for (const mentioned of mentionedUsers) {
      if (channel) {
        const community = await Community.findOne({
          _id: channel.community, "members.user": mentioned._id
        }).select("members");
        const member = community?.members.find((entry) => entry.user.equals(mentioned._id));
        if (!member || !channel.allowedRoles.includes(member.role)) continue;
      } else if (!conversation.participants.some((participant) => participant.equals(mentioned._id))) {
        continue;
      }
      await notify(req, {
        recipient: mentioned._id, actor: req.auth.userId, type: "mention",
        message: `@${req.user.username} mentioned you`,
        link: channel ? `/channels/${channel._id}` : `/messages/${mentioned._id}`
      });
    }
  }
  return response;
}

export async function sendDirectMessage(req, res, next) {
  try {
    if (!isId(req.params.userId) || req.params.userId === req.auth.userId) return res.status(400).json({ message: "Choose another valid user" });
    const recipient = await User.exists({ _id: req.params.userId });
    if (!recipient) return res.status(404).json({ message: "User not found" });
    const conversation = await getOrCreateDirect(req.auth.userId, req.params.userId);
    const message = await createMessage(req, res, null, conversation);
    return res.status(201).json({ message });
  } catch (error) {
    return next(error);
  }
}

export async function sendGroupMessage(req, res, next) {
  try {
    if (!isId(req.params.conversationId)) return res.status(404).json({ message: "Conversation not found" });
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId, type: "group", participants: req.auth.userId
    });
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });
    const message = await createMessage(req, res, null, conversation);
    return res.status(201).json({ message });
  } catch (error) {
    return next(error);
  }
}

export async function markConversationRead(req, res, next) {
  try {
    if (!isId(req.params.conversationId)) return res.status(400).json({ message: "Invalid conversation id" });
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId, participants: req.auth.userId
    }).populate("participants", userFields);
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });
    await Message.updateMany({
      conversation: conversation._id,
      author: { $ne: req.auth.userId },
      readBy: { $ne: req.auth.userId }
    }, { $addToSet: { readBy: req.auth.userId } });
    req.app.get("io")?.to(`conversation:${conversation._id}`).emit("message:read", {
      conversationId: conversation._id, userId: req.auth.userId, readAt: new Date()
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

export async function sendChannelMessage(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const { membership } = await getMembership(channel.community, req.auth.userId);
    if (!membership || !channel.allowedRoles.includes(membership.role)) {
      return res.status(403).json({ message: "Channel access denied" });
    }
    if (channel.type !== "text") return res.status(400).json({ message: "Messages can only be sent to text channels" });
    const message = await createMessage(req, res, channel, null);
    return res.status(201).json({ message });
  } catch (error) {
    return next(error);
  }
}

export async function editMessage(req, res, next) {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message || message.deletedAt) return res.status(404).json({ message: "Message not found" });
    if (message.channel) {
      const channel = await Channel.findById(message.channel);
      const { membership } = channel
        ? await getMembership(channel.community, req.auth.userId)
        : { membership: null };
      if (!channel || !membership || !channel.allowedRoles.includes(membership.role)) {
        return res.status(404).json({ message: "Message not found" });
      }
    } else if (!await Conversation.exists({ _id: message.conversation, participants: req.auth.userId })) {
      return res.status(404).json({ message: "Message not found" });
    }
    if (!message.author.equals(req.auth.userId)) return res.status(403).json({ message: "Only the author can edit this message" });
    message.content = req.body.content;
    message.editedAt = new Date();
    await message.save();
    await message.populate("author", userFields);
    const result = asMessage(message);
    if (message.channel) req.app.get("io")?.to(`channel:${message.channel}`).emit("message:updated", result);
    else {
      const conversation = await Conversation.findById(message.conversation);
      conversation?.participants.forEach((id) => emitToUser(req, id, "message:updated", result));
    }
    return res.json({ message: result });
  } catch (error) {
    return next(error);
  }
}

export async function deleteMessage(req, res, next) {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message || message.deletedAt) return res.status(404).json({ message: "Message not found" });
    let authorized = false;
    if (message.channel) {
      const channel = await Channel.findById(message.channel);
      const { membership } = await getMembership(channel?.community, req.auth.userId);
      if (!channel || !membership || !channel.allowedRoles.includes(membership.role)) {
        return res.status(404).json({ message: "Message not found" });
      }
      authorized = message.author.equals(req.auth.userId) || canManageChannels(membership.role);
    } else if (message.conversation) {
      const participant = await Conversation.exists({
        _id: message.conversation, participants: req.auth.userId
      });
      if (!participant) return res.status(404).json({ message: "Message not found" });
      authorized = message.author.equals(req.auth.userId);
    }
    if (!authorized) return res.status(403).json({ message: "Delete message permission required" });
    message.content = "";
    message.deletedAt = new Date();
    await message.save();
    const result = asMessage(message);
    if (message.channel) req.app.get("io")?.to(`channel:${message.channel}`).emit("message:updated", result);
    else {
      const conversation = await Conversation.findById(message.conversation);
      conversation?.participants.forEach((id) => emitToUser(req, id, "message:updated", result));
    }
    return res.json({ message: result });
  } catch (error) {
    return next(error);
  }
}

export async function listNotifications(req, res, next) {
  try {
    const notifications = await Notification.find({ recipient: req.auth.userId })
      .populate("actor", userFields).sort({ createdAt: -1 }).limit(40);
    return res.json({ notifications });
  } catch (error) {
    return next(error);
  }
}

export async function readNotifications(req, res, next) {
  try {
    const filter = { recipient: req.auth.userId, readAt: null };
    if (req.params.notificationId !== "all") {
      if (!isId(req.params.notificationId)) return res.status(400).json({ message: "Invalid notification id" });
      filter._id = req.params.notificationId;
    }
    const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    return res.json({ updated: result.modifiedCount });
  } catch (error) {
    return next(error);
  }
}

export async function createAnnouncement(req, res, next) {
  try {
    const { community, membership } = await getMembership(req.params.communityId, req.auth.userId);
    if (!community) return res.status(404).json({ message: "Community not found" });
    if (!membership || !canManageServer(membership.role)) return res.status(403).json({ message: "Manage server permission required" });
    const recipients = community.members
      .map((member) => member.user)
      .filter((memberId) => !memberId.equals(req.auth.userId));
    const created = await Notification.insertMany(recipients.map((recipient) => ({
      recipient, actor: req.auth.userId, type: "announcement",
      message: `Announcement in ${community.name}: ${req.body.message}`.slice(0, 240),
      link: `/servers/${community._id}`
    })));
    const populated = await Promise.all(created.map((item) => item.populate("actor", userFields)));
    for (const notification of populated) emitToUser(req, notification.recipient, "notification:new", notification);
    return res.status(201).json({ notified: populated.length });
  } catch (error) {
    return next(error);
  }
}

export { getMembership };
