import express from "express";
import { createCalls } from "./calls.js";
import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import {
  mkdirSync,
  unlinkSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { parse, serialize } from "cookie";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { Server } from "socket.io";
import { z } from "zod";
import { openDatabase, transaction } from "./db.js";

const derive = promisify(scrypt);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const id = z.string().uuid();
const credentials = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,24}$/),
  password: z.string().min(12).max(128),
});
const outgoing = z
  .object({
    chatId: id,
    clientId: id,
    kind: z.enum(["text", "decision", "file"]),
    body: z.string().trim().max(4000),
    attachmentId: id.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== "file" && !value.body)
      ctx.addIssue({ code: "custom", message: "Write a message first." });
    if (value.kind === "file" && !value.attachmentId)
      ctx.addIssue({ code: "custom", message: "Attach a file first." });
    if (value.kind !== "file" && value.attachmentId)
      ctx.addIssue({ code: "custom", message: "Invalid attachment." });
  });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  name: row.name,
});

export function createApplication(options = {}) {
  const production = process.env.NODE_ENV === "production";
  const origin =
    options.origin || process.env.APP_ORIGIN || "http://localhost:5173";
  const allowedOrigins = new Set([origin]);
  if (!production && origin === "http://localhost:5173")
    allowedOrigins.add("http://127.0.0.1:5173");
  const secure = options.secure ?? process.env.COOKIE_SECURE === "true";
  if (production && (!secure || !origin.startsWith("https://"))) {
    throw new Error(
      "Production requires COOKIE_SECURE=true and an HTTPS APP_ORIGIN.",
    );
  }
  const db = openDatabase(
    options.database || process.env.DATABASE_PATH || "./data/still.sqlite",
  );
  const uploadDir = resolve(
    options.uploadDir || process.env.UPLOAD_DIR || "./data/uploads",
  );
  mkdirSync(uploadDir, { recursive: true });
  const app = express();
  const http = createServer(app);
  const io = new Server(http, {
    maxHttpBufferSize: 32 * 1024,
    allowRequest: (req, callback) =>
      callback(null, allowedOrigins.has(req.headers.origin)),
  });
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
    }),
  );
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please wait a minute." },
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("CDN-Cache-Control", "no-store");
    res.set("Vercel-CDN-Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !allowedOrigins.has(req.headers.origin)
    ) {
      return res.status(403).json({ error: "Request origin is not allowed." });
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  const socketTickets = new Map();
  function sessionByHash(tokenHash) {
    if (!tokenHash) return null;
    return db
      .prepare(
        `SELECT u.*, s.token_hash, s.expires_at FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(tokenHash, Date.now());
  }
  function session(cookieHeader) {
    const token = parse(cookieHeader || "").still_session;
    return token ? sessionByHash(digest(token)) : null;
  }
  function requireAuth(req, res, next) {
    req.user = session(req.headers.cookie);
    if (!req.user)
      return res.status(401).json({ error: "Please sign in again." });
    next();
  }
  function setSession(res, userId) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      digest(token),
      userId,
      Date.now() + SESSION_MS,
    );
    res.setHeader(
      "Set-Cookie",
      serialize("still_session", token, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_MS / 1000,
      }),
    );
  }
  function member(userId, chatId) {
    const row = db
      .prepare("SELECT * FROM members WHERE chat_id=? AND user_id=?")
      .get(chatId, userId);
    if (!row)
      throw new HttpError(403, "You do not belong to this conversation.");
    return row;
  }
  function chatMembers(chatId) {
    return db
      .prepare(
        `SELECT u.id,u.name,u.username,m.read_seq AS readSeq,m.delivered_seq AS deliveredSeq
      FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY u.name`,
      )
      .all(chatId);
  }
  function messageView(row) {
    if (!row) return null;
    const attachment = row.attachment_id
      ? db
          .prepare("SELECT id,filename,size,mime FROM attachments WHERE id=?")
          .get(row.attachment_id)
      : null;
    return {
      id: row.id,
      clientId: row.client_id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      seq: row.seq,
      kind: row.kind,
      body: row.deleted_at ? "Message deleted" : row.body,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      attachment,
    };
  }
  function chatList(userId) {
    return db
      .prepare(
        `SELECT c.*,m.mode,m.read_seq FROM chats c JOIN members m ON c.id=m.chat_id
      WHERE m.user_id=? ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE chat_id=c.id),c.created_at) DESC`,
      )
      .all(userId)
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.title,
        mode: c.mode,
        ownerId: c.owner_id,
        members: chatMembers(c.id),
        lastSequence: c.next_seq,
        unread: db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND seq>? AND sender_id<>?",
          )
          .get(c.id, c.read_seq, userId).n,
        lastMessage: messageView(
          db
            .prepare(
              "SELECT * FROM messages WHERE chat_id=? ORDER BY seq DESC LIMIT 1",
            )
            .get(c.id),
        ),
      }));
  }
  function notifyChat(chatId, event, payload) {
    for (const m of chatMembers(chatId))
      io.to(`user:${m.id}`).emit(event, payload);
  }
  const socketRates = new Map();
  function throttle(userId) {
    const now = Date.now();
    let record = socketRates.get(userId);
    if (!record || now > record.until) {
      record = { count: 0, until: now + 60_000 };
      socketRates.set(userId, record);
    }
    if (++record.count > 300)
      throw new HttpError(429, "Please slow down and retry in a minute.");
  }
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
  });

  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.post("/api/auth/register", authLimit, async (req, res) => {
    const input = credentials
      .extend({ name: z.string().trim().min(1).max(48) })
      .parse(req.body);
    const salt = randomBytes(16).toString("hex");
    const hash = await derive(input.password, salt, 64);
    const userId = randomUUID();
    try {
      db.prepare("INSERT INTO users VALUES (?,?,?,?,?)").run(
        userId,
        input.username,
        input.name,
        `${salt}:${hash.toString("hex")}`,
        Date.now(),
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        throw new HttpError(409, "That username is already taken.");
      throw error;
    }
    setSession(res, userId);
    res.status(201).json({
      user: { id: userId, name: input.name, username: input.username },
    });
  });
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const input = credentials.parse(req.body);
    const user = db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(input.username);
    const [salt, expected] = user?.password_hash.split(":") || [
      "invalid-account-salt",
      "00".repeat(64),
    ];
    const actual = await derive(input.password, salt, 64);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), actual) || !user)
      throw new HttpError(401, "Incorrect username or password.");
    setSession(res, user.id);
    res.json({ user: publicUser(user) });
  });
  app.get("/api/auth/me", requireAuth, (req, res) =>
    res.json({ user: publicUser(req.user) }),
  );
  app.post('/api/auth/socket-ticket', requireAuth, (req, res) => {
    const now = Date.now();
    for (const [key, record] of socketTickets) if (record.expiresAt <= now) socketTickets.delete(key);
    const own = [...socketTickets.entries()].filter(([, record]) => record.tokenHash === req.user.token_hash);
    if (own.length >= 10) socketTickets.delete(own[0][0]);
    const ticket = randomBytes(32).toString('hex');
    socketTickets.set(digest(ticket), { tokenHash: req.user.token_hash, origin: req.headers.origin, expiresAt: now + 30_000 });
    res.json({ ticket });
  });
  app.post("/api/auth/logout", requireAuth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      req.user.token_hash,
    );
    io.in(`session:${req.user.token_hash}`).disconnectSockets(true);
    res.setHeader(
      "Set-Cookie",
      serialize("still_session", "", {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      }),
    );
    res.json({ ok: true });
  });
  app.get("/api/users", requireAuth, (req, res) => {
    const query = z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{2,24}$/)
      .parse(req.query.q);
    res.json({
      users: db
        .prepare(
          "SELECT id,name,username FROM users WHERE username LIKE ? ESCAPE '\\' AND id<>? LIMIT 20",
        )
        .all(`${query.replaceAll("_", "\\_")}%`, req.user.id),
    });
  });
  app.get("/api/calls/config", requireAuth, (req, res) => {
    const iceServers = JSON.parse(
      process.env.RTC_ICE_SERVERS ||
        '[{"urls":"stun:stun.l.google.com:19302"}]',
    );
    res.json({
      iceServers,
      iceTransportPolicy:
        process.env.RTC_RELAY_ONLY === "true" ? "relay" : "all",
    });
  });
  app.get("/api/chats", requireAuth, (req, res) =>
    res.json({ chats: chatList(req.user.id) }),
  );
  app.post("/api/chats", requireAuth, (req, res) => {
    const input = z
      .object({
        kind: z.enum(["direct", "group"]),
        title: z.string().trim().max(60).default(""),
        memberIds: z.array(id).min(1).max(19),
      })
      .parse(req.body);
    const ids = [...new Set([req.user.id, ...input.memberIds])];
    if (ids.length < 2 || (input.kind === "direct" && ids.length !== 2))
      throw new HttpError(400, "Select another person.");
    if (input.kind === "group" && !input.title)
      throw new HttpError(400, "Give your group a name.");
    for (const userId of ids)
      if (!db.prepare("SELECT id FROM users WHERE id=?").get(userId))
        throw new HttpError(400, "Unknown member.");
    const directKey = input.kind === "direct" ? ids.toSorted().join(":") : null;
    const existing =
      directKey &&
      db.prepare("SELECT id FROM chats WHERE direct_key=?").get(directKey);
    if (existing) return res.json({ chatId: existing.id });
    const chatId = randomUUID();
    transaction(db, () => {
      db.prepare(
        "INSERT INTO chats(id,kind,title,direct_key,owner_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        chatId,
        input.kind,
        input.title,
        directKey,
        req.user.id,
        Date.now(),
      );
      for (const userId of ids)
        db.prepare("INSERT INTO members(chat_id,user_id) VALUES(?,?)").run(
          chatId,
          userId,
        );
    });
    notifyChat(chatId, "chat:changed", { chatId });
    res.status(201).json({ chatId });
  });
  app.patch("/api/chats/:chatId/mode", requireAuth, (req, res) => {
    member(req.user.id, req.params.chatId);
    const { mode } = z
      .object({ mode: z.enum(["social", "focus", "coordinate"]) })
      .parse(req.body);
    db.prepare("UPDATE members SET mode=? WHERE chat_id=? AND user_id=?").run(
      mode,
      req.params.chatId,
      req.user.id,
    );
    io.to(`user:${req.user.id}`).emit("chat:changed", {
      chatId: req.params.chatId,
    });
    res.json({ ok: true });
  });
  app.get("/api/chats/:chatId/messages", requireAuth, (req, res) => {
    member(req.user.id, req.params.chatId);
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.after);
    const rows = db
      .prepare(
        "SELECT * FROM messages WHERE chat_id=? AND seq>? ORDER BY seq LIMIT 200",
      )
      .all(req.params.chatId, after);
    res.json({ messages: rows.map(messageView), hasMore: rows.length === 200, deleted: db.prepare("SELECT id FROM messages WHERE chat_id=? AND deleted_at IS NOT NULL").all(req.params.chatId).map(r => r.id) });
  });
  app.delete("/api/messages/:messageId", requireAuth, (req, res) => {
    const message = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.messageId);
    if (!message) throw new HttpError(404, "Message not found.");
    member(req.user.id, message.chat_id);
    if (message.sender_id !== req.user.id) throw new HttpError(403, "Only the sender can delete this message.");
    transaction(db, () => {
      db.prepare("DELETE FROM votes WHERE message_id=?").run(message.id);
      db.prepare("UPDATE messages SET body='',kind='text',attachment_id=NULL,deleted_at=COALESCE(deleted_at,?) WHERE id=?").run(Date.now(), message.id);
      if (message.attachment_id && !db.prepare("SELECT id FROM messages WHERE attachment_id=?").get(message.attachment_id)) {
        db.prepare("DELETE FROM attachments WHERE id=?").run(message.attachment_id);
      }
    });
    if (message.attachment_id && !db.prepare("SELECT id FROM attachments WHERE id=?").get(message.attachment_id)) {
      try { unlinkSync(resolve(uploadDir, message.attachment_id)); } catch (error) { if (error.code !== 'ENOENT') console.error('Attachment cleanup failed:', error.message); }
    }
    notifyChat(message.chat_id, "message:deleted", { chatId: message.chat_id, messageId: message.id });
    res.json({ ok: true });
  });
  app.get("/api/chats/:chatId/state", requireAuth, (req, res) => {
    member(req.user.id, req.params.chatId);
    res.json({
      members: chatMembers(req.params.chatId),
      votes: db
        .prepare(
          `SELECT v.message_id AS messageId,v.user_id AS userId,v.choice
      FROM votes v JOIN messages m ON m.id=v.message_id WHERE m.chat_id=?`,
        )
        .all(req.params.chatId),
    });
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, done) => done(null, randomUUID()),
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  });
  function canSeeStatus(userId, ownerId) {
    return userId === ownerId || Boolean(db.prepare("SELECT 1 FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=? LIMIT 1").get(userId, ownerId));
  }
  app.get("/api/statuses", requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT s.*,u.name FROM statuses s JOIN users u ON u.id=s.owner_id
      WHERE s.expires_at>? AND (s.owner_id=? OR EXISTS(SELECT 1 FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=s.owner_id)) ORDER BY s.created_at DESC LIMIT 200`).all(Date.now(), req.user.id, req.user.id);
    res.json({ statuses: rows.map(({media_id, ...row}) => ({...row, mediaUrl: media_id ? `/api/statuses/${row.id}/media` : null})) });
  });
  app.post("/api/statuses", requireAuth, (req, res, next) => {
    const count = db.prepare("SELECT COUNT(*) AS n FROM statuses WHERE owner_id=? AND expires_at>?").get(req.user.id, Date.now()).n;
    if (count >= 10) throw new HttpError(429, "You can share up to 10 active statuses.");
    next();
  }, multer({ storage: multer.diskStorage({destination: uploadDir, filename: (req,file,done) => done(null, randomUUID())}), limits: {fileSize: 10*1024*1024, files:1, fields:1, fieldSize:4000} }).single("file"), (req,res) => {
    try {
      const body = z.string().trim().max(700).parse(req.body.body || "");
      const allowed = ["image/jpeg","image/png","image/webp","video/mp4","video/webm"];
      if (req.file && !allowed.includes(req.file.mimetype)) throw new HttpError(400,"Choose a JPEG, PNG, WebP, MP4 or WebM file.");
      if (!body && !req.file) throw new HttpError(400,"Write a status or choose a photo/video.");
      if (db.prepare("SELECT COUNT(*) AS n FROM statuses WHERE owner_id=? AND expires_at>?").get(req.user.id, Date.now()).n >= 10) throw new HttpError(429,"You can share up to 10 active statuses.");
      const statusId = randomUUID(), now = Date.now();
      db.prepare("INSERT INTO statuses VALUES(?,?,?,?,?,?,?,?)").run(statusId,req.user.id,body,req.file?.filename || null,req.file?.mimetype || null,req.file?.size || 0,now,now+86400000);
      res.status(201).json({id:statusId});
    } catch(error) { if(req.file) {try {unlinkSync(req.file.path);} catch {}} throw error; }
  });
  app.get("/api/statuses/:statusId/media", requireAuth, (req,res) => {
    const status = db.prepare("SELECT * FROM statuses WHERE id=? AND expires_at>?").get(req.params.statusId,Date.now());
    if (!status || !status.media_id || !canSeeStatus(req.user.id,status.owner_id)) throw new HttpError(404,"Status not found.");
    res.type(status.mime).sendFile(resolve(uploadDir,status.media_id));
  });
  app.delete("/api/statuses/:statusId", requireAuth, (req,res) => {
    const status = db.prepare("SELECT * FROM statuses WHERE id=?").get(req.params.statusId);
    if (!status || status.owner_id !== req.user.id) throw new HttpError(404,"Status not found.");
    db.prepare("DELETE FROM statuses WHERE id=?").run(status.id);
    if(status.media_id) {try {unlinkSync(resolve(uploadDir,status.media_id));} catch {}}
    res.json({ok:true});
  });
  app.post(
    "/api/chats/:chatId/files",
    requireAuth,
    (req, res, next) => {
      member(req.user.id, req.params.chatId);
      if (
        db
          .prepare(
            "SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE owner_id=?",
          )
          .get(req.user.id).n >=
        100 * 1024 * 1024
      ) {
        throw new HttpError(413, "Your file storage limit is 100 MB.");
      }
      upload.single("file")(req, res, next);
    },
    (req, res) => {
      if (!req.file) throw new HttpError(400, "Select a file.");
      const filename =
        req.file.originalname
          .replace(/[\x00-\x1f\x7f/\\]/g, "_")
          .slice(0, 180) || "attachment";
      const allowedAudio = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);
      const submittedMime = req.file.mimetype.split(";")[0].toLowerCase();
      const mime = allowedAudio.has(submittedMime) ? submittedMime : "application/octet-stream";
      try {
        transaction(db, () => {
          const used = db
            .prepare(
              "SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE owner_id=?",
            )
            .get(req.user.id).n;
          if (used + req.file.size > 100 * 1024 * 1024)
            throw new HttpError(413, "Your file storage limit is 100 MB.");
          db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)").run(
            req.file.filename,
            req.params.chatId,
            req.user.id,
            filename,
            mime,
            req.file.size,
            Date.now(),
          );
        });
      } catch (error) {
        unlinkSync(req.file.path);
        throw error;
      }
      res.status(201).json({
        attachment: { id: req.file.filename, filename, size: req.file.size, mime },
      });
    },
  );
  app.get("/api/files/:fileId", requireAuth, (req, res) => {
    const file = db
      .prepare("SELECT * FROM attachments WHERE id=?")
      .get(req.params.fileId);
    if (!file) throw new HttpError(404, "File not found.");
    member(req.user.id, file.chat_id);
    if (
      file.owner_id !== req.user.id &&
      !db.prepare("SELECT id FROM messages WHERE attachment_id=?").get(file.id)
    ) {
      throw new HttpError(404, "File not found.");
    }
    if (req.query.play === "1" && ["audio/webm", "audio/mp4", "audio/ogg"].includes(file.mime)) {
      res.type(file.mime);
      return res.sendFile(resolve(uploadDir, file.id));
    }
    res.type("application/octet-stream");
    res.download(resolve(uploadDir, file.id), file.filename);
  });

  io.use((socket, next) => {
    let user;
    const ticket = socket.handshake.auth?.ticket;
    if (typeof ticket === 'string') {
      const key = digest(ticket);
      const record = socketTickets.get(key);
      socketTickets.delete(key);
      if (record && record.expiresAt > Date.now() && record.origin === socket.request.headers.origin) user = sessionByHash(record.tokenHash);
    } else {
      user = session(socket.request.headers.cookie);
    }
    if (!user) return next(new Error("Please sign in again."));
    socket.data.userId = user.id;
    socket.data.tokenHash = user.token_hash;
    socket.data.expiresAt = user.expires_at;
    next();
  });
  const calls = createCalls(io, db);
  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    socket.join(`session:${socket.data.tokenHash}`);
    const expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(1, socket.data.expiresAt - Date.now()),
    );
    expiryTimer.unref();
    socket.on("disconnect", () => clearTimeout(expiryTimer));
    function event(name, handler) {
      socket.on(name, (payload, ack) => {
        if (typeof ack !== "function") return;
        try {
          if (!sessionByHash(socket.data.tokenHash))
            throw new HttpError(401, "Please sign in again.");
          throttle(userId);
          ack({ ok: true, ...handler(payload) });
        } catch (error) {
          ack({
            ok: false,
            status: error instanceof z.ZodError ? 400 : error.status || 500,
            error:
              error instanceof z.ZodError
                ? error.issues[0].message
                : error.status
                  ? error.message
                  : "Unable to complete that action.",
          });
          if (!error.status && !(error instanceof z.ZodError))
            console.error(error);
        }
      });
    }
    calls.bind(socket, event);
    event("chat:join", (payload) => {
      const chatId = id.parse(payload.chatId);
      member(userId, chatId);
      for (const room of socket.rooms)
        if (room.startsWith("chat:")) socket.leave(room);
      socket.join(`chat:${chatId}`);
      return {};
    });
    event("message:send", (payload) => {
      const input = outgoing.parse(payload);
      member(userId, input.chatId);
      const result = transaction(db, () => {
        const old = db
          .prepare("SELECT * FROM messages WHERE sender_id=? AND client_id=?")
          .get(userId, input.clientId);
        if (old) {
          if (old.deleted_at && old.chat_id === input.chatId) return old;
          if (
            old.chat_id !== input.chatId ||
            old.body !== input.body ||
            old.kind !== input.kind ||
            old.attachment_id !== (input.attachmentId || null)
          ) {
            throw new HttpError(
              409,
              "This message ID was already used for different content.",
            );
          }
          return old;
        }
        if (
          input.attachmentId &&
          !db
            .prepare(
              "SELECT id FROM attachments WHERE id=? AND chat_id=? AND owner_id=?",
            )
            .get(input.attachmentId, input.chatId, userId)
        )
          throw new HttpError(400, "Invalid attachment.");
        const seq = db
          .prepare(
            "UPDATE chats SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq",
          )
          .get(input.chatId).next_seq;
        const messageId = randomUUID();
        db.prepare("INSERT INTO messages(id,client_id,chat_id,sender_id,seq,kind,body,attachment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
          messageId,
          input.clientId,
          input.chatId,
          userId,
          seq,
          input.kind,
          input.body,
          input.attachmentId || null,
          Date.now(),
        );
        return db.prepare("SELECT * FROM messages WHERE id=?").get(messageId);
      });
      const message = messageView(result);
      notifyChat(input.chatId, "message:new", { message });
      return { message };
    });
    event("message:receipt", (payload) => {
      const input = z
        .object({
          chatId: id,
          seq: z.number().int().min(0),
          type: z.enum(["delivered", "read"]),
        })
        .parse(payload);
      member(userId, input.chatId);
      const chat = db
        .prepare("SELECT next_seq FROM chats WHERE id=?")
        .get(input.chatId);
      if (input.seq > chat.next_seq)
        throw new HttpError(400, "Invalid receipt sequence.");
      const column = input.type === "read" ? "read_seq" : "delivered_seq";
      db.prepare(
        `UPDATE members SET ${column}=MAX(${column},?),delivered_seq=MAX(delivered_seq,?) WHERE chat_id=? AND user_id=?`,
      ).run(input.seq, input.seq, input.chatId, userId);
      notifyChat(input.chatId, "receipt:changed", {
        chatId: input.chatId,
        members: chatMembers(input.chatId),
      });
      return {};
    });
    event("decision:vote", (payload) => {
      const input = z
        .object({ messageId: id, choice: z.enum(["agree", "discuss"]) })
        .parse(payload);
      const message = db
        .prepare("SELECT * FROM messages WHERE id=? AND kind='decision'")
        .get(input.messageId);
      if (!message) throw new HttpError(404, "Decision not found.");
      member(userId, message.chat_id);
      db.prepare(
        "INSERT INTO votes VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET choice=excluded.choice",
      ).run(input.messageId, userId, input.choice);
      notifyChat(message.chat_id, "decision:changed", {
        chatId: message.chat_id,
        messageId: input.messageId,
        userId,
        choice: input.choice,
      });
      return {};
    });
    event("typing", (payload) => {
      const input = z
        .object({ chatId: id, active: z.boolean() })
        .parse(payload);
      member(userId, input.chatId);
      socket
        .to(`chat:${input.chatId}`)
        .emit("typing", { chatId: input.chatId, userId, active: input.active });
      return {};
    });
  });

  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  const dist = resolve("dist");
  if (process.env.SERVE_FRONTEND !== "false" && existsSync(dist)) {
    app.use(express.static(dist, { maxAge: production ? "1h" : 0 }));
    app.get("/{*path}", (req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof multer.MulterError
          ? 413
          : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      error:
        error instanceof z.ZodError
          ? error.issues[0].message
          : error instanceof multer.MulterError
            ? "Upload rejected. One file, up to 10 MB, is allowed."
            : status < 500
              ? error.message
              : "Something went wrong. Please retry.",
    });
  });
  function cleanup() {
    for (const status of db.prepare("SELECT * FROM statuses WHERE expires_at<=?").all(Date.now())) {
      if(status.media_id) {try {unlinkSync(resolve(uploadDir,status.media_id));} catch {}}
      db.prepare("DELETE FROM statuses WHERE id=?").run(status.id);
    }
    for (const [key, record] of socketTickets) if (record.expiresAt <= Date.now()) socketTickets.delete(key);
    db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
    for (const [key, value] of socketRates)
      if (value.until < Date.now()) socketRates.delete(key);
    const stale = db
      .prepare(
        `SELECT id FROM attachments WHERE created_at<? AND id NOT IN
      (SELECT attachment_id FROM messages WHERE attachment_id IS NOT NULL)`,
      )
      .all(Date.now() - 24 * 60 * 60_000);
    for (const file of stale) {
      try {
        unlinkSync(resolve(uploadDir, file.id));
      } catch (error) {
        if (error.code !== "ENOENT") continue;
      }
      db.prepare("DELETE FROM attachments WHERE id=?").run(file.id);
    }
    for (const name of readdirSync(uploadDir)) {
      const path = resolve(uploadDir, name);
      if (
        statSync(path).mtimeMs < Date.now() - 24 * 60 * 60_000 &&
        !db.prepare("SELECT id FROM attachments WHERE id=?").get(name) && !db.prepare("SELECT id FROM statuses WHERE media_id=?").get(name)
      )
        unlinkSync(path);
    }
  }
  const timer = setInterval(() => {
    try {
      cleanup();
    } catch (error) {
      console.error("Cleanup failed:", error.message);
    }
  }, 60_000);
  timer.unref();
  return {
    app,
    http,
    io,
    db,
    async close() {
      clearInterval(timer);
      calls.close();
      await new Promise((done) => io.close(done));
      db.close();
    },
  };
}
