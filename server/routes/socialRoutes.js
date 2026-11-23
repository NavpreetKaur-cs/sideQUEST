import { Router } from "express";
import mongoose from "mongoose";
import { body, param, query } from "express-validator";
import rateLimit from "express-rate-limit";
import * as social from "../controllers/socialController.js";
import { authenticate } from "../middleware/authenticate.js";
import { loadCurrentUser } from "../middleware/loadCurrentUser.js";
import { parseAvatar } from "../middleware/avatarUpload.js";
import { validateRequest } from "../middleware/validateRequest.js";

const router = Router();
const id = (name) => param(name).isMongoId().withMessage("Invalid identifier");
const messageContent = body("content").trim().isLength({ min: 1, max: 4000 });
const channelIdParam = id("channelId");
const communityIdParam = id("communityId");
const profileRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: "draft-7", legacyHeaders: false
});

router.use(authenticate, loadCurrentUser);

router.get("/users", query("q").optional().isString().isLength({ max: 80 }), validateRequest, social.searchUsers);
router.get("/users/:username", param("username").matches(/^[a-zA-Z0-9_]{3,24}$/), validateRequest, social.getProfile);
router.patch("/profile", profileRateLimit, parseAvatar, [
  body("username").optional().matches(/^[a-zA-Z0-9_]{3,24}$/),
  body("bio").optional().isString().trim().isLength({ max: 300 }),
  body("avatar").optional({ checkFalsy: true }).isURL({ protocols: ["http", "https"], require_protocol: true }).isLength({ max: 2048 }),
  body("status").optional().isIn(["offline", "idle", "dnd"]),
  body().custom((value, { req }) => Boolean(req.file) || (
    Object.keys(value).some((key) => ["username", "bio", "avatar", "status"].includes(key))
    && Object.keys(value).every((key) => ["username", "bio", "avatar", "status"].includes(key))
  ))
], validateRequest, social.updateProfile);

router.get("/friends", social.listFriends);
router.get("/friends/requests", social.listFriendRequests);
router.post("/friends/:userId", id("userId"), validateRequest, social.sendFriendRequest);
router.patch("/friends/requests/:requestId/:decision", id("requestId"), param("decision").isIn(["accept", "reject"]), validateRequest, social.respondFriendRequest);
router.delete("/friends/requests/:requestId", id("requestId"), validateRequest, social.cancelFriendRequest);
router.delete("/friends/:userId", id("userId"), validateRequest, social.removeFriend);
router.post("/friends/:userId/invite-game", id("userId"), body("gameId").isMongoId(), validateRequest, social.inviteFriendToGame);

router.get("/communities", query("q").optional().isString().isLength({ max: 80 }), validateRequest, social.searchCommunities);
router.get("/communities/mine", social.listMyCommunities);
router.post("/communities", [
  body("name").trim().isLength({ min: 2, max: 60 }),
  body("description").optional().isString().trim().isLength({ max: 500 }),
  body("isPublic").optional().isBoolean().toBoolean(),
  body("icon").optional().isURL({ protocols: ["http", "https"], require_protocol: true }).isLength({ max: 2048 })
], validateRequest, social.createCommunity);
router.get("/communities/:communityId", communityIdParam, validateRequest, social.getCommunity);
router.patch("/communities/:communityId", communityIdParam, [
  body("name").optional().trim().isLength({ min: 2, max: 60 }),
  body("description").optional().isString().trim().isLength({ max: 500 }),
  body("icon").optional().isURL({ protocols: ["http", "https"], require_protocol: true }).isLength({ max: 2048 }),
  body("isPublic").optional().isBoolean().toBoolean(),
  body().custom((value) => Object.keys(value).length > 0)
], validateRequest, social.updateCommunity);
router.delete("/communities/:communityId", communityIdParam, validateRequest, social.deleteCommunity);
router.post("/communities/:communityId/join", communityIdParam, validateRequest, social.joinCommunity);
router.post("/communities/:communityId/leave", communityIdParam, validateRequest, social.leaveCommunity);
router.post("/communities/:communityId/transfer", communityIdParam, body("userId").isMongoId(), validateRequest, social.transferCommunityOwnership);
router.get("/communities/:communityId/members", communityIdParam, query("q").optional().isString().isLength({ max: 80 }), validateRequest, social.listCommunityMembers);
router.patch("/communities/:communityId/members/:userId", communityIdParam, id("userId"), body("role").isIn(["admin", "moderator", "member"]), validateRequest, social.updateCommunityMember);
router.delete("/communities/:communityId/members/:userId", communityIdParam, id("userId"), validateRequest, social.removeCommunityMember);
router.post("/communities/:communityId/announcements", communityIdParam, body("message").trim().isLength({ min: 1, max: 200 }), validateRequest, social.createAnnouncement);
router.post("/communities/:communityId/invitations", communityIdParam, validateRequest, social.createInvitation);
router.post("/invitations/:token/accept", param("token").matches(/^[A-Za-z0-9_-]{32,64}$/), validateRequest, social.acceptInvitation);

router.post("/communities/:communityId/channels", communityIdParam, [
  body("name").trim().matches(/^[a-zA-Z0-9_-]{2,60}$/),
  body("description").optional().isString().trim().isLength({ max: 300 }),
  body("type").optional().isIn(["text", "voice"]),
  body("allowedRoles").optional().isArray({ min: 1, max: 4 }),
  body("allowedRoles.*").isIn(["owner", "admin", "moderator", "member"])
], validateRequest, social.createChannel);
router.patch("/communities/:communityId/channels/:channelId", communityIdParam, channelIdParam, [
  body("name").optional().trim().matches(/^[a-zA-Z0-9_-]{2,60}$/),
  body("description").optional().isString().trim().isLength({ max: 300 }),
  body("type").optional().isIn(["text", "voice"]),
  body("position").optional().isInt({ min: 0, max: 500 }),
  body("allowedRoles").optional().isArray({ min: 1, max: 4 }),
  body("allowedRoles.*").optional().isIn(["owner", "admin", "moderator", "member"])
], validateRequest, social.updateChannel);
router.delete("/communities/:communityId/channels/:channelId", communityIdParam, channelIdParam, validateRequest, social.deleteChannel);

router.get("/conversations", social.listConversations);
router.post("/conversations/group", [
  body("participantIds").isArray({ min: 2, max: 19 }),
  body("participantIds.*").isMongoId(),
  body("name").optional().isString().trim().isLength({ max: 80 })
], validateRequest, social.createGroupConversation);
router.get("/conversations/direct/:userId/messages", id("userId"), validateRequest, social.getDirectMessages);
router.post("/conversations/direct/:userId/messages", id("userId"), messageContent, validateRequest, social.sendDirectMessage);
router.post("/conversations/:conversationId/read", id("conversationId"), validateRequest, social.markConversationRead);
router.get("/conversations/:conversationId/messages", id("conversationId"), validateRequest, social.getConversationMessages);
router.post("/conversations/:conversationId/messages", id("conversationId"), messageContent, validateRequest, social.sendGroupMessage);
router.get("/channels/:channelId", channelIdParam, validateRequest, social.getChannel);
router.get("/channels/:channelId/messages", channelIdParam, validateRequest, social.getChannelMessages);
router.post("/channels/:channelId/messages", channelIdParam, messageContent, validateRequest, social.sendChannelMessage);
router.patch("/messages/:messageId", id("messageId"), messageContent, validateRequest, social.editMessage);
router.delete("/messages/:messageId", id("messageId"), validateRequest, social.deleteMessage);

router.get("/notifications", social.listNotifications);
router.patch("/notifications/:notificationId/read", param("notificationId").custom((value) => value === "all" || mongoose.isValidObjectId(value)), validateRequest, social.readNotifications);

export default router;
