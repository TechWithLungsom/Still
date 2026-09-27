# Still Messenger

A complete, runnable single-server messaging application built with React, Express, Socket.IO, and SQLite. All database tables are created automatically. There are no mock network services or placeholder event handlers.

## Run

Requires **Node.js 24 or later** and npm. From the directory containing the extracted `still` folder:

```sh
cd still && cp .env.example .env && npm ci && npm run dev
```

Open **http://localhost:5173**. The command starts the API on port 3001 and the frontend on port 5173. The frontend proxies API and WebSocket requests, so authentication uses same-origin HTTP-only cookies. Both localhost and 127.0.0.1 frontend origins are allowed in the default development configuration.

Create two accounts in separate browser profiles/private windows. Use at least 12 characters for each password. In either account, select **New conversation**, search the other account's username, select the person, and start chatting. Ordinary tabs share cookies and therefore share one account.

No demo accounts or user data are included in the source archive. Browser preview screenshots use disposable test accounts.

## Working features

- Registration and login; salted scrypt password hashes; expiring database-backed sessions; logout revokes the active session's sockets.
- Username search, unique direct conversations, and groups of up to 20 members.
- Persistent text messages, shared files, and decision cards with live agree/discuss votes.
- Authenticated WebSocket connections; server-authorized rooms; typing events; membership checks on every operation.
- Optimistic sending, a durable IndexedDB outbox, automatic reconnection, and cursor-based history synchronization.
- Stable client message IDs prevent duplicate insertion after lost acknowledgments.
- Sending/queued/sent/delivered/read states and group receipt counts.
- One-to-one audio/video calls with incoming answer/decline, mute, camera on/off, camera switching, a call timer, and hang-up.
- Personal Social, Focus, and Coordinate modes. Focus hides typing activity and unread badges. Decisions have a dedicated view in every mode.
- File uploads up to 10 MB, a 100 MB stored-file quota per account, authorized downloads, and daily-age cleanup of unshared uploads.
- Responsive dark UI with mobile navigation, keyboard controls, reduced-motion support, and accessible form labels.
- Build output is served by the backend when `dist/` exists.

## Files

```text
still/
  .env.example
  .gitignore
  package.json
  package-lock.json
  index.html
  vite.config.js
  README.md
  SECURITY.md
  server/
    index.js                 # Process entry, listen, graceful shutdown
    app.js                   # Authentication, API, files, Socket.IO, authorization
    calls.js                 # Authorized call signaling and lifecycle
    db.js                    # SQLite connection and transactions
    schema.sql               # Users, sessions, chats, membership, messages, receipts, votes
  src/
    main.jsx                 # Authentication, inbox, chat, decisions, files, details
    styles.css               # Complete responsive design system
    api.js                   # Fetch and acknowledged WebSocket helpers
    storage.js               # IndexedDB persistence
    useMessenger.js          # Offline outbox, realtime events, sync, receipts
    useCalls.js              # WebRTC capture, signaling, media and cleanup
    CallPanel.jsx            # Incoming and active call interface
  test/
    integration.test.js      # Real HTTP/WebSocket/database tests
    calls.test.js            # Call authorization and lifecycle tests
    webrtc.html              # Generated-media browser transport check
```

## Verification

```sh
npm test
npm run build
npm audit --omit=dev
```

The integration suite runs an isolated server on an ephemeral port and uses temporary database/files. The messaging suite verifies 12 scenarios: authentication and origin validation; direct-chat uniqueness and access control; live delivery and idempotency; monotonic receipts; reconnect catch-up; voting; personal modes; group broadcast; private file access; typing authorization; logout revocation; and restart persistence. The calling suite adds seven scenarios. Node's test runner reports 21 passing tests: 19 scenarios and two parent tests.

Browser verification covered login, conversation creation, message sending, real-time incoming messages, read receipts, voting, Focus mode, a mobile viewport, and queuing a message while the server was stopped followed by successful replay after restart.

## Built deployment

```sh
npm run build && npm start
```

For a local built preview, set `APP_ORIGIN=http://localhost:3001` in `.env` before this command, and open that origin. Development mode keeps the cookie usable over local HTTP.

For an Internet deployment, terminate HTTPS at a reverse proxy, forward WebSocket upgrades, set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `APP_ORIGIN` to the exact HTTPS public origin. The server rejects an insecure production configuration. Keep the backend private and preserve the Origin header. Do not expose the Vite development server publicly. No proxy is trusted automatically; configure trusted proxy hops deliberately before depending on client-IP rate limits behind a proxy.

`PORT` controls the backend; the provided Vite proxy targets port 3001. If changing the backend port in development, update `vite.config.js` too. `DATABASE_PATH` and `UPLOAD_DIR` are relative to the project directory unless absolute paths are supplied. Frontend changes refresh automatically; restart `npm run dev` after backend changes.

## Delivery semantics

The server acknowledges a send only after the message transaction commits. Socket emissions are best-effort wakeups. Durable message history is authoritative: clients recover missed records through `/messages?after=sequence`, including periodically while connected. Sequence assignment and duplicate detection occur in a synchronous SQLite transaction.

A browser marks delivery only after it persists the contiguous downloaded history in IndexedDB. Read receipts are sent while the conversation is visible and scrolled to the latest messages. Receipts are per account, not per device; any signed-in browser can advance an account's cursor. Read is an interface event, not proof that a human understood a message.

Queued outgoing messages persist across ordinary reloads. They are retried after reconnection and removed after server acceptance and reconciliation. Unknown outcomes reuse the same message ID. Permanent validation/authorization failures expose Retry. Sign-out warns about unsent messages and clears this account's local cache. Browser eviction or manually clearing site data can remove local queues. The app requires an initial connection for authentication and does not include a service worker for cold-start offline loading.

## Scope and production boundary

This is a working **single-process reference implementation**, not an independently audited WhatsApp replacement. It deliberately does not claim end-to-end encryption. Server messages, uploaded files, and IndexedDB history are plaintext at rest; use only appropriate test/non-sensitive content until the security design is upgraded. See SECURITY.md.

Group calling, stories, push notifications, AI summaries, shared capsules, account recovery, editable group membership, blocking/reporting, message editing/deletion, and encrypted backup are not implemented. There are no nonfunctional buttons advertising them.

SQLite and local disk make the app easy to run without external services. They are not a horizontally distributed architecture. The client downloads conversation history in 200-message pages and retains it locally; very large histories require bounded caching and UI virtualization. Vote snapshots are fetched per conversation. Delivery and read states aggregate per user. Uploaded files are downloads, with no inline preview or server-side execution.

Before public production use, complete an independent security review, abuse and recovery flows, privacy/deletion policy, load and disaster-recovery testing, a maintained encryption protocol integration if required, and infrastructure appropriate to the intended scale. Back up both the database and upload directory consistently; do not copy only the main SQLite file while ignoring its active WAL. There is no claim of zero-loss regional failover.

## Calling

Use the phone or video icon in a direct conversation. Both people must be signed in and connected. Calls ring in all the recipient's connected tabs; the first accepting tab becomes the call endpoint. The caller's tab and that answering tab exclusively exchange signaling. Calls decline automatically after 45 seconds unanswered, and end if a participating socket disconnects. This build has no background mobile push ringing, group calls, or call-history records.

The browser requests microphone/camera access only after Start or Answer. Voice calls request audio only. Video calls request both. Muting disables the audio track; camera off disables the video track (it does not revoke browser permission). End call stops capture tracks and closes the peer connection. Camera switching requires another available input; unsupported switches show an error and retain the current input.

WebRTC protects media in transit. The signaling server can see session descriptions and network candidates; this is not identity-verified Signal-style E2EE. Direct connections can reveal peer network addresses. Set RTC_RELAY_ONLY=true with a provisioned TURN relay if peer IP privacy is required.

RTC_ICE_SERVERS is a JSON array of WebRTC ICE server configurations, returned only to authenticated users. The default is a public STUN service. Restrictive NAT/firewalls need TURN. Configure your own TURN URLs and credentials in .env; there is no hosted relay bundled with this repository. In production use HTTPS and provision short-lived TURN credentials through your infrastructure; do not treat client-delivered relay credentials as secret from authenticated clients. TURN usage and quotas must be monitored.

The call integration tests cover authenticated configuration, nonmember rejection, ringing, busy handling, multi-device answer arbitration, SDP/ICE authorization, hang-up, decline, disconnect, and offline recipients. They test signaling, not physical microphone/camera hardware. For a browser transport test, run the development server and open `/test/webrtc.html`; Run transport check uses generated media (no camera/microphone capture), verifies received audio bytes and decoded video frames, then tests mute and video-track replacement. Stop verifies track and peer cleanup. Device permissions and cross-network TURN connectivity still need testing on your target devices and deployed relay.

The generated-media browser check passed with received audio bytes and decoded video frames, mute/unmute, video track replacement, and cleanup. Incoming-call display and decline were also checked in the running application. Physical camera/microphone capture and deployed TURN routing have not been verified.

## Vercel frontend and Render backend

Configured frontend: https://still-chatapp.vercel.app
Configured backend: https://still-a071.onrender.com

Vercel builds with `npm run build:vercel` and publishes `dist`. Its `/api/*` rewrite forwards HTTP requests to Render without caching private responses. The frontend derives its public WebSocket URL from `vercel.json`; no secrets belong in Vite variables. Authenticated HTTP requests obtain a 30-second, single-use ticket to connect directly to Render. Cookies remain on the frontend domain.

Render requires Node 24+, `npm ci`, `npm start`, `HOST=0.0.0.0`, `NODE_ENV=production`, `COOKIE_SECURE=true`, `APP_ORIGIN=https://still-chatapp.vercel.app`, and `SERVE_FRONTEND=false`. Let Render supply PORT. For durable storage, attach a persistent disk at `/var/data` and use `DATABASE_PATH=/var/data/still.sqlite` and `UPLOAD_DIR=/var/data/uploads`. The existing free service can run with `./data/still.sqlite` and `./data/uploads` only as an ephemeral demo: accounts, messages and files can disappear on restart/redeploy. The included paid blueprint is an optional durable deployment configuration, not a record of purchased resources.

To change domains, run `npm run configure:hosting -- --backend https://ACTUAL-RENDER-DOMAIN --frontend https://ACTUAL-VERCEL-DOMAIN`, then update Render APP_ORIGIN and redeploy both services. `deployment/urls.json` records the durable configuration. Keep one backend instance while using local SQLite and in-memory socket tickets. Provision TURN for calls across restrictive networks; the default STUN-only configuration cannot guarantee every connection.
