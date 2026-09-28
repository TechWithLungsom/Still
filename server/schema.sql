PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
  title TEXT NOT NULL,
  direct_key TEXT UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'social' CHECK(mode IN ('social','focus','coordinate')),
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id,user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id,chat_id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','decision','file')),
  body TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  created_at INTEGER NOT NULL,
  UNIQUE(chat_id,seq),
  UNIQUE(sender_id,client_id)
);
CREATE TABLE IF NOT EXISTS votes (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  choice TEXT NOT NULL CHECK(choice IN ('agree','discuss')),
  PRIMARY KEY(message_id,user_id)
);

CREATE TABLE IF NOT EXISTS statuses (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
 media_id TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS statuses_expiry ON statuses(expires_at);
