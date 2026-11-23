# 🎮 Sidequest

### Play Instantly. Connect Naturally. Create Freely.

Sidequest is a browser-first gaming and social platform where players can discover and play games without downloads or installations. Creators can publish their browser games, while players can connect with friends, build communities, compete on leaderboards, and hang out in persistent voice lounges.

## ✨ Features

- 🎮 **Browser Gaming** – Discover and play HTML5, Godot Web, and Unity WebGL games instantly.
- 🚀 **Game Studio** – Upload, preview, publish, and manage browser-game builds.
- ☁️ **Cloud Saves** – Save and restore game progress across sessions.
- 🏆 **Leaderboards** – Compete through game-specific high scores.
- 👥 **Social** – Friends, direct messages, game invitations, and live presence.
- 🌐 **Communities** – Public and private communities with roles, text channels, and voice channels.
- 🎙️ **Persistent Voice Lounges** – Stay connected while browsing games and navigating Sidequest.
- 🔔 **Notifications** – Real-time updates for messages, invitations, and community activity.

## 🛠️ Tech Stack

| Frontend | Backend | Communication |
|---|---|---|
| React | Node.js | Socket.IO |
| Vite | Express | WebRTC |
| React Router | MongoDB | REST APIs |
| Axios | Mongoose | JWT |

**Additional tools:** Multer, AdmZip, Helmet, CORS, CSRF Protection, Lucide Icons.

## 🚀 Getting Started

**Requirements:** Node.js 20+, MongoDB, npm.

Clone the repository:

```bash
git clone <repository-url>
cd Sidequest
```

Install dependencies:

```bash
npm install
cd server && npm install
cd ../client && npm install
```

Configure `server/.env`:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
CLIENT_URL=http://localhost:5173
```

Run the backend:

```bash
cd server
npm run dev
```

Run the frontend in another terminal:

```bash
cd client
npm run dev
```

Open `http://localhost:5173`.

## 🎮 Publishing Games

1. Export your game for the web.
2. Ensure the build contains an `index.html` entry point.
3. ZIP the exported build.
4. Open **Game Studio** and upload the ZIP.
5. Select the engine and genre.
6. Preview and publish your game.

Supported builds include HTML5, Godot Web, and Unity WebGL.

## 🔌 Game SDK

Sidequest provides a `window.postMessage` bridge for embedded games to access player information, cloud saves, and score submission.

```javascript
// Get player information
window.parent.postMessage({
  type: "sidequest:get-player"
}, "*");

// Load saved progress
window.parent.postMessage({
  type: "sidequest:load"
}, "*");

// Save progress and submit score
window.parent.postMessage({
  type: "sidequest:save",
  data: { level: 4, coins: 250 },
  highScore: 1200
}, "*");
```

Production integrations should validate message origins and payloads.

## 🔐 Security

- Secure ZIP extraction and upload limits.
- Sandboxed game iframes.
- CSRF protection and rate limiting.
- Input validation and security headers.
- Temporary file cleanup.

---

**Sidequest — Find your game. Find your people. Find your sidequest.**
