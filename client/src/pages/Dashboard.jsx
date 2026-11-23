import {
  ArrowDown, ArrowUp, Bell, ChevronDown, Compass, Hash, LogOut, Maximize, Megaphone, MessageCircle,
  Minimize,
  Mic, MicOff, MonitorUp, Phone, PhoneOff, Plus, Search, Send, Settings, Sparkles,
  Trash2, Upload, Gamepad2, Play, Users, Volume2, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { useAuth } from "../hooks/useAuth";
import api, { gamePlayUrl, gamePreviewUrl } from "../services/api";
import heroArtwork from "../assets/hero.png";

const social = (path) => `/social${path}`;
const apiOrigin = (api.defaults.baseURL || "").replace(/\/api\/?$/, "");
const gameArtwork = (game) => game?.thumbnail ? `${apiOrigin}${game.thumbnail}` : heroArtwork;
const statusNames = { online: "Online", idle: "Away", dnd: "Do not disturb", offline: "Offline" };

function Avatar({ user, size = "" }) {
  const name = user?.username || "player";
  const image = user?.avatar?.startsWith("/") ? `${apiOrigin}${user.avatar}` : user?.avatar;
  return image
    ? <AvatarImage key={image} image={image} name={name} size={size} />
    : <span className={`avatar avatar-fallback ${size}`} aria-hidden="true">{name.slice(0, 2)}</span>;
}

function AvatarImage({ image, name, size }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className={`avatar avatar-fallback ${size}`} aria-hidden="true">{name.slice(0, 2)}</span>
    : <img className={`avatar ${size}`} src={image} alt="" onError={() => setFailed(true)} />;
}

function ScreenShareView({ stream, label }) {
  const viewerRef = useRef(null);
  const videoRef = useRef(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const viewer = viewerRef.current;
    if (video) {
      video.srcObject = stream || null;
      video.play().catch(() => undefined);
    }
    const updateExpanded = () => setExpanded(document.fullscreenElement === viewer);
    document.addEventListener("fullscreenchange", updateExpanded);
    return () => {
      document.removeEventListener("fullscreenchange", updateExpanded);
      if (video) video.srcObject = null;
    };
  }, [stream]);

  async function toggleExpanded() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (document.fullscreenElement === viewer) {
      try {
        await document.exitFullscreen();
      } catch {
        setExpanded(false);
      }
      return;
    }
    if (expanded && !document.fullscreenElement) {
      setExpanded(false);
      return;
    }
    try {
      if (viewer.requestFullscreen) await viewer.requestFullscreen();
      else setExpanded(true);
    } catch {
      setExpanded(true);
    }
  }

  return (
    <div
      className={`screen-share-viewer ${expanded && !document.fullscreenElement ? "screen-share-expanded" : ""}`}
      ref={viewerRef}
      onDoubleClick={toggleExpanded}
    >
      <video ref={videoRef} className="screen-share-video" autoPlay playsInline muted />
      <div className="screen-share-toolbar" onDoubleClick={(event) => event.stopPropagation()}>
        <span>{label}</span>
        <button type="button" onClick={toggleExpanded} aria-label={expanded ? "Minimize screen share" : "Expand screen share"}>
          {expanded ? <Minimize size={16} /> : <Maximize size={16} />}
          <span>{expanded ? "Minimize" : "Full screen"}</span>
        </button>
      </div>
    </div>
  );
}

function RemoteVoiceParticipant({ participant }) {
  const audioRef = useRef(null);
  useEffect(() => {
    const stream = participant.stream;
    const audio = audioRef.current;
    if (audio) audio.srcObject = stream || null;
    return () => {
      if (audio) audio.srcObject = null;
    };
  }, [participant.stream]);
  return (
    <article className={`voice-participant ${participant.sharing ? "sharing-video" : ""}`}>
      {participant.sharing && <ScreenShareView stream={participant.stream} label={`@${participant.user.username} is sharing`} />}
      <Avatar user={participant.user} size="large" />
      <span>@{participant.user.username}</span>
      <audio ref={audioRef} autoPlay />
    </article>
  );
}

function stopVoiceResources(localStreamRef, screenStreamRef, connectionsRef) {
  localStreamRef.current?.getTracks().forEach((track) => track.stop());
  localStreamRef.current = null;
  screenStreamRef.current?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
  screenStreamRef.current = null;
  connectionsRef.current.forEach(({ connection }) => connection.close());
  connectionsRef.current.clear();
}

function VoiceChannelView({ channel, community, currentUser, socket, visible = true, onSessionChange, leaveRequest = 0 }) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [muted, setMuted] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [voiceError, setVoiceError] = useState("");
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const connectionsRef = useRef(new Map());
  const joinedRef = useRef(false);
  const mountedRef = useRef(false);
  const channelId = String(channel._id);

  const relaySignal = useCallback((to, signal) => {
    socket.timeout(7000).emit("voice:signal", { channelId, to, signal }, (timeoutError, response) => {
      if (!mountedRef.current) return;
      if (timeoutError || response?.error) {
        setVoiceError(response?.error || "Voice signaling timed out. Check your connection and try again.");
      }
    });
  }, [channelId, socket]);

  const createPeer = useCallback((peerId, peerUser, createOffer = false) => {
    const existing = connectionsRef.current.get(peerId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const remoteStream = new MediaStream();
    const entry = {
      connection,
      remoteStream,
      pendingCandidates: [],
      user: peerUser,
      videoSender: null
    };
    connectionsRef.current.set(peerId, entry);
    localStreamRef.current?.getAudioTracks().forEach((track) => connection.addTrack(track, localStreamRef.current));
    entry.videoSender = connection.addTransceiver("video", { direction: "sendrecv" }).sender;
    if (screenStreamRef.current) {
      entry.videoSender.replaceTrack(screenStreamRef.current.getVideoTracks()[0]).catch((mediaError) => {
        if (mountedRef.current) setVoiceError(mediaError.message || "Screen share could not be sent.");
      });
    }
    connection.onicecandidate = ({ candidate }) => {
      if (candidate) relaySignal(peerId, { type: "candidate", candidate: candidate.toJSON() });
    };
    connection.ontrack = ({ track }) => {
      if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      setParticipants((current) => current.map((participant) => (
        participant.socketId === peerId ? { ...participant, stream: remoteStream } : participant
      )));
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" && mountedRef.current) {
        setVoiceError(`Voice connection to @${peerUser.username} was interrupted. They are still in the lounge.`);
      }
    };
    setParticipants((current) => current.some((participant) => participant.socketId === peerId)
      ? current
      : [...current, { socketId: peerId, user: peerUser, stream: remoteStream, sharing: false }]);

    if (createOffer) {
      connection.createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => {
          if (connection.localDescription) relaySignal(peerId, connection.localDescription.toJSON());
        })
        .catch((mediaError) => {
          if (mountedRef.current) setVoiceError(mediaError.message || "Could not connect to a lounge member.");
        });
    }
    return entry;
  }, [relaySignal]);

  const renegotiateVideo = useCallback(async (peerId, entry) => {
    if (!entry?.videoNeedsNegotiation || entry.videoNegotiating || entry.connection.signalingState !== "stable") return;
    entry.videoNegotiating = true;
    entry.videoNeedsNegotiation = false;
    try {
      await entry.connection.setLocalDescription(await entry.connection.createOffer());
      if (entry.connection.localDescription) relaySignal(peerId, entry.connection.localDescription.toJSON());
    } catch (mediaError) {
      entry.videoNeedsNegotiation = true;
      if (mountedRef.current) setVoiceError(mediaError.message || "Screen share could not be negotiated.");
    } finally {
      entry.videoNegotiating = false;
    }
  }, [relaySignal]);

  const replaceVideoForPeers = useCallback(async (track) => {
    const peers = [...connectionsRef.current.entries()];
    await Promise.all(peers.map(async ([peerId, entry]) => {
      await entry.videoSender.replaceTrack(track || null);
      // Browsers do not all activate a sender that started without a capture track.
      // A fresh offer guarantees receivers learn about the new screen track.
      entry.videoNeedsNegotiation = true;
      await renegotiateVideo(peerId, entry);
    }));
  }, [renegotiateVideo]);

  const announceScreenShare = useCallback((active) => {
    connectionsRef.current.forEach((_entry, peerId) => {
      relaySignal(peerId, { type: "screen-share", active });
    });
  }, [relaySignal]);

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    setScreenStream(null);
    setSharing(false);
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    try {
      await replaceVideoForPeers(null);
      announceScreenShare(false);
    } catch (mediaError) {
      if (mountedRef.current) setVoiceError(mediaError.message || "Screen share could not be stopped cleanly.");
    }
  }, [announceScreenShare, replaceVideoForPeers]);

  useEffect(() => {
    if (!socket) return undefined;
    mountedRef.current = true;
    const onPeerJoined = ({ socketId, user: peerUser }) => {
      // The newly joined client creates the offer. Existing clients only prepare
      // a receiver here, avoiding one-sided participant lists caused by socket-id races.
      createPeer(socketId, peerUser);
    };
    const onPeerLeft = ({ socketId }) => {
      connectionsRef.current.get(socketId)?.connection.close();
      connectionsRef.current.delete(socketId);
      setParticipants((current) => current.filter((participant) => participant.socketId !== socketId));
    };
    const onSessionReplaced = ({ channelId: replacedChannelId, socketId: replacedSocketId }) => {
      if (String(replacedChannelId) !== channelId) return;
      // Ignore an event intended for the stale transport that Socket.IO replaced
      // while this same browser was reconnecting.
      if (replacedSocketId && replacedSocketId !== socket.id) return;
      // A duplicate/stale Socket.IO transport must never end a user's call.
      // The active component keeps its media and room state until Leave voice is
      // explicitly pressed.
    };
    const onSignal = async ({ from, user: peerUser, signal }) => {
      const entry = createPeer(from, peerUser);
      const { connection } = entry;
      try {
        if (signal.type === "screen-share") {
          setParticipants((current) => current.map((participant) => (
            participant.socketId === from ? { ...participant, sharing: signal.active } : participant
          )));
          return;
        }
        if (signal.type === "candidate") {
          if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
          else entry.pendingCandidates.push(signal.candidate);
          return;
        }
        await connection.setRemoteDescription(signal);
        while (entry.pendingCandidates.length) {
          await connection.addIceCandidate(entry.pendingCandidates.shift());
        }
        if (signal.type === "offer") {
          await connection.setLocalDescription(await connection.createAnswer());
          if (connection.localDescription) relaySignal(from, connection.localDescription.toJSON());
        }
        await renegotiateVideo(from, entry);
      } catch (mediaError) {
        if (mountedRef.current) setVoiceError(mediaError.message || "Voice connection negotiation failed.");
      }
    };
    const onSocketReconnect = () => {
      if (!joinedRef.current) return;
      // Socket.IO assigns a new id after reconnecting. Existing peer connections
      // target the old id, so discard them before rebuilding the voice mesh.
      connectionsRef.current.forEach(({ connection }) => connection.close());
      connectionsRef.current.clear();
      setParticipants([]);
      setJoining(true);
      socket.timeout(10000).emit("channel:join", channelId, (timeoutError, response) => {
        setJoining(false);
        if (!mountedRef.current || timeoutError || response?.error) {
          if (mountedRef.current) setVoiceError(response?.error || "The lounge could not be rejoined after reconnecting. Please leave and join again.");
          return;
        }
        setVoiceError("");
        setJoined(true);
        (response.peers || []).forEach((peer) => {
          createPeer(peer.socketId, peer.user, true);
        });
      });
    };
    socket.on("voice:peer-joined", onPeerJoined);
    socket.on("voice:peer-left", onPeerLeft);
    socket.on("voice:session-replaced", onSessionReplaced);
    socket.on("voice:signal", onSignal);
    socket.on("connect", onSocketReconnect);
    return () => {
      mountedRef.current = false;
      socket.off("voice:peer-joined", onPeerJoined);
      socket.off("voice:peer-left", onPeerLeft);
      socket.off("voice:session-replaced", onSessionReplaced);
      socket.off("voice:signal", onSignal);
      socket.off("connect", onSocketReconnect);
      // This component can be re-rendered while changing pages. Navigation only
      // minimizes the lounge; it must not remove the user from the voice room.
      // leaveVoice() is the sole normal path that emits room:leave and ends media.
    };
  }, [channelId, createPeer, onSessionChange, relaySignal, renegotiateVideo, socket]);

  async function joinVoice() {
    if (joining) return;
    if (!socket?.connected) {
      setVoiceError("The live connection is unavailable. Try again in a moment.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Microphone access is not available in this browser.");
      return;
    }
    setVoiceError("");
    setJoining(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      localStreamRef.current = stream;
      socket.timeout(7000).emit("channel:join", channelId, (timeoutError, response) => {
        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setJoining(false);
        if (timeoutError || response?.error) {
          stream.getTracks().forEach((track) => track.stop());
          localStreamRef.current = null;
          setVoiceError(response?.error || "Could not join the lounge. Please try again.");
          return;
        }
        joinedRef.current = true;
        setJoined(true);
        onSessionChange?.({ channel, community });
        (response.peers || []).forEach((peer) => {
          createPeer(peer.socketId, peer.user, true);
        });
      });
    } catch (mediaError) {
      if (!mountedRef.current) return;
      setJoining(false);
      setVoiceError(mediaError.message || "Microphone access was denied.");
    }
  }

  const leaveVoice = useCallback(() => {
    if (joinedRef.current) socket.emit("voice:leave", channelId);
    joinedRef.current = false;
    setJoined(false);
    stopVoiceResources(localStreamRef, screenStreamRef, connectionsRef);
    setScreenStream(null);
    setSharing(false);
    setParticipants([]);
    onSessionChange?.(null);
  }, [channelId, onSessionChange, socket]);

  const processedLeaveRequest = useRef(0);
  useEffect(() => {
    if (leaveRequest <= processedLeaveRequest.current) return;
    processedLeaveRequest.current = leaveRequest;
    leaveVoice();
  }, [leaveRequest, leaveVoice]);

  function toggleMute() {
    const nextMuted = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  }

  async function toggleScreenShare() {
    if (sharing) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setVoiceError("Screen sharing is not available in this browser.");
      return;
    }
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      if (!mountedRef.current || !joinedRef.current) {
        stream.getTracks().forEach((item) => item.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        setVoiceError("No screen or window was selected.");
        return;
      }
      screenStreamRef.current = stream;
      setScreenStream(stream);
      try {
        await replaceVideoForPeers(track);
        announceScreenShare(true);
      } catch (mediaError) {
        screenStreamRef.current = null;
        setScreenStream(null);
        stream.getTracks().forEach((item) => {
          item.onended = null;
          item.stop();
        });
        await replaceVideoForPeers(null);
        announceScreenShare(false);
        throw mediaError;
      }
      track.onended = () => { stopScreenShare(); };
      setSharing(true);
    } catch (mediaError) {
      if (mountedRef.current) setVoiceError(mediaError.message || "Screen sharing could not be started.");
    }
  }

  return (
    <section className={`voice-view ${visible ? "" : "voice-view-hidden"}`} aria-hidden={!visible}>
      <header className="content-header">
        <div>
          <div className="chat-title"><Volume2 size={17} /> {channel.name}</div>
          <p>{community?.name} · voice lounge</p>
        </div>
        <div className="chat-header-actions"><Users size={17} /><span>{participants.length + (joined ? 1 : 0)} here</span></div>
      </header>
      {voiceError && <p className="inline-error voice-error" role="alert">{voiceError}</p>}
      <div className="voice-stage">
        {joined && <article className={`voice-participant ${screenStream ? "sharing-video" : ""}`}>
          {screenStream && <ScreenShareView stream={screenStream} label="You are sharing" />}
          <Avatar user={currentUser} size="large" />
          <span>@{currentUser.username} (you){muted ? " · muted" : ""}</span>
        </article>}
        {participants.map((participant) => <RemoteVoiceParticipant key={participant.socketId} participant={participant} />)}
        {!joined && <div className="voice-welcome"><Volume2 size={28} /><h2>Join the lounge</h2><p>Connect with your community over voice or share your screen.</p></div>}
      </div>
      <div className="voice-controls">
        {!joined ? (
          <button className="primary-button" onClick={joinVoice} disabled={joining}>
            <Phone size={16} />{joining ? "Connecting..." : "Join voice"}
          </button>
        ) : (
          <>
            <button className={`outline-button ${muted ? "voice-control-muted" : ""}`} onClick={toggleMute}>
              {muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? "Unmute" : "Mute"}
            </button>
            <button className="outline-button" onClick={toggleScreenShare} disabled={!joined}>
              <MonitorUp size={16} />{sharing ? "Stop sharing" : "Share screen"}
            </button>
            <button className="outline-button danger-button" onClick={leaveVoice}><PhoneOff size={16} /> Leave voice</button>
          </>
        )}
      </div>
    </section>
  );
}

function EmptyState({ icon: Icon = Sparkles, title, text, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={20} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function ChatView({ title, subtitle, messages, currentUser, onSend, onTyping, onEdit, onDelete, typingUsers = [], placeholder = "Write a message..." }) {
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");
  const bottomRef = useRef(null);
  const typingTimer = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function changeDraft(event) {
    setDraft(event.target.value);
    onTyping?.(Boolean(event.target.value));
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => onTyping?.(false), 1000);
  }

  async function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    try {
      await onSend(text);
      setDraft("");
      setSendError("");
      onTyping?.(false);
    } catch (error) {
      setSendError(error.message || "Message could not be sent.");
    }
  }

  return (
    <section className="chat-view">
      <header className="content-header chat-header">
        <div>
          <div className="chat-title"><Hash size={17} /> {title}</div>
          <p>{subtitle}</p>
        </div>
        <div className="chat-header-actions"><Users size={17} /><span>{messages.length ? "Active conversation" : "A fresh start"}</span></div>
      </header>
      <div className="message-list" aria-live="polite">
        {messages.length === 0 ? (
          <EmptyState icon={MessageCircle} title="Start the conversation" text="Say hello and get the good company going." />
        ) : messages.map((message) => {
          const own = String(message.author?._id || message.author?.id) === String(currentUser.id);
          return (
            <article className={`message-row ${own ? "mine" : ""}`} key={message.id || message._id}>
              <Avatar user={message.author} />
              <div className="message-copy">
                <div className="message-meta">
                  <strong>{own ? "You" : `@${message.author?.username || "player"}`}</strong>
                  <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  {message.editedAt && <span>edited</span>}
                </div>
                <p className={message.deleted ? "deleted-message" : ""}>{message.content}</p>
                {own && !message.deleted && (
                  <div className="message-tools">
                    <button type="button" onClick={() => onEdit(message)} aria-label="Edit message">Edit</button>
                    <button type="button" onClick={() => onDelete(message)} aria-label="Delete message">Delete</button>
                  </div>
                )}
                {own && message.readBy?.length > 1 && <span className="read-receipt">Seen</span>}
              </div>
            </article>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {typingUsers.length > 0 && <div className="typing-hint">{typingUsers.join(", ")} {typingUsers.length === 1 ? "is" : "are"} typing...</div>}
      {sendError && <p className="inline-error composer-error" role="alert">{sendError}</p>}
      <form className="message-composer" onSubmit={submit}>
        <input value={draft} onChange={changeDraft} maxLength={4000} placeholder={placeholder} aria-label="Message" />
        <button type="submit" disabled={!draft.trim()} aria-label="Send message"><Send size={17} /></button>
      </form>
    </section>
  );
}

function MessagesInbox({ conversations, currentUser, navigate }) {
  const sortedConversations = [...conversations].sort((first, second) =>
    new Date(second.lastMessage?.createdAt || second.updatedAt) -
    new Date(first.lastMessage?.createdAt || first.updatedAt)
  );
  return (
    <div className="page-content messages-inbox">
      <div className="page-intro"><div><span className="eyebrow">YOUR CONVERSATIONS</span><h1>Messages</h1><p>Catch up on the latest from your friends and groups.</p></div></div>
      <section className="inbox-list" aria-label="All conversations">
        {sortedConversations.length ? sortedConversations.map((conversation) => {
          const other = conversation.type === "direct"
            ? conversation.participants?.find((person) => String(person._id) !== String(currentUser.id))
            : null;
          if (conversation.type === "direct" && !other) return null;
          const title = conversation.type === "group" ? conversation.name || "Group chat" : `@${other?.username || "player"}`;
          const latestMessage = conversation.latestUnread || conversation.lastMessage;
          const preview = latestMessage?.content || "No messages yet. Say hello!";
          const timestamp = latestMessage?.createdAt;
          return (
            <button
              type="button"
              className={`inbox-row ${conversation.unreadCount ? "unread" : ""}`}
              key={conversation._id}
              onClick={() => navigate(conversation.type === "group" ? `/groups/${conversation._id}` : `/messages/${other?._id}`)}
            >
              {other ? <Avatar user={other} /> : <span className="community-mini">{(conversation.name || "G").slice(0, 1)}</span>}
              <span className="inbox-copy">
                <strong>{title}</strong>
                <span>{preview}</span>
              </span>
              <span className="inbox-meta">
                {timestamp && <time>{new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}</time>}
                {conversation.unreadCount > 0 && <i>{conversation.unreadCount}</i>}
              </span>
            </button>
          );
        }) : <EmptyState icon={MessageCircle} title="No conversations yet" text="Start a conversation with one of your friends." action={<button className="outline-button" onClick={() => navigate("/friends")}>Find friends</button>} />}
      </section>
    </div>
  );
}

export default function Dashboard() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const socketRef = useRef(null);
  const joinedRoomRef = useRef(null);
  const activeChatRef = useRef(null);
  const [socket, setSocket] = useState(null);
  const [friends, setFriends] = useState([]);
  const [communities, setCommunities] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [conversations, setConversations] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [myGames, setMyGames] = useState([]);
  const [publicGames, setPublicGames] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [presence, setPresence] = useState({});
  const [community, setCommunity] = useState(null);
  const [channel, setChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [profile, setProfile] = useState(null);
  const [isMember, setIsMember] = useState(false);
  const [communityRole, setCommunityRole] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showNotifications, setShowNotifications] = useState(false);
  const [showCreateCommunity, setShowCreateCommunity] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [newCommunity, setNewCommunity] = useState({ name: "", description: "", isPublic: true });
  const [settings, setSettings] = useState({ username: user.username, email: user.email, bio: user.bio || "", avatar: user.avatar || "", status: user.status || "offline" });
  const [voiceLounge, setVoiceLounge] = useState(null);
  const [voiceSession, setVoiceSession] = useState(null);
  const [leaveVoiceRequest, setLeaveVoiceRequest] = useState(0);
  const voiceSessionRef = useRef(null);

  const route = useMemo(() => {
    const parts = location.pathname.split("/").filter(Boolean);
    return { page: parts[0] || "home", id: parts[1] || null };
  }, [location.pathname]);
  const routeRef = useRef(route);

  const handleVoiceSessionChange = useCallback((session) => {
    voiceSessionRef.current = session;
    setVoiceSession(session);
    if (session) setVoiceLounge(session);
  }, []);

  function joinSocketRoom(kind, id) {
    const room = `${kind}:${id}`;
    if (joinedRoomRef.current && joinedRoomRef.current !== room) {
      const activeVoiceRoom = voiceSessionRef.current?.channel?._id
        ? `channel:${voiceSessionRef.current.channel._id}` : null;
      // A route-room cleanup must never be allowed to end an active lounge.
      // Voice is ended exclusively by VoiceChannelView's Leave button.
      if (joinedRoomRef.current !== activeVoiceRoom) {
        socketRef.current?.emit("room:leave", joinedRoomRef.current);
      }
    }
    joinedRoomRef.current = room;
    socketRef.current?.emit(kind === "channel" ? "channel:join" : "conversation:join", id);
  }

  const loadBase = useCallback(async () => {
    const [friendResponse, communityResponse, requestResponse, conversationResponse, notificationResponse, myGameResponse, publicGameResponse] = await Promise.all([
      api.get(social("/friends")),
      api.get(social("/communities/mine")),
      api.get(social("/friends/requests")),
      api.get(social("/conversations")),
      api.get(social("/notifications")),
      api.get("/games/mine"),
      api.get("/games/public")
    ]);
    setFriends(friendResponse.data.friends);
    setCommunities(communityResponse.data.communities);
    setRequests(requestResponse.data);
    setConversations(conversationResponse.data.conversations);
    setNotifications(notificationResponse.data.notifications);
    setMyGames(myGameResponse.data.games);
    setPublicGames(publicGameResponse.data.games);
  }, []);

  const reportInitialLoadError = useCallback((requestError) => {
    setError(requestError.response?.data?.message || "Could not load your social space.");
  }, []);

  const resetRouteView = useCallback(() => {
    setError("");
    setMessages([]);
    setCommunity(null);
    setChannel(null);
    setProfile(null);
    setInviteUrl("");
    setTypingUsers([]);
    activeChatRef.current = null;
  }, []);

  useEffect(() => {
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- Load data and report initial request failures.
    loadBase().catch((requestError) => {
      if (active) reportInitialLoadError(requestError);
    });
    const socket = io(apiOrigin, { withCredentials: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;
    setSocket(socket);
    socket.on("presence:update", ({ userId, status }) => setPresence((current) => ({ ...current, [userId]: status })));
    socket.on("presence:snapshot", (snapshot) => setPresence(Object.fromEntries(snapshot.map(({ userId, status }) => [userId, status]))));
    socket.on("presence:remove", ({ userId }) => setPresence((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    }));
    socket.on("channel:access-revoked", ({ channelId, communityId, message }) => {
      if (String(voiceSessionRef.current?.channel?._id) === String(channelId)) {
        voiceSessionRef.current = null;
        setVoiceSession(null);
        setLeaveVoiceRequest((current) => current + 1);
      }
      const currentRoute = routeRef.current;
      if (currentRoute.page !== "channels" || currentRoute.id !== String(channelId)) return;
      setError(message || "Your access to this channel has changed.");
      navigate(communityId ? `/servers/${communityId}` : "/");
    });
    socket.on("social:refresh", () => {
      loadBase().catch(reportInitialLoadError);
    });
    socket.on("notification:new", (notification) => setNotifications((current) => [notification, ...current]));
    socket.on("message:new", (message) => {
      const activeChat = activeChatRef.current;
      const isCurrent = activeChat?.channelId
        ? String(message.channelId) === activeChat.channelId
        : activeChat?.conversationId && String(message.conversationId) === activeChat.conversationId;
      if (isCurrent) setMessages((current) => (
        current.some((item) => String(item.id || item._id) === String(message.id)) ? current : [...current, message]
      ));
      if (message.conversationId) {
        const ownMessage = String(message.author?._id || message.author?.id) === String(user.id);
        if (isCurrent && !ownMessage) {
          api.post(social(`/conversations/${message.conversationId}/read`)).catch((requestError) => {
            setError(requestError.response?.data?.message || "Messages could not be marked as read.");
          });
        }
        setConversations((current) => current.map((conversation) => {
          if (String(conversation._id) !== String(message.conversationId)) return conversation;
          const unread = !ownMessage && !isCurrent;
          return {
            ...conversation,
            lastMessage: message,
            unreadCount: (conversation.unreadCount || 0) + (unread ? 1 : 0),
            latestUnread: unread ? message : conversation.latestUnread
          };
        }).sort((first, second) =>
          new Date(second.lastMessage?.createdAt || second.updatedAt) -
          new Date(first.lastMessage?.createdAt || first.updatedAt)
        ));
      }
    });
    socket.on("message:updated", (message) => {
      const activeChat = activeChatRef.current;
      const isCurrent = activeChat?.channelId
        ? String(message.channelId) === activeChat.channelId
        : activeChat?.conversationId && String(message.conversationId) === activeChat.conversationId;
      if (isCurrent) setMessages((current) => current.map((item) => (
        String(item.id || item._id) === String(message.id) ? message : item
      )));
    });
    socket.on("message:read", ({ channelId, conversationId, userId: readerId }) => {
      const activeChat = activeChatRef.current;
      const matchesChannel = channelId && String(activeChat?.channelId) === String(channelId);
      const matchesConversation = conversationId && String(activeChat?.conversationId) === String(conversationId);
      if (!matchesChannel && !matchesConversation) return;
      setMessages((current) => current.map((message) => ({
        ...message,
        readBy: message.readBy?.some((id) => String(id) === String(readerId))
          ? message.readBy : [...(message.readBy || []), readerId]
      })));
    });
    socket.on("typing:update", ({ user: typingUser, active: isTyping }) => {
      const username = typingUser?.username;
      if (username) setTypingUsers((current) => isTyping
        ? [...new Set([...current, username])]
        : current.filter((name) => name !== username));
    });
    socket.on("connect_error", () => setToast("Live updates are reconnecting."));
    return () => {
      active = false;
      socket.off("channel:access-revoked");
      socket.off("social:refresh");
      socket.disconnect();
      socketRef.current = null;
    };
  // Keep this socket for the entire authenticated dashboard session. `navigate`
  // is route-scoped in React Router and including it here recreated the socket on
  // every navigation, which disconnected a minimized voice lounge.
  }, [loadBase, reportInitialLoadError, user.id]);

  useEffect(() => {
    routeRef.current = route;
    // oxlint-disable-next-line react/set-state-in-effect -- Clear route-specific state before loading the next page.
    resetRouteView();
    let active = true;
    async function loadRoute() {
      try {
        if (route.page === "servers" && route.id) {
          const { data } = await api.get(social(`/communities/${route.id}`));
          if (active) {
            setCommunity({ ...data.community, channels: data.channels });
            setIsMember(data.isMember);
            setCommunityRole(data.role);
          }
        } else if (route.page === "channels" && route.id) {
          const channelResponse = await api.get(social(`/channels/${route.id}`));
          const isVoiceChannel = channelResponse.data.channel.type === "voice";
          const messageResponse = isVoiceChannel
            ? null
            : await api.get(social(`/channels/${route.id}/messages`));
          if (active) {
            setChannel(channelResponse.data.channel);
            setCommunity(channelResponse.data.community);
            setIsMember(true);
            if (isVoiceChannel && !voiceSessionRef.current) {
              setVoiceLounge({ channel: channelResponse.data.channel, community: channelResponse.data.community });
            }
            if (!isVoiceChannel) {
              setMessages(messageResponse.data.messages);
              activeChatRef.current = { channelId: String(route.id) };
              joinSocketRoom("channel", route.id);
            }
          }
        } else if (route.page === "messages" && route.id) {
          const { data: messageResponse } = await api.get(social(`/conversations/direct/${route.id}/messages`));
          if (active) {
            setProfile(messageResponse.conversation.participants.find((item) => String(item._id) === route.id));
            setMessages(messageResponse.messages);
            setConversations((current) => current.map((conversation) => String(conversation._id) === String(messageResponse.conversation._id)
              ? { ...conversation, unreadCount: 0, latestUnread: null } : conversation));
            activeChatRef.current = { conversationId: String(messageResponse.conversation._id) };
            joinSocketRoom("conversation", String(messageResponse.conversation._id));
          }
        } else if (route.page === "groups" && route.id) {
          const { data } = await api.get(social(`/conversations/${route.id}/messages`));
          if (active) {
            setProfile(data.conversation);
            setMessages(data.messages);
            setConversations((current) => current.map((conversation) => String(conversation._id) === String(data.conversation._id)
              ? { ...conversation, unreadCount: 0, latestUnread: null } : conversation));
            activeChatRef.current = { conversationId: String(data.conversation._id) };
            joinSocketRoom("conversation", String(data.conversation._id));
          }
        } else if (route.page === "users" && route.id) {
          const { data } = await api.get(social(`/users/${route.id}`));
          if (active) setProfile({
            ...data.user,
            relationship: data.relationship,
            requestDirection: data.requestDirection,
            requestId: data.requestId
          });
        }
      } catch (requestError) {
        if (active) setError(requestError.response?.data?.message || "That page could not be loaded.");
      }
    }
    loadRoute();
    return () => {
      active = false;
      if (joinedRoomRef.current) {
        const activeVoiceRoom = voiceSessionRef.current?.channel?._id
          ? `channel:${voiceSessionRef.current.channel._id}` : null;
        if (joinedRoomRef.current !== activeVoiceRoom) {
          socketRef.current?.emit("room:leave", joinedRoomRef.current);
        }
        joinedRoomRef.current = null;
      }
    };
  }, [route, loadBase, resetRouteView]);

  useEffect(() => {
    // Voice is an app-level session, not a route-level resource. Reassert the
    // existing room membership after any navigation without changing local media
    // or ending the WebRTC peers. Socket.IO room joins are idempotent.
    const activeLounge = voiceSessionRef.current?.channel?._id;
    if (activeLounge && socketRef.current?.connected) {
      socketRef.current.emit("channel:join", String(activeLounge));
    }
  }, [route]);

  useEffect(() => {
    if (toast === "") return undefined;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function doAction(action, successMessage) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (successMessage) setToast(successMessage);
      await loadBase();
      return true;
    } catch (requestError) {
      setError(requestError.response?.data?.message || "That action could not be completed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function refreshCommunity(communityId) {
    try {
      const { data } = await api.get(social(`/communities/${communityId}`));
      setCommunity({ ...data.community, channels: data.channels });
      setIsMember(data.isMember);
      setCommunityRole(data.role);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Community details could not be refreshed.");
    }
  }

  async function searchUsers(event) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { data } = await api.get(social("/users"), { params: { q: query.trim() } });
      setResults(data.users);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "User search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(content) {
    const isChannel = route.page === "channels";
    const conversation = route.page === "groups"
      ? conversations.find((item) => String(item._id) === route.id)
      : conversations.find((item) => item.type === "direct" && item.participants?.some((participant) => String(participant._id) === route.id));
    const conversationId = conversation?._id || activeChatRef.current?.conversationId;
    const payload = isChannel ? { channelId: route.id, content } : { conversationId, content };
    const socket = socketRef.current;
    if (!socket?.connected) {
      const endpoint = isChannel
        ? `/channels/${route.id}/messages`
        : route.page === "groups"
          ? `/conversations/${route.id}/messages`
          : `/conversations/direct/${route.id}/messages`;
      const { data } = await api.post(social(endpoint), { content });
      setMessages((current) => current.some((message) => String(message.id || message._id) === String(data.message.id))
        ? current : [...current, data.message]);
      await loadBase();
      return;
    }
    if (!payload.channelId && !payload.conversationId) {
      throw new Error("Conversation could not be found. Try reopening it.");
    }
    await new Promise((resolve, reject) => {
      socket.emit("message:send", payload, (response) => {
        if (response?.error) reject(new Error(response.error));
        else resolve(response.message);
      });
    });
    if (!isChannel && !conversations.some((item) => String(item._id) === String(conversationId))) {
      await loadBase();
    }
  }

  function setTyping(active) {
    if (!["channels", "messages", "groups"].includes(route.page)) return;
    const conversation = route.page === "groups"
      ? conversations.find((item) => String(item._id) === route.id)
      : conversations.find((item) => item.type === "direct" && item.participants?.some((participant) => String(participant._id) === route.id));
    socketRef.current?.emit(active ? "typing:start" : "typing:stop", route.page === "channels"
      ? { channelId: route.id }
      : { conversationId: conversation?._id || activeChatRef.current?.conversationId });
  }

  async function editMessage(message) {
    const content = window.prompt("Edit your message", message.content);
    if (!content?.trim()) return;
    try {
      const { data } = await api.patch(social(`/messages/${message.id || message._id}`), { content });
      setMessages((current) => current.map((item) => String(item.id || item._id) === String(message.id || message._id) ? data.message : item));
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not edit message.");
    }
  }

  async function deleteMessage(message) {
    if (!window.confirm("Delete this message?")) return;
    try {
      const { data } = await api.delete(social(`/messages/${message.id || message._id}`));
      setMessages((current) => current.map((item) => String(item.id || item._id) === String(message.id || message._id) ? data.message : item));
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not delete message.");
    }
  }

  async function createCommunity(event) {
    event.preventDefault();
    try {
      const { data } = await api.post(social("/communities"), newCommunity);
      setShowCreateCommunity(false);
      setNewCommunity({ name: "", description: "", isPublic: true });
      await loadBase();
      navigate(`/servers/${data.community._id}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Community could not be created.");
    }
  }

  async function createGroup(details) {
    try {
      const { data } = await api.post(social("/conversations/group"), details);
      setShowCreateGroup(false);
      await loadBase();
      navigate(`/groups/${data.conversation._id}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Group conversation could not be created.");
    }
  }

  async function createChannel() {
    const name = window.prompt("Name your text channel (letters, numbers, - or _)");
    if (!name?.trim()) return;
    try {
      const { data } = await api.post(social(`/communities/${community._id}/channels`), { name, type: "text" });
      navigate(`/channels/${data.channel._id}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Channel could not be created.");
    }
  }

  async function makeInvitation() {
    try {
      const { data } = await api.post(social(`/communities/${community._id}/invitations`));
      const link = `${window.location.origin}/invite/${data.invitation.token}`;
      setInviteUrl(link);
      await navigator.clipboard?.writeText(link);
      setToast("Invitation link created.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not create an invitation.");
    }
  }

  async function acceptInvite(token) {
    try {
      const { data } = await api.post(social(`/invitations/${token}/accept`));
      await loadBase();
      setToast("Welcome to the community.");
      navigate(`/servers/${data.communityId}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || "The invitation could not be accepted.");
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      const { avatar, ...profileSettings } = settings;
      if (avatar && /^https?:\/\//i.test(avatar)) profileSettings.avatar = avatar;
      const { data } = await api.patch(social("/profile"), profileSettings);
      updateUser(data.user);
      setSettings((current) => ({ ...current, ...data.user }));
      setProfile((current) => current && String(current._id) === String(data.user._id)
        ? { ...current, ...data.user }
        : current);
      socketRef.current?.emit("presence:set", settings.status);
      setToast("Your profile is up to date.");
      return true;
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Profile could not be saved.");
      return false;
    }
  }

  async function uploadAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("avatar", file);
    setError("");
    try {
      const { data } = await api.patch(social("/profile"), formData, {
        timeout: 15 * 60 * 1000
      });
      updateUser(data.user);
      setSettings((current) => ({ ...current, avatar: data.user.avatar }));
      setProfile((current) => current && String(current._id) === String(data.user._id)
        ? { ...current, avatar: data.user.avatar }
        : current);
      setToast("Avatar uploaded.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Avatar could not be uploaded.");
    } finally {
      event.target.value = "";
    }
  }

  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  const unreadMessageCount = conversations.reduce((total, conversation) => total + (conversation.unreadCount || 0), 0);
  const onlineFriends = friends.filter((friend) => (presence[friend._id] || friend.status) === "online");
  const viewingVoiceLounge = route.page === "channels" && channel?.type === "voice" && String(voiceLounge?.channel?._id) === String(channel._id);

  function navLink(path, icon, label, active = false) {
    const Icon = icon;
    return <Link className={`side-nav-link ${active ? "active" : ""}`} to={path}><Icon size={17} /><span>{label}</span></Link>;
  }

  function renderMain() {
    if (route.page === "play" && route.id) {
      return <GamePlayer slug={route.id} navigate={navigate} />;
    }
    if (route.page === "channels" && channel) {
      if (channel.type === "voice") {
        if (voiceSession && String(voiceSession.channel._id) !== String(channel._id)) {
          return <div className="voice-lounge-notice"><Volume2 size={24} /><h2>You are already in a lounge</h2><p>Leave #{voiceSession.channel.name} before joining another lounge.</p><button className="outline-button" onClick={() => navigate(`/channels/${voiceSession.channel._id}`)}>Return to lounge</button></div>;
        }
        return null;
      }
      return <ChatView title={channel.name} subtitle={`${community?.name} · ${channel.type} channel`} messages={messages} currentUser={user} onSend={sendMessage} onTyping={setTyping} onEdit={editMessage} onDelete={deleteMessage} typingUsers={typingUsers} />;
    }
    if (route.page === "messages" && profile) {
      return <ChatView title={`@${profile.username}`} subtitle="Direct messages · just between you two" messages={messages} currentUser={user} onSend={sendMessage} onTyping={setTyping} onEdit={editMessage} onDelete={deleteMessage} typingUsers={typingUsers} />;
    }
    if (route.page === "messages") {
      return <MessagesInbox conversations={conversations} currentUser={user} navigate={navigate} />;
    }
    if (route.page === "groups" && profile) {
      return <ChatView title={profile.name || "Group chat"} subtitle={`${profile.participants?.length || 0} people in this conversation`} messages={messages} currentUser={user} onSend={sendMessage} onTyping={setTyping} onEdit={editMessage} onDelete={deleteMessage} typingUsers={typingUsers} />;
    }
    if (route.page === "friends") {
      return <FriendsPage friends={friends} requests={requests} results={results} setResults={setResults} query={query} setQuery={setQuery} searchUsers={searchUsers} busy={busy} navigate={navigate} doAction={doAction} presence={presence} onCreateGroup={() => setShowCreateGroup(true)} />;
    }
    if (route.page === "discover") {
      return <DiscoverPage key={location.search} navigate={navigate} doAction={doAction} publicGames={publicGames} onCreateCommunity={() => setShowCreateCommunity(true)} />;
    }
    if (route.page === "servers" && community) {
      return <CommunityPage community={community} isMember={isMember} role={communityRole} navigate={navigate} doAction={doAction} refreshCommunity={refreshCommunity} makeInvitation={makeInvitation} createChannel={createChannel} inviteUrl={inviteUrl} />;
    }
    if (route.page === "users" && profile) {
      return <ProfilePage profile={profile} setProfile={setProfile} currentUser={user} presence={presence} doAction={doAction} navigate={navigate} />;
    }
    if (route.page === "games") {
      return <GamesPage myGames={myGames} navigate={navigate} refreshGames={async () => {
        const [mine, publicGamesResponse] = await Promise.all([api.get("/games/mine"), api.get("/games/public")]);
        setMyGames(mine.data.games);
        setPublicGames(publicGamesResponse.data.games);
      }} setToast={setToast} />;
    }
    if (route.page === "settings") {
      return <SettingsPage settings={settings} setSettings={setSettings} saveProfile={saveProfile} uploadAvatar={uploadAvatar} />;
    }
    if (route.page === "invite" && route.id) {
      return <InvitePage token={route.id} acceptInvite={acceptInvite} />;
    }
    return <HomePage user={user} friends={friends} communities={communities} publicGames={publicGames} presence={presence} navigate={navigate} />;
  }

  const pageTitle = route.page === "games" && new URLSearchParams(location.search).get("view") !== "public"
    ? "Game Studio"
    : route.page === "home" ? "Home" : ({
    friends: "Friends", discover: "Discover communities", servers: community?.name || "Community",
    channels: channel?.name || "Channel",     messages: profile?.username ? `@${profile.username}` : "Messages",
    groups: profile?.name || "Group chat",
    users: profile?.username ? `@${profile.username}` : "Profile", settings: "Account settings", invite: "Community invitation", games: "Game studio"
  }[route.page] || "Your space");

  return (
    <div className={`app-shell redesign-shell ${route.page === "servers" || route.page === "channels" ? "community-layout" : ""} ${["messages", "groups"].includes(route.page) ? "messaging-layout" : ""}`}>
      <header className="app-topbar">
        <Link to="/" className="brand-lockup" aria-label="sideQUEST home">
          <span className="brand-mark"><Gamepad2 size={19} /></span>
          <span className="brand-wordmark">sideQUEST<span className="brand-period">.</span></span>
        </Link>
        <nav className="primary-nav" aria-label="Main navigation">
          <Link to="/" className={route.page === "home" ? "active" : ""}>Home</Link>
          <Link to="/discover" className={route.page === "discover" ? "active" : ""}>Discover</Link>
          <Link to="/friends" className={route.page === "friends" ? "active" : ""}>Friends</Link>
          <Link to="/messages" className={["messages", "groups"].includes(route.page) ? "active" : ""}>Messages{unreadMessageCount > 0 && <i className="nav-unread-count">{unreadMessageCount > 9 ? "9+" : unreadMessageCount}</i>}</Link>
          <Link to="/discover?tab=communities" className={route.page === "discover" && new URLSearchParams(location.search).get("tab") === "communities" ? "active" : ""}>Communities</Link>
          <Link to="/games?view=studio" className={route.page === "games" && new URLSearchParams(location.search).get("view") !== "public" ? "active" : ""}>Studio</Link>
        </nav>
        <form className="global-search" onSubmit={(event) => {
          event.preventDefault();
          const term = event.currentTarget.elements.search.value.trim();
          if (term) navigate(`/discover?q=${encodeURIComponent(term)}`);
        }}>
          <Search size={16} /><input name="search" aria-label="Search sideQUEST" placeholder="Search worlds, players, communities" /><kbd>⌘ K</kbd>
        </form>
        <div className="topbar-actions">
          <button className="icon-button notification-toggle" onClick={() => setShowNotifications((value) => !value)} aria-label="Notifications"><Bell size={18} />{unreadCount > 0 && <i>{unreadCount > 9 ? "9+" : unreadCount}</i>}</button>
          <button className="top-profile" onClick={() => navigate("/settings")}><Avatar user={user} size="tiny" /><span>{user.username}</span><ChevronDown size={14} /></button>
          <button className="signout-button" onClick={logout} aria-label="Sign out"><LogOut size={15} /></button>
        </div>
        {showNotifications && <NotificationPanel notifications={notifications} onRead={() => doAction(() => api.patch(social("/notifications/all/read")), "Notifications marked read")} onClose={() => setShowNotifications(false)} />}
      </header>

      <aside className="channel-sidebar">
        <header className="sidebar-heading">
          <div className="context-label"><span className="context-index">{route.page === "home" ? "01" : route.page === "discover" ? "02" : route.page === "friends" ? "03" : route.page === "games" ? "04" : "05"}</span><span>{pageTitle}</span></div>
          {route.page === "servers" && communityRole && ["owner", "admin", "moderator"].includes(communityRole) && <button className="icon-button" onClick={createChannel} aria-label="Add channel"><Plus size={16} /></button>}
        </header>
        <div className="sidebar-scroll">
          {route.page === "servers" || route.page === "channels" ? (
            <>
              <div className="sidebar-section-heading"><span>COMMUNITY CHANNELS</span></div>
              {community?.channels?.map((item) => navLink(`/channels/${item._id}`, item.type === "voice" ? Volume2 : Hash, item.name, route.id === item._id))}
              {community && <Link className="side-nav-link" to={`/servers/${community._id}`}><Users size={17} /><span>Community home</span></Link>}
              <div className="sidebar-section-heading"><span>YOUR COMMUNITIES</span><button onClick={() => setShowCreateCommunity(true)} aria-label="Create community"><Plus size={15} /></button></div>
              {communities.map((item) => <Link key={item._id} className={`dm-link ${route.id === item._id ? "active" : ""}`} to={`/servers/${item._id}`}><span className="community-mini">{item.name.slice(0, 1)}</span><span>{item.name}</span></Link>)}
            </>
          ) : ["messages", "groups"].includes(route.page) ? (
            <>
              <div className="sidebar-section-heading"><span>DIRECT CONVERSATIONS</span></div>
              {conversations.filter((conversation) => conversation.type === "direct").map((conversation) => {
                const other = conversation.participants?.find((person) => String(person._id) !== String(user.id));
                return other && <Link className={`dm-link ${route.page === "messages" && route.id === other._id ? "active" : ""}`} to={`/messages/${other._id}`} key={conversation._id}><Avatar user={other} /><span>@{other.username}</span><span className={`presence-dot ${presence[other._id] || "offline"}`} /></Link>;
              })}
              <div className="sidebar-section-heading"><span>GROUP CONVERSATIONS</span><button onClick={() => setShowCreateGroup(true)} aria-label="Create group conversation"><Plus size={15} /></button></div>
              {conversations.filter((conversation) => conversation.type === "group").map((conversation) => <Link className={`dm-link ${route.page === "groups" && route.id === conversation._id ? "active" : ""}`} to={`/groups/${conversation._id}`} key={conversation._id}><span className="community-mini">{(conversation.name || "G").slice(0, 1)}</span><span>{conversation.name || "Group chat"}</span><span className="member-count">{conversation.participants?.length || 0}</span></Link>)}
              <button className="sidebar-action" onClick={() => navigate("/friends")}><Plus size={15} /> Start a conversation</button>
            </>
          ) : route.page === "friends" ? (
            <>
              <div className="sidebar-section-heading"><span>YOUR CIRCLE</span></div>
              <span className="sidebar-stat"><Users size={15} /> {friends.length} friends</span>
              <span className="sidebar-stat"><span className="presence-dot online" /> {onlineFriends.length} online now</span>
              <div className="sidebar-section-heading"><span>INCOMING REQUESTS</span><span className="member-count">{requests.incoming.length}</span></div>
              <span className="sidebar-hint">Accept or decline requests from your friends page.</span>
              {onlineFriends.map((friend) => <Link className="dm-link" key={friend._id} to={`/messages/${friend._id}`}><Avatar user={friend} /><span>@{friend.username}</span><span className="presence-dot online" /></Link>)}
            </>
          ) : (
            <>
              {route.page === "games" && <>
                <div className="sidebar-section-heading"><span>CREATOR DESK</span></div>
                <span className="sidebar-stat"><Gamepad2 size={15} /> {myGames.length} projects</span>
                <span className="sidebar-stat"><Sparkles size={15} /> {myGames.filter((game) => game.status === "published").length} published</span>
              </>}
              {communities.length > 0 && <div className="sidebar-section-heading"><span>YOUR COMMUNITIES</span><button onClick={() => setShowCreateCommunity(true)} aria-label="Create community"><Plus size={15} /></button></div>}
              {communities.slice(0, 5).map((item) => <Link key={item._id} className={`dm-link ${route.id === item._id ? "active" : ""}`} to={`/servers/${item._id}`}><span className="community-mini">{item.name.slice(0, 1)}</span><span>{item.name}</span></Link>)}
              {route.page === "home" && <button className="sidebar-action" onClick={() => navigate("/discover")}><Compass size={15} /> Find a community</button>}
            </>
          )}
        </div>
        <button className="account-chip" onClick={() => navigate("/settings")}><Avatar user={user} /><span><strong>{user.username}</strong><small>Account settings</small></span><Settings size={16} /></button>
      </aside>

      <main className="main-stage">
        {["servers", "channels"].includes(route.page) && community && <nav className="mobile-channel-nav" aria-label="Community channels">
          <Link to={`/servers/${community._id}`} className={route.page === "servers" ? "active" : ""}>Overview</Link>
          {community.channels?.map((item) => <Link key={item._id} to={`/channels/${item._id}`} className={route.id === item._id && route.page === "channels" ? "active" : ""}>{item.type === "text" ? "#" : "◉"} {item.name}</Link>)}
        </nav>}
        {["messages", "groups"].includes(route.page) && <nav className="mobile-channel-nav" aria-label="Conversations">
          {conversations.map((conversation) => {
            if (conversation.type === "group") return <Link key={conversation._id} to={`/groups/${conversation._id}`} className={route.page === "groups" && route.id === conversation._id ? "active" : ""}>{conversation.name || "Group chat"}</Link>;
            const other = conversation.participants?.find((person) => String(person._id) !== String(user.id));
            return other && <Link key={conversation._id} to={`/messages/${other._id}`} className={route.page === "messages" && route.id === other._id ? "active" : ""}>@{other.username}</Link>;
          })}
        </nav>}
        {error && <div role="alert" className="app-error"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
        {voiceLounge && <VoiceChannelView key={voiceLounge.channel._id}
          channel={voiceLounge.channel}
          community={voiceLounge.community}
          currentUser={user}
          socket={socket}
          visible={viewingVoiceLounge}
          onSessionChange={handleVoiceSessionChange}
          leaveRequest={leaveVoiceRequest}
        />}
        {!viewingVoiceLounge && renderMain()}
      </main>

      {voiceSession && !viewingVoiceLounge && <div className="voice-session-dock" role="status" aria-label={`Connected to ${voiceSession.channel.name}`}>
        <button className="voice-dock-return" title={`Return to #${voiceSession.channel.name}`} aria-label={`Return to #${voiceSession.channel.name}`} onClick={() => navigate(`/channels/${voiceSession.channel._id}`)}><Volume2 size={17} /></button>
        <button className="danger-button" title="Leave voice" aria-label="Leave voice" onClick={() => setLeaveVoiceRequest((current) => current + 1)}><PhoneOff size={15} /></button>
      </div>}

      <aside className="people-sidebar">
        <div className="people-heading"><span>YOUR PEOPLE</span><Users size={16} /></div>
        <div className="people-group"><span className="group-label">ONLINE — {onlineFriends.length}</span>
          {onlineFriends.length ? onlineFriends.map((friend) => <Link to={`/messages/${friend._id}`} className="person-row" key={friend._id}><div className="person-avatar"><Avatar user={friend} /><i className="presence-dot online" /></div><span>@{friend.username}</span><MessageCircle size={15} /></Link>) : <p className="quiet-note">Friends who are around show up here.</p>}
        </div>
        <div className="people-group"><span className="group-label">COMMUNITIES — {communities.length}</span>
          {communities.slice(0, 6).map((item) => <Link to={`/servers/${item._id}`} className="person-row" key={item._id}><span className="community-mini">{item.name.slice(0, 1)}</span><span>{item.name}</span><span className="member-count">{item.memberCount ?? item.members?.length ?? 0}</span></Link>)}
          {!communities.length && <p className="quiet-note">Join a community to find your people.</p>}
        </div>
        <div className="right-sidebar-footer">GOOD COMPANY, GOOD GAMES.</div>
      </aside>

      {showCreateCommunity && <Modal title="Start a community" onClose={() => setShowCreateCommunity(false)}><form className="modal-form" onSubmit={createCommunity}><label>Community name<input value={newCommunity.name} onChange={(event) => setNewCommunity({ ...newCommunity, name: event.target.value })} minLength="2" maxLength="60" required /></label><label>What brings you together?<textarea value={newCommunity.description} onChange={(event) => setNewCommunity({ ...newCommunity, description: event.target.value })} maxLength="500" rows="3" /></label><label className="check-label"><input type="checkbox" checked={newCommunity.isPublic} onChange={(event) => setNewCommunity({ ...newCommunity, isPublic: event.target.checked })} /> Make this community discoverable</label><button className="primary-button">Create community</button></form></Modal>}
      {showCreateGroup && <Modal title="Start a group chat" onClose={() => setShowCreateGroup(false)}><GroupConversationForm friends={friends} onCreate={createGroup} /></Modal>}
      {toast && <div className="toast-message" role="status">{toast}</div>}
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link to="/" className={route.page === "home" ? "active" : ""}><Sparkles size={18} /><span>Home</span></Link>
        <Link to="/discover" className={route.page === "discover" ? "active" : ""}><Compass size={18} /><span>Discover</span></Link>
        <Link to="/messages" className={["messages", "groups"].includes(route.page) ? "active" : ""}><MessageCircle size={18} /><span>Messages</span>{unreadMessageCount > 0 && <i className="nav-unread-count">{unreadMessageCount > 9 ? "9+" : unreadMessageCount}</i>}</Link>
        <Link to="/friends" className={route.page === "friends" ? "active" : ""}><Users size={18} /><span>Friends</span></Link>
      </nav>
    </div>
  );
}

function HomePage({ user, friends, communities, publicGames, presence, navigate }) {
  const featuredGame = publicGames?.[0];
  const popularGames = [...(publicGames || [])].sort((first, second) => (second.plays || 0) - (first.plays || 0)).slice(0, 4);
  return (
    <div className="home-page ecosystem-home">
      <section className="welcome-editorial">
        <div><span className="eyebrow">WELCOME BACK, {user.username}</span><h1>Ready to find your next world?</h1><p>Explore new releases, revisit your collection, or share what you are building.</p></div>
        <div className="welcome-actions"><button className="primary-button" onClick={() => navigate("/discover?tab=games")}>Explore games</button><button className="outline-button" onClick={() => navigate("/games")}>My studio</button></div>
      </section>
      <section className="featured-hero">
        <img src={gameArtwork(featuredGame)} alt="" className="featured-hero-art" />
        <div className="featured-hero-shade" />
        <div className="featured-hero-content">
          <span className="platform-badge">{featuredGame ? "COMMUNITY BUILD" : "YOUR NEXT SESSION"}</span>
          <h1>{featuredGame?.title || "Find a new world to play."}</h1>
          <p>{featuredGame?.description || `Welcome back, ${user.username}. Browse community games or pick up with your friends.`}</p>
          <div className="hero-actions">
            <button className="primary-button hero-play" onClick={() => featuredGame ? navigate(`/play/${featuredGame.publicSlug}`) : navigate("/discover?tab=games")}><Play size={16} fill="currentColor" /> {featuredGame ? "Play now" : "Explore games"}</button>
            <button className="outline-button" onClick={() => navigate("/games?view=studio")}>Open studio</button>
          </div>
        </div>
        <div className="featured-meta"><span>PUBLISHED BUILDS</span><strong>{publicGames?.length || 0}</strong><small>ready to play</small></div>
      </section>

      <div className="section-title gaming-section-title"><div><span className="eyebrow">PICK UP AND PLAY</span><h2>Community games</h2></div><button className="text-button" onClick={() => navigate("/discover?tab=games")}>Browse catalog</button></div>
      {publicGames?.length ? <div className="continue-grid">
        {publicGames.slice(0, 3).map((game, index) => (
          <button className={`continue-card continue-card-${index + 1}`} key={game.id} onClick={() => navigate(`/play/${game.publicSlug}`)}>
            <img src={gameArtwork(game)} alt="" /><span className="continue-shade" />
            <span className="continue-copy"><small>{game.engine}</small><strong>{game.title}</strong></span>
            <span className="continue-play"><Play size={14} fill="currentColor" /></span>
          </button>
        ))}
      </div> : <EmptyState icon={Gamepad2} title="The catalog is waiting" text="Community games will show up here once creators publish them." action={<button className="outline-button" onClick={() => navigate("/games?view=studio")}>Create a game</button>} />}

      <div className="section-title gaming-section-title"><div><span className="eyebrow">MOST PLAYED</span><h2>Popular with players</h2></div><button className="text-button" onClick={() => navigate("/discover?tab=trending")}>Browse discovery <Compass size={15} /></button></div>
      {popularGames.length ? <div className="trending-grid">
        {popularGames.map((game) => (
          <article className="game-discovery-card" key={game.id}>
            <button className="game-art-button" onClick={() => navigate(`/play/${game.publicSlug}`)}><img src={gameArtwork(game)} alt="" /><span>PLAY</span></button>
            <div className="game-card-meta"><div><strong>{game.title}</strong><small>{game.engine}</small></div><span>{game.plays} plays</span></div>
          </article>
        ))}
      </div> : <EmptyState icon={Sparkles} title="No play data yet" text="As community games are played, the most-played list will take shape." />}

      <div className="activity-layout">
        <section><div className="section-title gaming-section-title"><div><span className="eyebrow">LIVE SOCIAL</span><h2>Friends activity</h2></div><button className="text-button" onClick={() => navigate("/friends")}>All friends</button></div><div className="activity-list">
          {friends.length ? friends.slice(0, 4).map((friend) => { const status = presence[friend._id] || friend.status || "offline"; return <button className="activity-row" key={friend._id} onClick={() => navigate(`/messages/${friend._id}`)}><Avatar user={friend} /><div><strong>{friend.username}</strong><span>{statusNames[status] || status}</span></div><small>{statusNames[status]?.toUpperCase() || status.toUpperCase()}</small></button>; }) : <EmptyState icon={Users} title="Build your crew" text="Add friends to see who is around." />}
        </div></section>
        <section><div className="section-title gaming-section-title"><div><span className="eyebrow">COMMUNITIES</span><h2>Community pulse</h2></div><button className="round-add" onClick={() => navigate("/discover")} aria-label="Explore communities"><Plus size={16} /></button></div><div className="community-pulse">
          {communities.length ? communities.slice(0, 3).map((item) => <button className="community-pulse-row" key={item._id} onClick={() => navigate(`/servers/${item._id}`)}><span className="community-mini">{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><span>{item.memberCount ?? 0} members</span></div><ChevronDown size={14} /></button>) : <EmptyState icon={Compass} title="Find your people" text="Join or create a gaming community." />}
        </div></section>
      </div>
    </div>
  );
}

function GamePlayer({ slug, navigate }) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [iframeLoading, setIframeLoading] = useState(true);
  const frameRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get(`/games/public/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(({ data }) => {
        setGame(data.game);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError.response?.data?.message || "The game could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [slug]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frameRef.current?.requestFullscreen();
    } catch {
      setError("Full-screen mode is not available in this browser.");
    }
  }

  return <main className="game-player-page page-content">
    <header className="game-player-header">
      <div><span className="eyebrow">PLAYING IN sideQUEST</span><h1>{game?.title || "Loading game..."}</h1><p>{game?.engine || "Browser game"}</p></div>
      <div><button className="outline-button" onClick={() => navigate(-1)}>Back</button><button className="primary-button" onClick={toggleFullscreen} disabled={!game}><Maximize size={15} /> Full screen</button></div>
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="game-player-shell" aria-busy={loading || iframeLoading}>
      {(loading || iframeLoading) && <div className="game-player-loading">Starting game...</div>}
      {game && <iframe ref={frameRef} className="game-player-frame" src={gamePlayUrl(game.publicSlug)} title={`${game.title} game player`} allow="autoplay; fullscreen; gamepad; microphone" allowFullScreen onLoad={() => setIframeLoading(false)} />}
    </section>
    {game?.hosting === "external" && <p className="game-player-warning">This game uses creator-managed external services. sideQUEST hosts the browser build but does not operate or support its game servers.</p>}
    {game && <p className="game-player-note">This game runs inside sideQUEST. If it does not start, the uploaded ZIP must be a browser export with an HTML entry file and its generated assets.</p>}
  </main>;
}

function GamesPage({ myGames, navigate, refreshGames, setToast }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const gamesView = searchParams.get("view") === "library" ? "library" : "studio";
  const [uploading, setUploading] = useState(false);
  const [thumbnailUploadingId, setThumbnailUploadingId] = useState("");
  const [buildUploadingId, setBuildUploadingId] = useState("");
  const [error, setError] = useState("");
  const [hosting, setHosting] = useState("standalone");

  function changeGamesView(view) {
    setSearchParams({ view: view === "library" ? "library" : "studio" });
  }

  async function uploadGame(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setUploading(true);
    setError("");
    try {
      await api.post("/games/upload", formData, { timeout: 15 * 60 * 1000 });
      form.reset();
      setHosting("standalone");
      await refreshGames();
      setToast("Game build uploaded as a draft.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "The game build could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  async function publishGame(game) {
    try {
      await api.post(`/games/${game.id}/publish`);
      await refreshGames();
      setToast("Game published.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Game could not be published.");
    }
  }

  async function uploadGameThumbnail(game, event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("thumbnail", file);
    setThumbnailUploadingId(game.id);
    setError("");
    try {
      await api.post(`/games/${game.id}/thumbnail`, formData);
      await refreshGames();
      setToast("Game thumbnail updated.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Game thumbnail could not be uploaded.");
    } finally {
      setThumbnailUploadingId("");
      input.value = "";
    }
  }

  async function updateGameBuild(game, event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("game", file);
    formData.append("engine", game.engine);
    setBuildUploadingId(game.id);
    setError("");
    try {
      await api.put(`/games/${game.id}/build`, formData, { timeout: 15 * 60 * 1000 });
      await refreshGames();
      setToast("Game build updated.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Game build could not be updated.");
    } finally {
      setBuildUploadingId("");
      input.value = "";
    }
  }

  async function deleteGame(game) {
    if (!window.confirm(`Delete ${game.title}?`)) return;
    try {
      await api.delete(`/games/${game.id}`);
      await refreshGames();
      setToast("Game deleted.");
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Game could not be deleted.");
    }
  }

  return (
    <div className="page-content games-page">
      <div className="page-intro games-intro">
        <div><span className="eyebrow">CREATOR WORKSPACE</span><h1>Game studio</h1><p>Build, manage, and publish your games.</p></div>
        <button className="primary-button" onClick={() => changeGamesView("studio")}><Upload size={15} /> Upload game</button>
      </div>
      <div className="studio-stats"><div><span>PROJECTS</span><strong>{myGames.length}</strong></div><div><span>PUBLISHED</span><strong>{myGames.filter((game) => game.status === "published").length}</strong></div><div><span>DRAFTS</span><strong>{myGames.filter((game) => game.status === "draft").length}</strong></div></div>
      <div className="game-tabs" role="tablist" aria-label="Game studio sections">
        <button type="button" className={gamesView === "studio" ? "active" : ""} onClick={() => changeGamesView("studio")}>Studio overview</button>
        <button type="button" className={gamesView === "library" ? "active" : ""} onClick={() => changeGamesView("library")}>My builds <span>{myGames.length}</span></button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {(gamesView === "studio") && (
        <div className="games-layout">
        <form className="game-upload-panel" onSubmit={uploadGame}>
          <div className="list-heading"><div><span className="eyebrow">NEW BUILD</span><h2>Upload your game</h2></div><Upload size={18} /></div>
          <label>Game title<input name="title" required minLength="2" maxLength="80" placeholder="My browser game" /></label>
          <label>Description<textarea name="description" maxLength="1000" rows="3" placeholder="What should players know?" /></label>
          <label>Browser export type
            <select name="engine" defaultValue="HTML5 / JavaScript">
              <option value="HTML5 / JavaScript">HTML5 / JavaScript</option>
              <option value="Godot Web">Godot Web</option>
              <option value="Unity WebGL">Unity WebGL</option>
              <option value="Unreal HTML5">Unreal HTML5</option>
              <option value="Other browser export">Other browser export</option>
            </select>
          </label>
          <label>Genre<select name="genre" defaultValue="Other">{["Action", "Adventure", "Arcade", "Multiplayer", "Puzzle", "Racing", "RPG", "Sandbox", "Strategy", "Other"].map((genre) => <option key={genre}>{genre}</option>)}</select></label>
          <label>Game requirements
            <select name="hosting" value={hosting} onChange={(event) => setHosting(event.target.value)}>
              <option value="standalone">Standalone browser game — no external service</option>
              <option value="external">Uses creator-managed external services</option>
            </select>
          </label>
          {hosting === "external" && <label>External service URL<input name="externalServiceUrl" type="url" required maxLength="500" placeholder="wss://game.example.com or https://status.example.com" /><small className="upload-field-note">This is for player information only. Your game build must configure and maintain its own connection.</small></label>}
          <label className="game-dropzone"><span className="dropzone-icon"><Upload size={20} /></span><strong>Drop or choose a web build ZIP</strong><small>Any engine's browser export with an HTML entry point · 500 MB maximum</small><input name="game" type="file" accept=".zip,application/zip" required /></label>
          <label className="upload-responsibility"><input name="creatorAcknowledgement" type="checkbox" value="true" required /> <span>I confirm this is a browser game and I am responsible for its functionality, content, and any external servers or services it uses.</span></label>
          <button className="primary-button" disabled={uploading}>{uploading ? "Uploading..." : "Upload draft"}</button>
        </form>

        <section className="game-library">
          <div className="list-heading"><div><span className="eyebrow">YOUR BUILDS</span><h2>My games <span>{myGames.length}</span></h2></div></div>
          {myGames.length ? myGames.map((game) => (
            <article className="game-row" key={game.id}>
              <span className="game-cover">{game.thumbnail ? <img src={gameArtwork(game)} alt="" /> : <Gamepad2 size={22} />}</span>
              <div className="game-copy"><strong>{game.title}</strong><small>{game.engine} · {game.status} · {(game.originalSize / 1024 / 1024).toFixed(1)} MB</small><label className="game-thumbnail-upload"><Upload size={12} />{thumbnailUploadingId === game.id ? "Uploading..." : game.thumbnail ? "Change thumbnail" : "Add thumbnail"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={thumbnailUploadingId === game.id} onChange={(event) => uploadGameThumbnail(game, event)} /></label><label className="game-thumbnail-upload"><Upload size={12} />{buildUploadingId === game.id ? "Updating..." : "Update game"}<input type="file" accept=".zip,application/zip" disabled={buildUploadingId === game.id} onChange={(event) => updateGameBuild(game, event)} /></label></div>
              {game.status === "draft" ? <><button className="outline-button" onClick={() => window.open(gamePreviewUrl(game.id), "_blank")}>Preview</button><button className="outline-button" onClick={() => publishGame(game)}>Publish</button></> : <><button className="outline-button" onClick={() => api.patch(`/games/${game.id}`, { status: "draft" }).then(refreshGames)}>Unpublish</button><button className="outline-button" onClick={() => navigate(`/play/${game.publicSlug}`)}><Play size={14} /> Play</button></>}
              <button className="more-button" onClick={() => deleteGame(game)} aria-label={`Delete ${game.title}`}><Trash2 size={15} /></button>
            </article>
          )) : <EmptyState icon={Gamepad2} title="Your first build starts here" text="Export a game for the web, ZIP it, and upload the folder's contents." />}
        </section>
        </div>
      )}

      {(gamesView === "library") && (
      <section className="game-library expanded-library">
        <div className="list-heading"><div><span className="eyebrow">YOUR BUILDS</span><h2>My games <span>{myGames.length}</span></h2></div></div>
        {myGames.length ? myGames.map((game) => (
          <article className="game-row" key={game.id}>
            <span className="game-cover">{game.thumbnail ? <img src={gameArtwork(game)} alt="" /> : <Gamepad2 size={22} />}</span>
            <div className="game-copy"><strong>{game.title}</strong><small>{game.engine} · {game.status} · {(game.originalSize / 1024 / 1024).toFixed(1)} MB</small><label className="game-thumbnail-upload"><Upload size={12} />{thumbnailUploadingId === game.id ? "Uploading..." : game.thumbnail ? "Change thumbnail" : "Add thumbnail"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={thumbnailUploadingId === game.id} onChange={(event) => uploadGameThumbnail(game, event)} /></label><label className="game-thumbnail-upload"><Upload size={12} />{buildUploadingId === game.id ? "Updating..." : "Update game"}<input type="file" accept=".zip,application/zip" disabled={buildUploadingId === game.id} onChange={(event) => updateGameBuild(game, event)} /></label></div>
            {game.status === "draft" ? <button className="outline-button" onClick={() => publishGame(game)}>Publish</button> : <button className="outline-button" onClick={() => navigate(`/play/${game.publicSlug}`)}><Play size={14} /> Play</button>}
            <button className="more-button" onClick={() => deleteGame(game)} aria-label={`Delete ${game.title}`}><Trash2 size={15} /></button>
          </article>
        )) : <EmptyState icon={Gamepad2} title="No builds yet" text="Create a web build, ZIP it, and upload it from the studio tab." />}
      </section>
      )}

    </div>
  );
}

function FriendsPage({ friends, requests, results, setResults, query, setQuery, searchUsers, busy, navigate, doAction, presence, onCreateGroup }) {
  async function handleSearchResultAction(person, action, successMessage) {
    if (await doAction(action, successMessage)) {
      setResults((current) => current.filter((entry) => entry._id !== person._id));
    }
  }

  return (
    <div className="page-content friends-page">
      <div className="page-intro friends-intro"><div><span className="eyebrow">YOUR PEOPLE / SOCIAL CIRCLE</span><h1>Friends</h1><p>Keep your favorite people close, even between games.</p></div><button className="outline-button" onClick={onCreateGroup}><Users size={15} /> New group chat</button></div>
      <form className="search-bar" onSubmit={searchUsers}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find players by username..." maxLength="80" /><button disabled={busy}>Search</button></form>
      {results.length > 0 && <section className="result-list"><h2>Players you might know</h2>{results.map((person) => <div className="friend-row" key={person._id}><Avatar user={person} /><div className="friend-name"><strong>@{person.username}</strong><small>{person.bio || "Ready for a new connection"}</small></div>{person.relationship === "accepted" ? <button className="outline-button" onClick={() => navigate(`/messages/${person._id}`)}><MessageCircle size={14} /> Message</button> : person.requestDirection === "incoming" ? <button className="outline-button" disabled={busy} onClick={() => handleSearchResultAction(person, () => api.patch(social(`/friends/requests/${person.requestId}/accept`)), "You are friends now")}>Accept request</button> : person.requestDirection === "outgoing" ? <button className="outline-button" disabled>Request sent</button> : <button className="outline-button" disabled={busy} onClick={() => handleSearchResultAction(person, () => api.post(social(`/friends/${person._id}`)), "Friend request sent")}>Add friend <Plus size={14} /></button>}<button className="icon-button" onClick={() => navigate(`/users/${person.username}`)} aria-label={`View ${person.username}'s profile`}>↗</button></div>)}</section>}
      <div className="friends-columns">
        <section className="friends-list-section"><div className="list-heading"><div><span className="eyebrow">THE CREW</span><h2>All friends <span>{friends.length}</span></h2></div></div>
          {friends.length ? friends.map((friend) => { const status = presence[friend._id] || friend.status || "offline"; return <div className="friend-row" key={friend._id}><div className="person-avatar"><Avatar user={friend} /><i className={`presence-dot ${status}`} /></div><div className="friend-name"><strong>@{friend.username}</strong><small>{friend.bio || statusNames[status] || "A player in your circle"}</small></div><button className="outline-button" onClick={() => navigate(`/messages/${friend._id}`)}><MessageCircle size={15} /> Message</button><button className="more-button" disabled={busy} onClick={() => { if (window.confirm(`Remove @${friend.username} from your friends?`)) doAction(() => api.delete(social(`/friends/${friend._id}`)), "Friend removed"); }} aria-label={`Remove ${friend.username}`} title={`Remove ${friend.username}`}><Trash2 size={15} /></button></div>; }) : <EmptyState icon={Users} title="A good crew starts with a hello" text="Search for a username above to find your first friend." />}</section>
        <section className="requests-section"><div className="list-heading"><div><span className="eyebrow">INBOX</span><h2>Requests <span>{requests.incoming.length}</span></h2></div></div>
          {requests.incoming.length ? requests.incoming.map((request) => <div className="request-card" key={request._id}><Avatar user={request.requester} /><div className="friend-name"><strong>@{request.requester.username}</strong><small>wants to connect</small></div><div className="request-actions"><button title="Accept" aria-label={`Accept ${request.requester.username}'s request`} disabled={busy} onClick={() => doAction(() => api.patch(social(`/friends/requests/${request._id}/accept`)), "You are friends now")}>✓</button><button title="Decline" aria-label={`Decline ${request.requester.username}'s request`} disabled={busy} onClick={() => doAction(() => api.patch(social(`/friends/requests/${request._id}/reject`)), "Request declined")}>×</button></div></div>) : <p className="quiet-note">No new requests. Your inbox is all yours.</p>}
          {requests.outgoing.length > 0 && <><div className="list-heading outgoing-heading"><div><span className="eyebrow">WAITING ON</span><h2>Sent requests</h2></div></div>{requests.outgoing.map((request) => <div className="friend-row compact-row" key={request._id}><Avatar user={request.recipient} /><div className="friend-name"><strong>@{request.recipient.username}</strong><small>Request pending</small></div><button className="more-button" disabled={busy} onClick={() => doAction(() => api.delete(social(`/friends/requests/${request._id}`)), "Request cancelled")} aria-label="Cancel request">×</button></div>)}</>}
        </section>
      </div>
    </div>
  );
}

function GroupConversationForm({ friends, onCreate }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);
  return friends.length < 2 ? (
    <EmptyState icon={Users} title="Bring two friends together" text="Add at least two friends before creating a group chat." />
  ) : (
    <form className="modal-form" onSubmit={(event) => {
      event.preventDefault();
      onCreate({ name, participantIds: selected });
    }}>
      <label>Group name <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional" maxLength="80" /></label>
      <fieldset className="group-friend-picker"><legend>Choose at least two friends</legend>{friends.map((friend) => <label key={friend._id}><input type="checkbox" checked={selected.includes(friend._id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, friend._id] : current.filter((id) => id !== friend._id))} /><Avatar user={friend} size="tiny" /> @{friend.username}</label>)}</fieldset>
      <button className="primary-button" disabled={selected.length < 2}>Create group</button>
    </form>
  );
}

function DiscoverPage({ navigate, doAction, publicGames = [], onCreateCommunity }) {
  const location = useLocation();
  const discoveryParams = new URLSearchParams(location.search);
  const initialQuery = discoveryParams.get("q") || "";
  const requestedTab = discoveryParams.get("tab") || "for-you";
  const initialTab = ["for-you", "games", "communities", "new-releases", "trending"].includes(requestedTab) ? requestedTab : "for-you";
  const [search, setSearch] = useState(initialQuery);
  const [submittedSearch, setSubmittedSearch] = useState(initialQuery);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (signal) => {
    try {
      const { data } = await api.get(social("/communities"), {
        params: { q: submittedSearch },
        signal
      });
      setCommunities(data.communities);
      setError("");
    } catch (requestError) {
      if (!signal?.aborted) {
        setError(requestError.response?.data?.message || "Communities could not be loaded.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [submittedSearch]);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Start the cancellable discovery fetch for this search.
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  function submitSearch(event) {
    event.preventDefault();
    setLoading(true);
    const params = new URLSearchParams(location.search);
    if (search.trim()) params.set("q", search.trim());
    else params.delete("q");
    navigate(`/discover?${params.toString()}`, { replace: true });
    if (submittedSearch === search) load();
    else setSubmittedSearch(search);
  }
  function chooseTab(tab) {
    setActiveTab(tab);
    const params = new URLSearchParams(location.search);
    params.set("tab", tab);
    navigate(`/discover?${params.toString()}`, { replace: true });
  }
  const normalizedSearch = submittedSearch.trim().toLowerCase();
  const matchingGames = publicGames.filter((game) => (
    `${game.title} ${game.description || ""} ${game.owner?.username || ""} ${game.engine || ""}`.toLowerCase().includes(normalizedSearch)
  ));
  const visibleGames = [...matchingGames].sort((first, second) => activeTab === "trending"
    ? (second.plays || 0) - (first.plays || 0)
    : new Date(second.createdAt) - new Date(first.createdAt));
  const showGames = ["for-you", "games", "new-releases", "trending"].includes(activeTab);
  const showCommunities = ["for-you", "communities"].includes(activeTab);
  const tabs = [
    ["for-you", "For you"],
    ["games", "Games"],
    ["communities", "Communities"],
    ["new-releases", "New releases"],
    ["trending", "Trending"]
  ];
  return <div className="page-content discovery-page">
    <section className="discover-heading">
      <div><span className="eyebrow">THE sideQUEST INDEX</span><h1>Discover something different.</h1><p>Independent games and the people who make every session better.</p></div>
      <div className="discover-actions"><button className="outline-button" onClick={onCreateCommunity}><Plus size={15} /> Start a community</button><button className="outline-button" onClick={() => navigate("/games")}><Upload size={15} /> Publish a game</button></div>
    </section>
    <nav className="discover-tabs" aria-label="Discovery categories">
      {tabs.map(([tab, label]) => <button key={tab} type="button" className={activeTab === tab ? "active" : ""} onClick={() => chooseTab(tab)}>{label}</button>)}
    </nav>
    <form className="search-bar discovery-search" onSubmit={submitSearch}><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={activeTab === "communities" ? "Search communities..." : "Search games and communities..."} maxLength="80" /><button disabled={loading && submittedSearch !== search}>{loading && submittedSearch !== search ? "Searching" : "Search"}</button></form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {showGames && <section className="discover-results">
      <div className="section-title gaming-section-title"><div><span className="eyebrow">{activeTab === "trending" ? "MOST PLAYED" : activeTab === "new-releases" ? "LATEST BUILDS" : "BROWSER GAMES"}</span><h2>{activeTab === "trending" ? "Popular with players" : activeTab === "new-releases" ? "Fresh from creators" : "Find your next game"}</h2></div></div>
      {visibleGames.length ? <div className="trending-grid">{visibleGames.map((game) => <article className="game-discovery-card" key={game.id}>
        <button className="game-art-button" onClick={() => navigate(`/play/${game.publicSlug}`)}><img src={gameArtwork(game)} alt="" /><span><Play size={13} fill="currentColor" /> Play game</span></button>
        <div className="game-card-meta"><div><strong>{game.title}</strong><small>{game.owner?.username ? `by @${game.owner.username}` : game.engine}</small></div><span>{game.plays} plays</span></div>
        {game.description && <p className="discovery-game-description">{game.description}</p>}
      </article>)}</div> : <EmptyState icon={Gamepad2} title={normalizedSearch ? "No games match this search" : "No published games yet"} text={normalizedSearch ? "Try another title or creator name." : "Community games will appear here once they are published."} />}
    </section>}
    {showCommunities && <section className="discover-results community-results">
      <div className="section-title gaming-section-title"><div><span className="eyebrow">COMMUNITY SPACES</span><h2>Find your people</h2></div></div>
      {loading ? <div className="loading-state">Finding communities...</div> : communities.length ? <div className="discovery-grid">{communities.map((item) => <article className="discovery-card" key={item._id}><div className="discovery-art">{item.icon ? <img src={item.icon} alt="" /> : item.name.slice(0, 2)}<span>PUBLIC COMMUNITY</span></div><div className="discovery-card-copy"><div className="community-byline"><Avatar user={item.owner} size="tiny" /> hosted by @{item.owner?.username}</div><h2>{item.name}</h2><p>{item.description || "A place for players to meet and play together."}</p><div className="discovery-card-footer"><span><Users size={14} /> {item.memberCount ?? 0} members</span>{item.isMember ? <button onClick={() => navigate(`/servers/${item._id}`)}>Open community</button> : <button onClick={async () => { if (await doAction(() => api.post(social(`/communities/${item._id}/join`)), "You joined the community")) navigate(`/servers/${item._id}`); }}>Join community</button>}<button className="card-link" onClick={() => navigate(`/servers/${item._id}`)} aria-label={`View ${item.name}`}>↗</button></div></div></article>)}</div> : <EmptyState icon={Compass} title={normalizedSearch ? "No matching communities" : "No communities found"} text={normalizedSearch ? "Try another search, or explore all spaces." : "Start a community to give players a place to meet."} />}
    </section>}
  </div>;
}

function CommunityPage({ community, isMember, role, navigate, doAction, refreshCommunity, makeInvitation, createChannel, inviteUrl }) {
  const [members, setMembers] = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [details, setDetails] = useState({ name: community.name, description: community.description || "", isPublic: community.isPublic });
  const [memberSearch, setMemberSearch] = useState("");
  const [memberError, setMemberError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  useEffect(() => {
    if (!isMember) return undefined;
    const controller = new AbortController();
    api.get(social(`/communities/${community._id}/members`), {
      params: { q: memberSearch },
      signal: controller.signal
    })
      .then(({ data }) => {
        setMemberError("");
        setMembers(data.members);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setMemberError(requestError.response?.data?.message || "Community members could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [community._id, isMember, memberSearch]);
  const canManage = ["owner", "admin"].includes(role);
  const canManageChannels = ["owner", "admin", "moderator"].includes(role);
  const isOwner = role === "owner";

  async function saveCommunity(event) {
    event.preventDefault();
    if (await doAction(() => api.patch(social(`/communities/${community._id}`), details), "Community updated")) {
      setEditMode(false);
      refreshCommunity(community._id);
    }
  }

  async function deleteCommunity() {
    if (!window.confirm(`Delete ${community.name}? This removes its channels and messages.`)) return;
    if (await doAction(() => api.delete(social(`/communities/${community._id}`)), "Community deleted")) navigate("/");
  }

  async function announce(event) {
    event.preventDefault();
    if (await doAction(() => api.post(social(`/communities/${community._id}/announcements`), { message: announcement }), "Announcement sent")) {
      setAnnouncement("");
      setShowAnnouncement(false);
    }
  }

  async function editChannel(item) {
    const name = window.prompt("Update channel name", item.name);
    if (!name?.trim()) return;
    const roles = window.prompt(
      "Allowed roles, separated by commas",
      (item.allowedRoles || ["owner", "admin", "moderator", "member"]).join(", ")
    );
    if (roles === null) return;
    const allowedRoles = [...new Set(roles.split(",").map((roleName) => roleName.trim().toLowerCase()).filter(Boolean))];
    if (await doAction(() => api.patch(social(`/communities/${community._id}/channels/${item._id}`), { name, allowedRoles }), "Channel permissions updated")) refreshCommunity(community._id);
  }

  async function deleteChannel(item) {
    if (!window.confirm(`Delete #${item.name} and its message history?`)) return;
    if (await doAction(() => api.delete(social(`/communities/${community._id}/channels/${item._id}`)), "Channel deleted")) refreshCommunity(community._id);
  }

  async function moveChannel(item, direction) {
    const ordered = [...(community.channels || [])].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((channelItem) => channelItem._id === item._id);
    const neighbor = ordered[index + direction];
    if (!neighbor) return;
    const moved = await doAction(() => Promise.all([
      api.patch(social(`/communities/${community._id}/channels/${item._id}`), { position: neighbor.position }),
      api.patch(social(`/communities/${community._id}/channels/${neighbor._id}`), { position: item.position })
    ]), "Channel order updated");
    if (moved) refreshCommunity(community._id);
  }

  async function changeMemberRole(memberId, newRole) {
    if (await doAction(
      () => api.patch(social(`/communities/${community._id}/members/${memberId}`), { role: newRole }),
      "Member role updated"
    )) {
      try {
        const { data } = await api.get(social(`/communities/${community._id}/members`), { params: { q: memberSearch } });
        setMembers(data.members);
      } catch (requestError) {
        setMemberError(requestError.response?.data?.message || "Member roles were saved, but the list could not be refreshed.");
      }
    }
  }

  async function removeMember(memberId) {
    if (await doAction(() => api.delete(social(`/communities/${community._id}/members/${memberId}`)), "Member removed")) {
      setMembers((current) => current.filter((entry) => String(entry.user._id) !== String(memberId)));
    }
  }

  return <div className="community-page">
    <div className="community-hero"><div className="community-banner"><div className="community-cover big">{community.icon ? <img src={community.icon} alt="" /> : community.name.slice(0, 2)}</div><span>{community.isPublic ? "PUBLIC COMMUNITY" : "INVITE ONLY"}</span></div><div className="community-title-row"><div><h1>{community.name}</h1><p>{community.description || "A place for people who love playing together."}</p><div className="community-stats"><span><Users size={14} /> {community.memberCount ?? community.members?.length ?? 0} members</span><span>Started {new Date(community.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span></div></div>{!isMember ? <button className="primary-button" onClick={async () => { if (await doAction(() => api.post(social(`/communities/${community._id}/join`)), "You joined the community")) refreshCommunity(community._id); }}>Join community</button> : <div className="community-actions">{!community.isPublic && role && <button className="outline-button" onClick={makeInvitation}>Create invite link</button>}{canManage && <button className="outline-button" onClick={() => setShowAnnouncement((value) => !value)}><Megaphone size={14} /> Announce</button>}{canManage && <button className="outline-button" onClick={() => setEditMode((value) => !value)}><Settings size={15} /> Edit</button>}{isOwner && <button className="outline-button danger-button" onClick={deleteCommunity}><Trash2 size={14} /> Delete</button>}{role !== "owner" && <button className="outline-button" onClick={async () => { if (await doAction(() => api.post(social(`/communities/${community._id}/leave`)), "You left the community")) refreshCommunity(community._id); }}>Leave</button>}</div>}</div></div>
    {inviteUrl && <div className="invite-link-box">Invitation link: <input readOnly value={inviteUrl} onFocus={(event) => event.target.select()} /></div>}
    {showAnnouncement && <form className="announcement-form" onSubmit={announce}><input value={announcement} onChange={(event) => setAnnouncement(event.target.value)} maxLength="200" placeholder="Share an update with your community..." required /><button className="primary-button">Send announcement</button></form>}
    {editMode && <form className="inline-edit-form" onSubmit={saveCommunity}><input value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} maxLength="60" /><input value={details.description} onChange={(event) => setDetails({ ...details, description: event.target.value })} maxLength="500" /><label className="check-label"><input type="checkbox" checked={details.isPublic} onChange={(event) => setDetails({ ...details, isPublic: event.target.checked })} /> Public</label><button className="primary-button">Save changes</button><button type="button" className="text-button" onClick={() => setEditMode(false)}>Cancel</button></form>}
    {!isMember ? <EmptyState title="Come on in" text="Join this public community to explore channels and meet the members." /> : <div className="community-body">
      <section className="community-channel-section"><div className="section-title compact"><div><span className="eyebrow">PICK A CORNER</span><h2>Channels</h2></div>{canManageChannels && <button className="round-add" onClick={createChannel} aria-label="Add a channel"><Plus size={17} /></button>}</div>
        {community.channels?.length ? community.channels.map((item, index) => <div className="channel-row" key={item._id}><button className="channel-open" onClick={() => navigate(`/channels/${item._id}`)}><span className="channel-mark">{item.type === "text" ? <Hash size={17} /> : <Volume2 size={17} />}</span><span><strong>{item.name}</strong><small>{item.description || (item.type === "voice" ? "Join the lounge · voice and screen share" : "Chat with the community")}</small></span><span className="channel-type">{item.type}</span></button>{canManageChannels && <div className="channel-tools"><button onClick={() => moveChannel(item, -1)} disabled={index === 0} aria-label={`Move ${item.name} up`}><ArrowUp size={13} /></button><button onClick={() => moveChannel(item, 1)} disabled={index === community.channels.length - 1} aria-label={`Move ${item.name} down`}><ArrowDown size={13} /></button><button onClick={() => editChannel(item)} aria-label={`Edit ${item.name}`}><Settings size={13} /></button><button onClick={() => deleteChannel(item)} aria-label={`Delete ${item.name}`}><Trash2 size={13} /></button></div>}</div>) : <EmptyState title="No channels yet" text="A moderator can create a channel for this community." />}
      </section>
      <section className="community-members-section"><div className="section-title compact"><div><span className="eyebrow">THE CREW</span><h2>Members <span>{members.length}</span></h2></div></div><div className="member-search"><Search size={14} /><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Find a member..." maxLength="80" /></div>{memberError && <p className="inline-error">{memberError}</p>}{members.map((entry) => <div className="member-row" key={entry.user._id}><Link to={`/users/${entry.user.username}`} className="member-link"><Avatar user={entry.user} /><span><strong>@{entry.user.username}</strong><small>{entry.role}</small></span><i className={`presence-dot ${entry.user.status || "offline"}`} /></Link>{canManage && entry.role !== "owner" && (isOwner || entry.role !== "admin") && <select aria-label={`Role for ${entry.user.username}`} value={entry.role} onChange={(event) => changeMemberRole(entry.user._id, event.target.value)}><option value="member">Member</option><option value="moderator">Moderator</option>{isOwner && <option value="admin">Admin</option>}</select>}{canManage && entry.role !== "owner" && (isOwner || entry.role !== "admin") && <button className="member-remove" onClick={() => removeMember(entry.user._id)} aria-label={`Remove ${entry.user.username}`}><X size={13} /></button>}</div>)}</section>
    </div>}
  </div>;
}

function ProfilePage({ profile, setProfile, currentUser, presence, doAction, navigate }) {
  const [profileTab, setProfileTab] = useState("overview");
  const ownProfile = String(profile._id) === String(currentUser.id);
  const relation = profile.relationship || "none";
  const requestDirection = profile.requestDirection;
  async function acceptRequest() {
    if (await doAction(() => api.patch(social(`/friends/requests/${profile.requestId}/accept`)), "You are friends now")) {
      navigate(`/messages/${profile._id}`);
    }
  }
  async function declineRequest() {
    if (await doAction(() => api.patch(social(`/friends/requests/${profile.requestId}/reject`)), "Friend request declined")) {
      setProfile((current) => ({ ...current, relationship: "none", requestDirection: null, requestId: null }));
    }
  }
  async function cancelRequest() {
    if (await doAction(() => api.delete(social(`/friends/requests/${profile.requestId}`)), "Friend request cancelled")) {
      setProfile((current) => ({ ...current, relationship: "none", requestDirection: null, requestId: null }));
    }
  }
  return <div className="profile-page page-content">
    <section className="public-profile-card">
      <div className="profile-cover"><img src={heroArtwork} alt="" /><span className="profile-cover-fade" /></div>
      <div className="public-profile-content">
        <div className="profile-avatar-wrap"><Avatar user={profile} size="large" /><span className={`profile-presence ${presence[profile._id] || profile.status || "offline"}`} /></div>
        <div className="public-profile-actions">{ownProfile ? <button className="outline-button" onClick={() => navigate("/settings")}><Settings size={15} /> Edit profile</button> : relation === "none" ? <button className="primary-button" onClick={() => doAction(() => api.post(social(`/friends/${profile._id}`)), "Friend request sent")}>Add friend <Plus size={15} /></button> : relation === "pending" && requestDirection === "incoming" ? <><button className="primary-button" onClick={acceptRequest}>Accept request</button><button className="outline-button" onClick={declineRequest}>Decline</button></> : relation === "pending" ? <button className="outline-button" onClick={cancelRequest}>Cancel request</button> : <button className="outline-button" onClick={() => navigate(`/messages/${profile._id}`)}><MessageCircle size={15} /> Message</button>}</div>
        <div className="profile-heading-copy"><h1>{profile.username}</h1><p>{profile.bio || "This player is keeping their bio mysterious."}</p></div>
        <div className="profile-stat-row"><span><strong>{profile.friendsCount || 0}</strong><small>Friends</small></span><span><strong>{profile.gamesCount || 0}</strong><small>Published games</small></span><span><strong>{profile.communitiesCount || 0}</strong><small>Communities</small></span><span><strong>{presence[profile._id] || profile.status || "offline"}</strong><small>Status</small></span></div>
      </div>
    </section>
    <nav className="profile-tabs" aria-label="Profile sections">
      {["overview", "games", "activity", "communities", "friends"].map((tab) => <button key={tab} className={profileTab === tab ? "active" : ""} onClick={() => setProfileTab(tab)}>{tab}</button>)}
    </nav>
    {profileTab === "overview" && <div className="profile-overview-grid"><section className="profile-about"><span className="eyebrow">ABOUT</span><h2>Player profile</h2><p>{profile.bio || "No bio has been added yet."}</p></section><section className="profile-featured"><div className="section-title"><div><span className="eyebrow">FEATURED</span><h2>Published games</h2></div></div><EmptyState icon={Gamepad2} title="No public games yet" text="Published community games will appear here." /></section></div>}
    {profileTab === "games" && <div className="profile-tab-section"><div className="section-title"><div><span className="eyebrow">GAME PORTFOLIO</span><h2>Published games</h2></div></div><EmptyState icon={Gamepad2} title="No public games yet" text="This profile has not published a game." /></div>}
    {profileTab === "activity" && <div className="profile-tab-section profile-feed"><EmptyState icon={Sparkles} title="No recent activity" text="Supported profile activity will appear in this feed." /></div>}
    {profileTab === "communities" && <div className="profile-tab-section"><EmptyState icon={Users} title="No communities to show" text="Community memberships will appear here when available." /></div>}
    {profileTab === "friends" && <div className="profile-tab-section"><EmptyState icon={Users} title="No public friend list" text="Friends will appear here when profile privacy settings allow it." /></div>}
  </div>;
}

function SettingsPage({ settings, setSettings, saveProfile, uploadAvatar }) {
  const [saved, setSaved] = useState(false);
  async function submit(event) {
    if (await saveProfile(event)) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    }
  }
  return <div className="page-content settings-page"><div className="page-intro"><span className="eyebrow">PROFILE / ACCOUNT</span><h1>Account settings</h1><p>Manage the identity your people see.</p></div><form className="settings-card" onSubmit={submit}><div className="settings-heading"><Avatar user={{ username: settings.username, avatar: settings.avatar }} size="large" /><div><h2>Your profile</h2><p>Your profile is visible to other sideQUEST members.</p></div></div><label>Username<input value={settings.username} onChange={(event) => setSettings({ ...settings, username: event.target.value })} minLength="3" maxLength="24" pattern="[A-Za-z0-9_]+" required /></label><label>Avatar image URL<input value={settings.avatar.startsWith("/uploads/") ? "" : settings.avatar} onChange={(event) => setSettings({ ...settings, avatar: event.target.value })} placeholder="https://... (optional)" maxLength="2048" type="url" /></label><label className="upload-field">Or upload an avatar<input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadAvatar} /><small>JPEG, PNG, or WebP · up to 2 MB</small></label><label>About you<textarea value={settings.bio} onChange={(event) => setSettings({ ...settings, bio: event.target.value })} placeholder="What are you playing lately?" maxLength="300" rows="4" /><small>{settings.bio.length}/300</small></label><label>Default status<select value={settings.status} onChange={(event) => setSettings({ ...settings, status: event.target.value })}><option value="offline">Online when connected</option><option value="idle">Idle</option><option value="dnd">Do not disturb</option></select></label><div className="settings-footer"><span>Your email stays private · {settings.email}</span><button className="primary-button">{saved ? "Saved" : "Save changes"}</button></div></form></div>;
}

function InvitePage({ token, acceptInvite }) {
  return <div className="page-content invite-page"><span className="eyebrow">A FRIENDLY INVITATION</span><h1>There's room<br />for one more.</h1><p>Join the community and find your people.</p><button className="primary-button" onClick={() => acceptInvite(token)}>Accept invitation</button></div>;
}

function NotificationPanel({ notifications, onRead, onClose }) {
  return <div className="notification-panel"><div className="notification-heading"><strong>Notifications</strong><button className="text-button" onClick={onRead}>Mark all read</button><button className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button></div>{notifications.length ? notifications.slice(0, 12).map((item) => <div key={item._id} className={`notification-item ${item.readAt ? "" : "unread"}`}><Avatar user={item.actor || { username: "SQ" }} size="tiny" /><div><p>{item.message}</p><time>{new Date(item.createdAt).toLocaleDateString()}</time></div></div>) : <p className="quiet-note notification-empty">You're all caught up.</p>}</div>;
}

function Modal({ title, onClose, children }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header>{children}</section></div>;
}
