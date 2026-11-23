import assert from "node:assert/strict";
import { createServer } from "node:http";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as createSocketClient } from "socket.io-client";
import request from "supertest";
import { createApp } from "../app.js";
import { attachRealtime } from "../realtime.js";

process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
process.env.NODE_ENV = "test";

let mongoServer;
let app;
let socketServer;
let httpServer;
let socketUrl;
const clientOrigin = "http://localhost:5173";
let uploadedAvatarPath;

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = createApp({ clientOrigin });
  httpServer = createServer(app);
  socketServer = attachRealtime(httpServer, app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  socketUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (uploadedAvatarPath) await unlink(uploadedAvatarPath).catch(() => undefined);
  await new Promise((resolve) => socketServer.close(resolve));
  await mongoose.disconnect();
  await mongoServer?.stop();
});

async function register(username) {
  const agent = request.agent(app);
  const result = await agent.post("/api/auth/register").set("Origin", clientOrigin).send({
    username, email: `${username}@example.com`, password: "long-password-123"
  });
  assert.equal(result.status, 201);
  return { agent, user: result.body.user, cookie: result.headers["set-cookie"][0].split(";")[0] };
}

function openSocket(cookie) {
  return new Promise((resolve, reject) => {
    const client = createSocketClient(socketUrl, {
      transports: ["websocket"],
      extraHeaders: cookie ? { Cookie: cookie } : {}
    });
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error("Socket connection timed out"));
    }, 5000);
    client.once("connect", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("connect_error", (error) => {
      clearTimeout(timeout);
      client.close();
      reject(error);
    });
  });
}

test("friend requests, communities, permissions, and messages require valid membership", async () => {
  const first = await register("player_first");
  const second = await register("player_second");
  const origin = { Origin: clientOrigin };

  const selfRequest = await first.agent.post(`/api/social/friends/${first.user.id}`).set(origin);
  assert.equal(selfRequest.status, 400);

  const sent = await first.agent.post(`/api/social/friends/${second.user.id}`).set(origin);
  assert.equal(sent.status, 201);
  const outgoingSearch = await first.agent.get("/api/social/users").query({ q: "player_second" }).set(origin);
  assert.equal(outgoingSearch.body.users[0].requestDirection, "outgoing");
  const incomingSearch = await second.agent.get("/api/social/users").query({ q: "player_first" }).set(origin);
  assert.equal(incomingSearch.body.users[0].requestDirection, "incoming");
  assert.equal(incomingSearch.body.users[0].requestId, sent.body.request._id);
  const duplicate = await first.agent.post(`/api/social/friends/${second.user.id}`).set(origin);
  assert.equal(duplicate.status, 409);

  const incoming = await second.agent.get("/api/social/friends/requests").set(origin);
  assert.equal(incoming.body.incoming.length, 1);
  const accepted = await second.agent.patch(
    `/api/social/friends/requests/${sent.body.request._id}/accept`
  ).set(origin);
  assert.equal(accepted.status, 200);
  const acceptedSearch = await first.agent.get("/api/social/users").query({ q: "player_second" }).set(origin);
  assert.equal(acceptedSearch.body.users[0].relationship, "accepted");
  const friendList = await first.agent.get("/api/social/friends").set(origin);
  assert.equal(friendList.body.friends[0].username, "player_second");

  const created = await first.agent.post("/api/social/communities").set(origin).send({
    name: "Night Owls", description: "Late-night sessions", isPublic: true
  });
  assert.equal(created.status, 201);
  const communityId = created.body.community._id;
  const ownedCommunities = await first.agent.get("/api/social/communities/mine").set(origin);
  assert.equal(ownedCommunities.body.communities[0].memberCount, 1);
  const descriptionSearch = await first.agent.get("/api/social/communities").query({ q: "late-night" }).set(origin);
  assert.equal(descriptionSearch.body.communities[0]._id, communityId);
  const forbiddenChannel = await second.agent.post(`/api/social/communities/${communityId}/channels`)
    .set(origin).send({ name: "random", type: "text" });
  assert.equal(forbiddenChannel.status, 403);

  const joined = await second.agent.post(`/api/social/communities/${communityId}/join`).set(origin);
  assert.equal(joined.status, 201);
  const secondCommunities = await second.agent.get("/api/social/communities/mine").set(origin);
  assert.equal(secondCommunities.body.communities[0].memberCount, 2);
  const promoted = await first.agent.patch(`/api/social/communities/${communityId}/members/${second.user.id}`)
    .set(origin).send({ role: "moderator" });
  assert.equal(promoted.status, 200);
  const createdChannel = await second.agent.post(`/api/social/communities/${communityId}/channels`)
    .set(origin).send({ name: "squad-chat", type: "text" });
  assert.equal(createdChannel.status, 201);
  const channelId = createdChannel.body.channel._id;
  const restrictedChannel = await first.agent.post(`/api/social/communities/${communityId}/channels`)
    .set(origin).send({ name: "owner-room", type: "text", allowedRoles: ["owner"] });
  assert.equal(restrictedChannel.status, 201);
  const hiddenChannel = await second.agent.get(`/api/social/channels/${restrictedChannel.body.channel._id}`)
    .set(origin);
  assert.equal(hiddenChannel.status, 403);
  const sentMessage = await second.agent.post(`/api/social/channels/${channelId}/messages`)
    .set(origin).send({ content: "Queue up?" });
  assert.equal(sentMessage.status, 201);
  const history = await first.agent.get(`/api/social/channels/${channelId}/messages`).set(origin);
  assert.equal(history.body.messages[0].content, "Queue up?");

  const directMessage = await first.agent.post(`/api/social/conversations/direct/${second.user.id}/messages`)
    .set(origin).send({ content: "@player_second see you online!" });
  assert.equal(directMessage.status, 201);
  const directHistory = await second.agent.get(`/api/social/conversations/direct/${first.user.id}/messages`).set(origin);
  assert.equal(directHistory.body.messages[0].content, "@player_second see you online!");
  assert.ok(directHistory.body.messages[0].readBy.some((id) => String(id) === String(second.user.id)));
  const mention = await second.agent.get("/api/social/notifications").set(origin);
  assert.ok(mention.body.notifications.some((notification) => notification.type === "mention"));

  const announcement = await first.agent.post(`/api/social/communities/${communityId}/announcements`)
    .set(origin).send({ message: "Gather up at 8!" });
  assert.equal(announcement.status, 201);
  const announcementNotification = await second.agent.get("/api/social/notifications").set(origin);
  assert.ok(announcementNotification.body.notifications.some((notification) => notification.type === "announcement"));

  const removedFriend = await first.agent.delete(`/api/social/friends/${second.user.id}`).set(origin);
  assert.equal(removedFriend.status, 204);
  const updatedFriendList = await first.agent.get("/api/social/friends").set(origin);
  assert.deepEqual(updatedFriendList.body.friends, []);
});

test("conversation inbox returns latest activity and unread message previews", async () => {
  const sender = await register("inbox_sender");
  const recipient = await register("inbox_recipient");
  const origin = { Origin: clientOrigin };
  const firstMessage = await sender.agent.post(`/api/social/conversations/direct/${recipient.user.id}/messages`)
    .set(origin).send({ content: "Earlier note" });
  assert.equal(firstMessage.status, 201);
  const latestMessage = await sender.agent.post(`/api/social/conversations/direct/${recipient.user.id}/messages`)
    .set(origin).send({ content: "Latest note" });
  assert.equal(latestMessage.status, 201);

  const inbox = await recipient.agent.get("/api/social/conversations").set(origin);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.conversations[0].unreadCount, 2);
  assert.equal(inbox.body.conversations[0].latestUnread.content, "Latest note");
  assert.equal(inbox.body.conversations[0].lastMessage.content, "Latest note");

  const history = await recipient.agent.get(`/api/social/conversations/direct/${sender.user.id}/messages`).set(origin);
  assert.equal(history.status, 200);
  const readInbox = await recipient.agent.get("/api/social/conversations").set(origin);
  assert.equal(readInbox.body.conversations[0].unreadCount, 0);
  assert.equal(readInbox.body.conversations[0].latestUnread, null);
});

test("private communities require an invitation and reject malformed input", async () => {
  const owner = await register("private_owner");
  const guest = await register("private_guest");
  const origin = { Origin: clientOrigin };
  const created = await owner.agent.post("/api/social/communities").set(origin).send({
    name: "Invite Only", isPublic: false
  });
  const communityId = created.body.community._id;

  const blocked = await guest.agent.get(`/api/social/communities/${communityId}`).set(origin);
  assert.equal(blocked.status, 403);
  const invitationResponse = await owner.agent.post(`/api/social/communities/${communityId}/invitations`).set(origin);
  assert.equal(invitationResponse.status, 201);
  const invitation = await guest.agent.post(
    `/api/social/invitations/${invitationResponse.body.invitation.token}/accept`
  ).set(origin);
  assert.equal(invitation.status, 201);

  const invalidMessage = await guest.agent.post("/api/social/conversations/direct/not-an-id/messages")
    .set(origin).send({ content: "hello" });
  assert.equal(invalidMessage.status, 400);
  const missingRecipient = await guest.agent.post(`/api/social/conversations/direct/${new mongoose.Types.ObjectId()}/messages`)
    .set(origin).send({ content: "hello" });
  assert.equal(missingRecipient.status, 404);
});

test("group conversations persist messages and authorize every participant", async () => {
  const creator = await register("group_creator");
  const memberA = await register("group_member_a");
  const memberB = await register("group_member_b");
  const outsider = await register("group_outsider");
  const origin = { Origin: clientOrigin };
  const created = await creator.agent.post("/api/social/conversations/group").set(origin).send({
    name: "Friday squad",
    participantIds: [memberA.user.id, memberB.user.id]
  });
  assert.equal(created.status, 201);
  const conversationId = created.body.conversation._id;
  const message = await creator.agent.post(`/api/social/conversations/${conversationId}/messages`)
    .set(origin).send({ content: "Anyone free tonight?" });
  assert.equal(message.status, 201);
  const unreadConversation = await memberA.agent.get("/api/social/conversations").set(origin);
  assert.equal(unreadConversation.body.conversations[0].unreadCount, 1);
  assert.equal(unreadConversation.body.conversations[0].latestUnread.content, "Anyone free tonight?");
  const history = await memberA.agent.get(`/api/social/conversations/${conversationId}/messages`).set(origin);
  assert.equal(history.body.messages[0].content, "Anyone free tonight?");
  const denied = await outsider.agent.get(`/api/social/conversations/${conversationId}/messages`).set(origin);
  assert.equal(denied.status, 404);
});

test("avatar uploads accept valid image signatures and reject spoofed content", async () => {
  const { agent } = await register("avatar_player");
  const origin = { Origin: clientOrigin };
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0c8AAAAASUVORK5CYII=",
    "base64"
  );
  const uploaded = await agent.patch("/api/social/profile").set(origin)
    .attach("avatar", pixel, { filename: "avatar.png", contentType: "image/png" });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.user.avatar, /^\/uploads\/[a-f0-9-]+\.png$/);
  uploadedAvatarPath = path.join(process.cwd(), uploaded.body.user.avatar.slice("/uploads/".length));
  const avatarImage = await request(app).get(uploaded.body.user.avatar);
  assert.equal(avatarImage.status, 200);
  assert.equal(avatarImage.headers["cross-origin-resource-policy"], "cross-origin");

  const spoofed = await agent.patch("/api/social/profile").set(origin)
    .attach("avatar", Buffer.from("not an image"), { filename: "avatar.png", contentType: "image/png" });
  assert.equal(spoofed.status, 400);
});

test("Socket.IO rejects unauthenticated clients and tracks multiple sessions", async () => {
  await assert.rejects(openSocket(null), /Authentication required/);
  const firstUser = await register("socket_player");
  const observerUser = await register("socket_observer");
  const friendRequest = await firstUser.agent.post(`/api/social/friends/${observerUser.user.id}`)
    .set("Origin", clientOrigin);
  assert.equal(friendRequest.status, 201);
  const acceptedFriend = await observerUser.agent.patch(
    `/api/social/friends/requests/${friendRequest.body.request._id}/accept`
  ).set("Origin", clientOrigin);
  assert.equal(acceptedFriend.status, 200);
  const firstSession = await openSocket(firstUser.cookie);
  const secondSession = await openSocket(firstUser.cookie);
  const observer = await openSocket(observerUser.cookie);
  const forbiddenMessage = await new Promise((resolve) => {
    observer.emit("message:send", {
      channelId: new mongoose.Types.ObjectId().toString(),
      content: "not allowed"
    }, resolve);
  });
  assert.equal(forbiddenMessage.error, "Message access denied");

  const waitForPresence = (client, userId, status) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Presence did not become ${status}`)), 3000);
    client.on("presence:update", function listen(presence) {
      if (String(presence.userId) !== String(userId) || presence.status !== status) return;
      clearTimeout(timeout);
      client.off("presence:update", listen);
      resolve(presence);
    });
  });

  const stillOnline = waitForPresence(secondSession, firstUser.user.id, "online");
  firstSession.disconnect();
  assert.equal((await stillOnline).status, "online");

  const offline = waitForPresence(observer, firstUser.user.id, "offline");
  secondSession.disconnect();
  assert.equal((await offline).status, "offline");
  observer.disconnect();
});

test("voice channels allow joined members to exchange peer signals only", async () => {
  const owner = await register("voice_owner");
  const member = await register("voice_member");
  const outsider = await register("voice_outsider");
  const origin = { Origin: clientOrigin };
  const community = await owner.agent.post("/api/social/communities").set(origin).send({
    name: "Voice room", isPublic: true
  });
  assert.equal(community.status, 201);
  const communityId = community.body.community._id;
  assert.equal((await member.agent.post(`/api/social/communities/${communityId}/join`).set(origin)).status, 201);
  const channel = await owner.agent.post(`/api/social/communities/${communityId}/channels`)
    .set(origin).send({ name: "lounge", type: "voice" });
  assert.equal(channel.status, 201);
  const channelId = channel.body.channel._id;
  const textChannel = await owner.agent.post(`/api/social/communities/${communityId}/channels`)
    .set(origin).send({ name: "general-chat", type: "text" });
  assert.equal(textChannel.status, 201);

  const ownerSocket = await openSocket(owner.cookie);
  const memberSocket = await openSocket(member.cookie);
  const outsiderSocket = await openSocket(outsider.cookie);
  const ownerJoin = await new Promise((resolve) => ownerSocket.emit("channel:join", channelId, resolve));
  assert.equal(ownerJoin.joined, true);
  assert.deepEqual(ownerJoin.peers, []);

  const peerJoined = new Promise((resolve) => ownerSocket.once("voice:peer-joined", resolve));
  const memberJoin = await new Promise((resolve) => memberSocket.emit("channel:join", channelId, resolve));
  assert.equal(memberJoin.joined, true);
  assert.equal(memberJoin.peers.length, 1);
  assert.equal(memberJoin.peers[0].user.username, owner.user.username);
  assert.equal((await peerJoined).user.username, member.user.username);

  await new Promise((resolve) => ownerSocket.emit("channel:join", textChannel.body.channel._id, resolve));
  await new Promise((resolve) => memberSocket.emit("channel:join", textChannel.body.channel._id, resolve));
  const textChannelSignal = await new Promise((resolve) => ownerSocket.emit("voice:signal", {
    channelId: textChannel.body.channel._id,
    to: memberSocket.id,
    signal: { type: "offer", sdp: "not-a-voice-channel" }
  }, resolve));
  assert.equal(textChannelSignal.error, "Voice channel access denied");

  const receivedSignal = new Promise((resolve) => memberSocket.once("voice:signal", resolve));
  const sentSignal = await new Promise((resolve) => ownerSocket.emit("voice:signal", {
    channelId, to: memberSocket.id, signal: { type: "offer", sdp: "test-sdp" }
  }, resolve));
  assert.equal(sentSignal.sent, true);
  assert.equal((await receivedSignal).signal.sdp, "test-sdp");

  const deniedSignal = await new Promise((resolve) => outsiderSocket.emit("voice:signal", {
    channelId, to: memberSocket.id, signal: { type: "offer", sdp: "not-authorized" }
  }, resolve));
  assert.equal(deniedSignal.error, "Voice channel access denied");
  const replacementSocket = await openSocket(member.cookie);
  const sessionReplaced = new Promise((resolve) => memberSocket.once("voice:session-replaced", resolve));
  const duplicatePeerLeft = new Promise((resolve) => ownerSocket.once("voice:peer-left", resolve));
  const replacementJoin = await new Promise((resolve) => replacementSocket.emit("channel:join", channelId, resolve));
  assert.equal(replacementJoin.joined, true);
  assert.equal(replacementJoin.peers.length, 1);
  assert.equal((await sessionReplaced).channelId, channelId);
  assert.equal((await duplicatePeerLeft).socketId, memberSocket.id);

  const peerLeft = new Promise((resolve) => ownerSocket.once("voice:peer-left", resolve));
  const accessRevoked = new Promise((resolve) => replacementSocket.once("channel:access-revoked", resolve));
  const removed = await owner.agent.delete(`/api/social/communities/${communityId}/members/${member.user.id}`)
    .set(origin);
  assert.equal(removed.status, 204);
  assert.equal((await peerLeft).socketId, replacementSocket.id);
  assert.equal((await accessRevoked).communityId, communityId);
  ownerSocket.disconnect();
  memberSocket.disconnect();
  replacementSocket.disconnect();
  outsiderSocket.disconnect();
});
