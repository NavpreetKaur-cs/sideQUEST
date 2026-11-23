# Gameyy / sideQUEST

Gameyy is a full-stack social gaming workspace built with React, Vite, Express, MongoDB/Mongoose, Socket.IO, and browser-game upload support.

## What is implemented

Gameyy / sideQUEST is a browser-based social gaming app. It combines player accounts, messaging, communities, voice rooms, and a studio for publishing browser-playable games.

### Accounts and profiles

- Register and sign in with email and password; restore or log out of a session.
- Optional Google sign-in with account linking by verified email.
- Edit username, bio, avatar, and status; upload JPEG, PNG, or WebP avatars.
- Browse player profiles, search for people, and see online, idle, or do-not-disturb presence.

### Friends, messaging, and notifications

- Send, accept, reject, or cancel friend requests; remove friends and search users.
- Send direct messages and create group conversations.
- Edit or delete messages, see typing indicators and read receipts, and track unread messages.
- Receive notifications for new direct messages and mark notifications as read.
- Realtime updates and presence are delivered with authenticated Socket.IO connections.

### Communities and voice

- Discover and join public communities; create private or public communities.
- Manage members with owner, admin, moderator, and member roles.
- Create and order text or voice channels, set channel access by role, and manage invitations.
- Post community announcements and manage community details and membership.
- Join peer-to-peer voice rooms, mute the microphone, and share a screen. Voice signaling is relayed through the authenticated realtime server.

### Browser-game studio

- Upload browser/web exports as ZIP files and identify the engine used (Godot, Unity, Unreal, HTML5/JavaScript, or another engine).
- Create drafts, publish games, play published builds in the browser, replace a build, update its thumbnail, and delete games.
- Keep the published URL, status, and thumbnail when replacing a build.
- Browse published games, search/filter discovery, view play counts, and see popular games.
- Validate ZIP paths, entry points, file count, compressed size, and extracted size; reject blocked executable/script extensions.
- Run uploaded HTML and WebAssembly game exports with game-specific headers and a browser sandbox.
- Native desktop and console builds are not browser-playable and are not supported by the studio.

### Included sample game

- `godot-game1-websocket/` contains Desert Rush, a two-player Godot racing game with a browser export and a separate LAN WebSocket server.
- Godot is optional for the main app and for uploaded browser builds. The LAN server is only needed to host multiplayer races in Desert Rush; start it separately with `npm run dev:game-server`.

### App and security foundations

- Responsive authenticated dashboard with home, game discovery, game studio, friends, messages, profiles, communities, settings, and invitation screens.
- HttpOnly JWT session cookies, CSRF checks, trusted-origin and CORS validation, Helmet headers, MongoDB query sanitization, and API rate limits.
- Upload limits and validation for game ZIPs, profile avatars, and game thumbnails.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React 19, Vite 8, React Router 7, Axios, Lucide icons |
| Backend | Node.js 20+, Express 4 |
| Database | MongoDB and Mongoose |
| Realtime | Socket.IO |
| Auth | bcryptjs, JWT, Google OAuth2/OIDC |
| Uploads | Multer, ADM-ZIP |
| Security | Helmet, CORS, cookie-parser, express-validator, express-mongo-sanitize, express-rate-limit |
| Tests | Node test runner, Supertest, MongoDB Memory Server |

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- npm
- A MongoDB URI for Atlas or a local MongoDB database
- Google OAuth credentials only if Google sign-in is required

## Install

From the project root:

```powershell
npm install
npm install --prefix server
npm install --prefix client
```

The root dependency set includes `concurrently`, which runs the frontend and backend together. The optional Godot server is a separate command.

## Environment configuration

Create `server/.env` and configure:

```env
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@HOST/DATABASE
JWT_SECRET=replace-with-at-least-32-random-characters
JWT_EXPIRES_IN=7d
COOKIE_SAME_SITE=lax
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback
```

Generate a JWT secret:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Do not commit `.env`, database passwords, OAuth secrets, or JWT secrets. If credentials have already been committed, rotate them immediately.

For production:

- Set `NODE_ENV=production`.
- Use HTTPS for the frontend and API.
- Set `CLIENT_ORIGIN` to the exact public frontend origin.
- Set `COOKIE_SAME_SITE=none` when the frontend and API use cross-site origins.
- Keep `Secure` cookies enabled.
- Replace local `server/uploads` storage with object storage for multi-instance deployments.
- Configure Google OAuth authorized JavaScript origins and callback URLs in Google Cloud.

## Run the project

Start the frontend and backend from the repository root. This is all that is needed to browse uploaded games:

```powershell
npm run dev
```

Expected addresses:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:5000`
- Health check: `http://localhost:5000/api/health`

Godot is not required to run browser game builds. The optional Godot server is only needed to host multiplayer races in the included Desert Rush game; start it separately with `npm run dev:game-server` if needed.

Run one process at a time:

```powershell
npm run dev:server
npm run dev:client
npm run dev:game-server
```

Stop `npm run dev` with **Ctrl+C** in its terminal. To check whether the frontend or API ports are listening:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(5000,5173,5174,5175,5176) } |
  Select-Object LocalPort,OwningProcess
```

If port `5000` or port `5173` is occupied, stop stale processes before restarting. Vite will otherwise select a new port, while API and OAuth origins remain configured for the original address.

## Authentication API

All authentication routes use `/api/auth`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/csrf` | Issue a CSRF cookie and token |
| `POST` | `/register` | Register with username, email, and password |
| `POST` | `/login` | Log in with email and password |
| `GET` | `/me` | Return the current session user |
| `POST` | `/logout` | Clear the session cookie |
| `GET` | `/google/url` | Generate a Google OAuth redirect URL |
| `GET` | `/google/callback` | Complete Google OAuth and issue a session |

Registration example:

```json
{
  "username": "player_one",
  "email": "player@example.com",
  "password": "a-long-password"
}
```

Passwords are hashed with bcrypt. JWTs are stored in HttpOnly session cookies and are not written to browser local storage. Axios mutation requests receive `x-csrf-token` automatically.

## Social API

Social endpoints use `/api/social` and generally require authentication.

| Capability | Routes |
| --- | --- |
| Profiles/search | `GET /users?q=...`, `GET /users/:username`, `PATCH /profile` |
| Avatar upload | `PATCH /profile` with multipart field `avatar` |
| Friends | `GET /friends`, `GET /friends/requests`, `POST /friends/:userId`, `PATCH /friends/requests/:requestId/accept`, `PATCH /friends/requests/:requestId/reject`, `DELETE /friends/:userId`, `DELETE /friends/requests/:requestId` |
| Communities | `GET /communities?q=...`, `GET /communities/mine`, `POST /communities`, `GET/PATCH/DELETE /communities/:communityId`, `POST /communities/:communityId/join`, `POST /communities/:communityId/leave` |
| Members/invitations | `GET /communities/:communityId/members?q=...`, `PATCH/DELETE /communities/:communityId/members/:userId`, `POST /communities/:communityId/invitations`, `POST /invitations/:token/accept`, `POST /communities/:communityId/announcements` |
| Channels | `POST /communities/:communityId/channels`, `PATCH/DELETE /communities/:communityId/channels/:channelId`, `GET /channels/:channelId`, `GET/POST /channels/:channelId/messages` |
| Conversations | `POST /conversations/group`, `GET/POST /conversations/direct/:userId/messages`, `GET/POST /conversations/:conversationId/messages`, `POST /conversations/:conversationId/read` |
| Messages | `PATCH/DELETE /messages/:messageId` |
| Notifications | `GET /notifications`, `PATCH /notifications/:notificationId/read`, `PATCH /notifications/all/read` |

Community roles are enforced server-side. Channel membership and role changes revoke access to private realtime rooms.

## Browser-game studio

The game studio is available at `/games` in the authenticated dashboard. It is separate from community Discovery.

Studio sections:

- **Studio overview**: upload new game builds and view recent projects.
- **My builds**: drafts and published games, build replacement, thumbnail uploads, play links, and delete controls.

Supported uploads:

- Web/browser exports from any engine, including Godot, Unity, and Unreal.
- ZIP archives containing the exported HTML entry point and its browser assets.
- Native desktop/console builds are not playable in a browser and are not supported.

Game API routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/games/public` | List published games |
| `GET` | `/api/games/mine` | List the authenticated owner's games |
| `POST` | `/api/games/upload` | Upload a ZIP game draft |
| `PUT` | `/api/games/:id/build` | Replace an owned game's browser build |
| `POST` | `/api/games/:id/publish` | Publish an owned draft |
| `DELETE` | `/api/games/:id` | Delete an owned game and extracted files |
| `GET` | `/games/play/:slug` | Play a published game |

Upload rules:

- Maximum ZIP size: 500 MB.
- Maximum extracted size: 500 MB.
- Maximum 1,000 ZIP entries.
- Title length: 2-80 characters.
- Description length: maximum 1,000 characters.
- Entry point defaults to `index.html`.
- Optional `manifest.json` may define `entryPoint`.
- An update keeps the existing game URL, publication status, and thumbnail.
- Unsafe paths and directory traversal are rejected.
- Executable and script extensions such as `.exe`, `.dll`, `.bat`, `.sh`, `.php`, and `.py` are blocked.

Every upload must be a browser/web export containing an HTML entry file; native desktop builds cannot run on the site. This applies to Godot, Unity, Unreal, and other engines. A typical ZIP contains `index.html`, generated JavaScript/WASM files, and exported asset files.

Hosted game pages use a game-specific Content Security Policy that permits inline and WebAssembly startup code, while browser sandboxing keeps uploaded games isolated from the app. Game assets opt into cross-origin loading for engine runtimes.

Run `npm run dev:game-server` separately only when you want to host multiplayer races in the included Godot game. The browser export itself runs without Godot installed.

```text
game.zip
├── index.html
├── manifest.json
├── game.js
├── game.wasm
└── assets/
```

Example manifest:

```json
{
  "entryPoint": "index.html"
}
```

## Uploaded storage

Avatar uploads are stored under:

```text
server/uploads/
```

Game builds are extracted under:

```text
server/uploads/games/<user-id>/<build-id>/
```

Published games are served through:

```text
/games/play/<slug>
```

The server redirects to the extracted entry HTML. For public production hosting, extracted game assets should be isolated, scanned, size-quota limited, and preferably served from immutable object storage or a sandboxed static-hosting service.

## Socket.IO

Socket.IO uses the same HttpOnly session cookie as REST authentication. Supported client events include:

- `presence:set`
- `channel:join`
- `channel:leave`
- `conversation:join`
- `conversation:leave`
- `typing:start`
- `typing:stop`
- `message:send`

Supported server events include:

- `presence:update`
- `presence:snapshot`
- `presence:remove`
- `message:new`
- `message:updated`
- `message:read`
- `typing:update`
- `notification:new`

Presence is tracked in memory and should use a shared Redis/Socket.IO adapter for multiple server instances.

## Avatar uploads

Avatar uploads accept JPEG, PNG, and WebP signatures and reject spoofed content. The limit is 2 MB.

Multipart field name:

```text
avatar
```

## Client UI

The interface uses a near-black visual system with red actions and blue focus/presence accents.

Main dashboard routes:

- `/` - Home
- `/friends` - Friend and group chat management
- `/discover` - Community discovery
- `/servers/:id` - Community home
- `/channels/:id` - Community channel
- `/messages/:id` - Direct message
- `/groups/:id` - Group conversation
- `/users/:username` - Public profile
- `/settings` - Account and profile settings
- `/games` - Dedicated game studio
- `/invite/:token` - Community invitation

Avatar styles use circular shapes and stable dimensions. Main panels use thin borders, dark surfaces, restrained shadows, and motion limited to meaningful hover, press, and entrance states.

## Major files

- `package.json` - Root scripts for launching frontend and backend together.
- `client/src/App.jsx` - React routes.
- `client/src/pages/Dashboard.jsx` - Dashboard, social pages, settings, profiles, and game studio.
- `client/src/App.css` - Complete UI design system and responsive layout.
- `client/src/context/AuthContext.jsx` - Session state and login/logout actions.
- `client/src/services/api.js` - Axios API client and CSRF handling.
- `server/server.js` - HTTP server startup and database connection.
- `server/app.js` - Express middleware and route registration.
- `server/config/db.js` - MongoDB/Atlas plus development-memory fallback behavior.
- `server/models/` - Mongoose models.
- `server/controllers/` - Authentication, social, and game operations.
- `server/routes/` - REST route definitions.
- `server/middleware/` - Authentication, CSRF, origin, validation, and avatar upload middleware.
- `server/realtime.js` - Socket.IO authentication, presence, rooms, typing, and messages.
- `server/tests/` - Authentication, social, and game upload/play/update integration tests.

## Database fallback

`MONGODB_URI` is required. When it is configured but the database connection fails, `server/config/db.js` may fall back to `mongodb-memory-server` outside production. This fallback is temporary and data does not persist after the process exits.

In production, a database connection failure stops startup and is not masked by the memory server.

## Testing

Run all server tests:

```powershell
cd server
npm test
```

Run the client production build:

```powershell
cd client
npm run build
```

Run both from the root:

```powershell
npm run dev
```

## Security notes

- Session cookies use `HttpOnly` and `SameSite` settings.
- CSRF checks apply to POST, PUT, PATCH, and DELETE mutations outside test mode.
- Mutations are restricted by trusted browser origin.
- Passwords are bcrypt-hashed.
- Google OAuth verifies email and ID-token payload information.
- ZIP uploads reject path traversal and executable/script formats.
- Authorization checks are enforced in API and Socket.IO server code.
- Local game storage is not a substitute for a production malware/content moderation pipeline.
- Public deployment should add moderator approval, malware scanning, per-user quotas, object storage, isolated game hosting, and audit logs. Uploaded game files are untrusted; keep the game sandbox and Content Security Policy in place.

## API health check

```powershell
Invoke-RestMethod -Uri http://localhost:5000/api/health
```

Expected response:

```json
{
  "status": "ok"
}
#   s i d e Q U E S T  
 #   s i d e Q U E S T  
 