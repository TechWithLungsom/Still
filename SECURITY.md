# Security properties and limits

## Implemented protections

- Passwords use Node's asynchronous scrypt with a random 128-bit salt and timing-safe comparison. The server never returns password hashes to clients.
- Session tokens contain 256 random bits; only SHA-256 token digests are stored. Cookies are HTTP-only, SameSite=Strict, path-scoped, and Secure when configured for production. Sessions expire after seven days.
- Mutating HTTP requests require an allowed Origin. WebSocket handshakes require an allowed Origin and valid session; every event revalidates the session and conversation membership.
- Room membership is derived from authenticated account identity. Supplying another user ID cannot impersonate them.
- All variable database input uses bound parameters. User-provided content is rendered as text by React, never as injected HTML.
- API and login rate limits, account-level socket event limits, message size limits, upload limits, and storage quotas bound common abuse paths.
- Files are stored using generated UUIDs, served as attachments, and accessible only to their owner or members of the conversation after sharing. File names are sanitized. The upload directory is not served statically.
- HTTP security headers and a restrictive content security policy protect the built application. The frontend development server is not intended for public deployment.
- Logs exclude ordinary message bodies and credentials. Unexpected internal errors are logged for diagnosis; review observability configuration before handling sensitive data.

## Explicit limits

There is **no end-to-end encryption**, encrypted database, encrypted local cache, encrypted media, key verification, or encrypted recovery in this implementation. HTTPS protects transit only when deployed with HTTPS. The development configuration uses local HTTP. The service operator and anyone with access to database/upload files can read content. Shared-device users may recover browser data unless site data is removed; logout clears the account's active IndexedDB records but is not forensic secure erasure.

Delivery/read receipts are account-level watermarks. The server enforces membership and range limits, but a modified recipient client can claim it read any available message. This limitation is intrinsic to recipient-controlled read acknowledgments.

The server is designed as one process. Rate limits and connection routing are in memory. Do not deploy multiple independent instances against a network-mounted SQLite file. Migrate storage, event distribution, sessions, and rate limiting deliberately when scaling.

No public launch claim is made for registration abuse resistance, contact consent, account recovery, moderation, regulatory compliance, formal accessibility certification, or audited cryptographic confidentiality. Browser dependency and vulnerability scans are useful checks, not a security audit.

Maintain Node and dependencies, run the included tests after updates, configure HTTPS and backups, restrict operator access, and commission an independent review before accepting sensitive data or exposing this application publicly.

## Calls

Call start, accept, signal, and end events require an authenticated session and authorized participants. Only the selected caller and answering sockets may exchange SDP/ICE after acceptance. Other devices cannot inject signals into an active call. SDP and ICE data are bounded in size, not persisted, and do not appear in application logs. Busy reservations and active calls are in memory and end on server restart.

WebRTC encrypts media transport. This does not add encryption to stored messages or establish cryptographically verified participant identity independently of the signaling server. STUN may expose peer IPs; use a configured TURN relay with relay-only policy for IP masking. Browser camera/microphone permissions and TURN operations remain deployment requirements.
