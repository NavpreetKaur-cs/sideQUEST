import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import Channel from "./models/Channel.js";
import Community from "./models/Community.js";
import Conversation from "./models/Conversation.js";
import Friendship from "./models/Friendship.js";
import Message from "./models/Message.js";
import Notification from "./models/Notification.js";
import User from "./models/User.js";
import { getClientOrigins } from "./config/clientOrigins.js";

const userFields = "username avatar status";
const activeUsers = new Map();
const voiceJoinLocks = new Map();
const cookieValue = (header, name) => {
  const part = header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
};

function withVoiceJoinLock(key, operation) {
  const previous = voiceJoinLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  voiceJoinLocks.set(key, current);
  return previous.then(operation).finally(() => {
    release();
    if (voiceJoinLocks.get(key) === current) voiceJoinLocks.delete(key);
  });
}

function publicPresence(userId, entry) {
  return {
    userId,
    status: entry.sockets.size ? (entry.preference === "idle" || entry.preference === "dnd" ? entry.preference : "online") : "offline",
    game: entry.game || null
  };
}

async function broadcastPresence(io, userId) {
  const entry = activeUsers.get(userId);
  const relationships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: userId }, { recipient: userId }]
  }).select("requester recipient");
  const friendIds = relationships.map((relation) =>
    relation.requester.toString() === userId ? relation.recipient : relation.requester
  );
  const update = publicPresence(userId, entry || { sockets: new Set(), preference: "offline" });
  io.to(`user:${userId}`).emit("presence:update", update);
  for (const friendId of friendIds) io.to(`user:${friendId}`).emit("presence:update", update);
}

async function getPresenceSnapshot(userId) {
  const relationships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: userId }, { recipient: userId }]
  }).select("requester recipient");
  const friends = relationships.map((relation) =>
    relation.requester.toString() === userId ? relation.recipient : relation.requester
  );
  return [userId, ...friends.map((friendId) => friendId.toString())].map((id) =>
    publicPresence(id, activeUsers.get(id) || { sockets: new Set(), preference: "offline" })
  );
}

export function attachRealtime(server, app) {
  const io = new Server(server, {
    cors: {
      origin: getClientOrigins(process.env.CLIENT_ORIGIN || "http://localhost:5173"),
      credentials: true
    }
  });
  app.set("io", io);

  io.use(async (socket, next) => {
    try {
      const token = cookieValue(socket.handshake.headers.cookie, "session");
      if (!token) return next(new Error("Authentication required"));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (typeof payload !== "object" || !payload.sub) return next(new Error("Invalid session"));
      const user = await User.findById(payload.sub).select(userFields);
      if (!user) return next(new Error("Session user no longer exists"));
      socket.data.user = user;
      return next();
    } catch {
      return next(new Error("Invalid session"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.user._id.toString();
    let presence = activeUsers.get(userId);
    if (!presence) {
      presence = { sockets: new Set(), preference: socket.data.user.status, game: null };
      activeUsers.set(userId, presence);
    }
    presence.sockets.add(socket.id);
    socket.join(`user:${userId}`);
    try {
      await broadcastPresence(io, userId);
      socket.emit("presence:snapshot", await getPresenceSnapshot(userId));
    } catch (error) {
      console.error(`Presence initialization failed: ${error.message}`);
      socket.emit("socket:error", { message: "Presence could not be loaded" });
    }

    socket.on("presence:set", async (status, acknowledge = () => {}) => {
      if (!["idle", "dnd", "offline"].includes(status)) {
        acknowledge({ error: "Unsupported status" });
        return;
      }
      try {
        await User.updateOne({ _id: userId }, { $set: { status } });
        presence.preference = status;
        broadcastPresence(io, userId).catch((error) => {
          console.error(`Presence update failed: ${error.message}`);
        });
        acknowledge({ status: publicPresence(userId, presence).status });
      } catch {
        acknowledge({ error: "Unable to update status" });
      }
    });

    socket.on("channel:join", async (channelId, acknowledge = () => {}) => {
      try {
        const channel = await Channel.findById(channelId);
        const community = channel && await Community.findOne({
          _id: channel.community, "members.user": userId
        }).select("members");
        const membership = community?.members.find((entry) => entry.user.equals(userId));
        if (!channel || !membership || !channel.allowedRoles.includes(membership.role)) {
          acknowledge({ error: "Channel access denied" });
          return;
        }
        const room = `channel:${channel._id}`;
        const join = async () => {
          // Do not evict an existing socket for the same account. A page change or
          // transient reconnect can overlap two transports briefly; treating that as
          // a replacement made the user appear to leave the lounge. The old socket
          // naturally disappears on disconnect, while the active one remains joined.
          const activePeers = channel.type === "voice"
            ? (await io.in(room).fetchSockets()).map((peer) => ({
            socketId: peer.id,
            user: {
              id: peer.data.user._id.toString(),
              username: peer.data.user.username,
              avatar: peer.data.user.avatar
            }
          }))
            : [];
          socket.join(room);
          if (channel.type === "voice") {
          socket.to(room).emit("voice:peer-joined", {
            socketId: socket.id,
            user: {
              id: socket.data.user._id.toString(),
              username: socket.data.user.username,
              avatar: socket.data.user.avatar
            }
          });
          }
          acknowledge({ joined: true, peers: activePeers });
        };
        if (channel.type === "voice") {
          await withVoiceJoinLock(`${channel._id}:${userId}`, join);
        } else {
          await join();
        }
      } catch {
        acknowledge({ error: "Unable to join channel" });
      }
    });

    socket.on("voice:signal", async (payload = {}, acknowledge = () => {}) => {
      try {
        const { channelId, to, signal } = payload;
        if (
          typeof channelId !== "string" ||
          !/^[a-f\d]{24}$/i.test(channelId) ||
          typeof to !== "string" ||
          !signal ||
          typeof signal !== "object" ||
          !["offer", "answer", "candidate", "screen-share"].includes(signal.type) ||
          (signal.type === "screen-share" && typeof signal.active !== "boolean")
        ) {
          acknowledge({ error: "Invalid voice signal" });
          return;
        }
        const channel = await Channel.findById(channelId).select("community allowedRoles type");
        const room = channel && `channel:${channel._id}`;
        const community = channel?.type === "voice"
          ? await Community.findOne({ _id: channel.community, "members.user": userId }).select("members")
          : null;
        const membership = community?.members.find((entry) => entry.user.equals(userId));
        const target = io.sockets.sockets.get(to);
        if (
          !room ||
          !socket.rooms.has(room) ||
          !membership ||
          !channel.allowedRoles.includes(membership.role) ||
          !target?.rooms.has(room)
        ) {
          acknowledge({ error: "Voice channel access denied" });
          return;
        }
        io.to(to).emit("voice:signal", {
          from: socket.id,
          user: {
            id: socket.data.user._id.toString(),
            username: socket.data.user.username,
            avatar: socket.data.user.avatar
          },
          signal
        });
        acknowledge({ sent: true });
      } catch {
        acknowledge({ error: "Unable to send voice signal" });
      }
    });

    socket.on("conversation:join", async (conversationId, acknowledge = () => {}) => {
      try {
        const conversation = await Conversation.findOne({ _id: conversationId, participants: userId }).select("_id");
        if (!conversation) {
          acknowledge({ error: "Conversation access denied" });
          return;
        }
        socket.join(`conversation:${conversation._id}`);
        acknowledge({ joined: true });
      } catch {
        acknowledge({ error: "Unable to join conversation" });
      }
    });

    socket.on("voice:leave", async (channelId) => {
      if (typeof channelId !== "string" || !/^[a-f\d]{24}$/i.test(channelId)) return;
      const room = `channel:${channelId}`;
      if (!socket.rooms.has(room)) return;
      const channel = await Channel.findById(channelId).select("type");
      if (channel?.type !== "voice") return;
      socket.to(room).emit("voice:peer-left", { socketId: socket.id });
      socket.leave(room);
    });

    socket.on("presence:game", (game) => {
      if (game !== null && (typeof game !== "object" || typeof game.slug !== "string" || typeof game.title !== "string" || game.slug.length > 100 || game.title.length > 120)) return;
      presence.game = game ? { slug: game.slug, title: game.title } : null;
      broadcastPresence(io, userId).catch(() => {});
    });

    socket.on("room:leave", async (room) => {
      if (
        typeof room === "string" &&
        /^(channel|conversation):[a-f\d]{24}$/i.test(room) &&
        socket.rooms.has(room)
      ) {
        if (room.startsWith("channel:")) {
          const channel = await Channel.findById(room.slice("channel:".length)).select("type");
          // Generic room cleanup is used by page navigation. Voice presence is
          // intentionally retained until the user explicitly leaves the call.
          if (channel?.type === "voice") return;
          socket.to(room).emit("voice:peer-left", { socketId: socket.id });
        }
        socket.leave(room);
      }
    });

    socket.on("typing:start", async ({ channelId, conversationId } = {}) => {
      try {
        const room = await authorizedRoom(userId, channelId, conversationId);
        if (room) socket.to(room).emit("typing:update", { user: socket.data.user, active: true });
      } catch {
        socket.emit("socket:error", { message: "Typing access denied" });
      }
    });
    socket.on("typing:stop", async ({ channelId, conversationId } = {}) => {
      try {
        const room = await authorizedRoom(userId, channelId, conversationId);
        if (room) socket.to(room).emit("typing:update", { user: socket.data.user, active: false });
      } catch {
        socket.emit("socket:error", { message: "Typing access denied" });
      }
    });

    socket.on("message:send", async (payload = {}, acknowledge = () => {}) => {
      try {
        if (typeof payload.content !== "string" || !payload.content.trim() || payload.content.trim().length > 4000) {
          acknowledge({ error: "Message must be between 1 and 4000 characters" });
          return;
        }
        const target = await authorizedMessageTarget(userId, payload.channelId, payload.conversationId);
        if (!target) {
          acknowledge({ error: "Message access denied" });
          return;
        }
        const messageData = {
          author: userId,
          content: payload.content.trim(),
          readBy: [userId],
          ...(payload.channelId ? { channel: payload.channelId } : { conversation: payload.conversationId })
        };
        const message = await Message.create(messageData);
        await message.populate("author", userFields);
        const response = {
          id: message._id,
          channelId: message.channel || null,
          conversationId: message.conversation || null,
          content: message.content,
          createdAt: message.createdAt,
          editedAt: null, deleted: false, readBy: [userId], author: message.author
        };
        if (target.channel) {
          io.to(`channel:${target.channel._id}`).emit("message:new", response);
        } else {
          // Conversation rooms are only joined while a chat is open. Deliver to the
          // user room as well so direct and group messages reliably reach recipients
          // who are elsewhere in the app (or have another tab open).
          for (const participant of target.conversation.participants) {
            io.to(`user:${participant}`).emit("message:new", response);
            if (participant.equals(userId)) continue;
            const notification = await Notification.create({
              recipient: participant, actor: userId, type: "direct_message",
              message: `New message from @${socket.data.user.username}`
            });
            await notification.populate("actor", userFields);
            io.to(`user:${participant}`).emit("notification:new", notification);
          }
        }
        acknowledge({ message: response });
      } catch {
        acknowledge({ error: "Unable to send message" });
      }
    });

    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("channel:")) {
          socket.to(room).emit("voice:peer-left", { socketId: socket.id });
        }
      }
    });

    socket.on("disconnect", () => {
      const current = activeUsers.get(userId);
      if (!current) return;
      current.sockets.delete(socket.id);
      if (current.sockets.size === 0) activeUsers.delete(userId);
      broadcastPresence(io, userId).catch((error) => {
        console.error(`Presence update failed: ${error.message}`);
      });
    });
  });
  return io;
}

export function publishPresenceForUser(io, userId) {
  return broadcastPresence(io, userId.toString());
}

async function authorizedMessageTarget(userId, channelId, conversationId) {
  if (channelId && !conversationId) {
    const channel = await Channel.findById(channelId).select("community allowedRoles type");
    if (!channel) return null;
    const community = await Community.findOne({
      _id: channel.community, "members.user": userId
    }).select("members");
    const membership = community?.members.find((entry) => entry.user.equals(userId));
    return membership && channel.type === "text" && channel.allowedRoles.includes(membership.role)
      ? { channel }
      : null;
  }
  if (conversationId && !channelId) {
    const conversation = await Conversation.findOne({ _id: conversationId, participants: userId }).select("participants");
    return conversation ? { conversation } : null;
  }
  return null;
}

async function authorizedRoom(userId, channelId, conversationId) {
  if (channelId && !conversationId) {
    const channel = await Channel.findById(channelId).select("community allowedRoles");
    if (!channel) return null;
    const community = await Community.findOne({
      _id: channel.community, "members.user": userId
    }).select("members");
    const membership = community?.members.find((entry) => entry.user.equals(userId));
    return membership && channel.allowedRoles.includes(membership.role) ? `channel:${channelId}` : null;
  }
  if (conversationId && !channelId) {
    const conversation = await Conversation.exists({ _id: conversationId, participants: userId });
    return conversation ? `conversation:${conversationId}` : null;
  }
  return null;
}
