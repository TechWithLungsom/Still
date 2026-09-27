import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Circle,
  CircleHelp,
  Download,
  FileText,
  Hash,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Moon,
  Paperclip,
  Phone,
  Video,
  Plus,
  Search,
  Send,
  ListChecks,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { api } from "./api";
import { clearLocalUser } from "./storage";
import { useMessenger } from "./useMessenger";
import "./styles.css";
import { useCalls } from "./useCalls";
import { VoiceRecorder } from "./VoiceRecorder";
import { CallPanel } from "./CallPanel";

const MODES = {
  social: {
    label: "Social",
    detail: "A familiar space for everyday conversation.",
    icon: MessageCircle,
  },
  focus: {
    label: "Focus",
    detail: "Hide typing activity and quiet unread badges.",
    icon: Moon,
  },
  coordinate: {
    label: "Coordinate",
    detail: "Keep shared decisions close to the conversation.",
    icon: ListChecks,
  },
};
const time = (value) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const chatTitle = (chat, user) =>
  chat.kind === "group"
    ? chat.title
    : chat.members.find((m) => m.id !== user.id)?.name || "Conversation";
function Avatar({ name, group = false, small = false }) {
  return (
    <span
      className={`avatar ${group ? "group-avatar" : ""} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {group ? (
        <Users size={small ? 17 : 21} />
      ) : (
        name
          .split(" ")
          .map((n) => n[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      )}
    </span>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      still<span className="brand-dot">.</span>
    </span>
  );
}
function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function Auth({ onLogin }) {
  const [register, setRegister] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (register && form.password !== form.confirmPassword) throw new Error("Passwords do not match.");
      delete form.confirmPassword;
      const data = await api(`/auth/${register ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      onLogin(data.user);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <span className="eyebrow">A LITTLE LESS NOISE</span>
        <h1>
          Make room
          <br />
          for real
          <br />
          <em>connection.</em>
        </h1>
        <p>
          A thoughtful space for your people.
          <br />
          Conversations, shared decisions, and a quieter day.
        </p>
        <div className="orbit">
          <div className="orbit-center">
            <MessageCircle size={36} />
          </div>
          <span className="orbit-label">
            Good things start with a conversation.
          </span>
        </div>
        <span className="auth-foot">Your people. Your pace.</span>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">WELCOME TO STILL</span>
          <h2>{register ? "Find your people." : "Welcome back."}</h2>
          <p className="muted">
            {register
              ? "Create an account and start a conversation."
              : "Pick up right where you left off."}
          </p>
          {register && (
            <label>
              Your name
              <input
                name="name"
                autoComplete="name"
                maxLength={48}
                required
                placeholder="How should we call you?"
              />
            </label>
          )}
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              pattern="[a-z0-9_]{3,24}"
              minLength={3}
              maxLength={24}
              required
              placeholder="e.g. maya_chen"
              title="3–24 lowercase letters, numbers, or underscores"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              required
              placeholder="At least 12 characters"
            />
          </label>
          {register && <label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="Re-enter your password" /></label>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <>
                {register ? "Create your account" : "Sign in"}
                <ArrowRight size={18} />
              </>
            )}
          </button>
          <p className="auth-switch">
            {register ? "Already have an account?" : "New here?"}{" "}
            <button
              type="button"
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Sign in" : "Join Still"}
            </button>
          </p>
          <div className="security-note">
            <CircleHelp size={18} />
            <span>
              This build stores messages on the server and caches them in your
              browser. It does not provide end-to-end encryption.
            </span>
          </div>
        </form>
      </section>
    </main>
  );
}

function NewChat({ user, onClose, onCreated }) {
  const [kind, setKind] = useState("direct");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  useEffect(() => {
    let valid = true;
    const timer = setTimeout(async () => {
      if (!/^[a-z0-9_]{2,24}$/.test(query)) {
        setResults([]);
        return;
      }
      try {
        const data = await api(`/users?q=${encodeURIComponent(query)}`);
        if (valid) setResults(data.users);
      } catch (error) {
        if (valid) setError(error.message);
      }
    }, 250);
    return () => {
      valid = false;
      clearTimeout(timer);
    };
  }, [query]);
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/chats", {
        method: "POST",
        body: JSON.stringify({
          kind,
          title,
          memberIds: selected.map((u) => u.id),
        }),
      });
      await onCreated(data.chatId);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="modal" onCancel={onClose}>
      <form onSubmit={create}>
        <div className="modal-header">
          <h2>A new conversation</h2>
          <IconButton type="button" label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </div>
        <p className="muted">
          Share your username <strong>@{user.username}</strong> so friends can
          find you.
        </p>
        <div className="segmented">
          <button
            type="button"
            className={kind === "direct" ? "selected" : ""}
            onClick={() => {
              setKind("direct");
              setSelected([]);
            }}
          >
            One to one
          </button>
          <button
            type="button"
            className={kind === "group" ? "selected" : ""}
            onClick={() => {
              setKind("group");
              setSelected([]);
            }}
          >
            Group
          </button>
        </div>
        {kind === "group" && (
          <label>
            Group name
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              required
              placeholder="Saturday people"
            />
          </label>
        )}
        <label>
          Find by username
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value.toLowerCase())}
            placeholder="Type at least 2 characters"
            maxLength={24}
          />
        </label>
        <div className="selected-people">
          {selected.map((person) => (
            <button
              type="button"
              key={person.id}
              onClick={() =>
                setSelected(selected.filter((u) => u.id !== person.id))
              }
            >
              {person.name}
              <X size={13} />
            </button>
          ))}
        </div>
        <div className="people-results">
          {results
            .filter((u) => !selected.some((s) => s.id === u.id))
            .map((person) => (
              <button
                type="button"
                key={person.id}
                onClick={() => {
                  setSelected(
                    kind === "direct"
                      ? [person]
                      : [...selected, person].slice(0, 19),
                  );
                  setQuery("");
                }}
              >
                <Avatar name={person.name} />
                <span>
                  <strong>{person.name}</strong>
                  <small>@{person.username}</small>
                </span>
                <Plus size={18} />
              </button>
            ))}
          {query.length >= 2 && !results.length && (
            <p className="muted">
              No matching accounts. Ask your friend to register first.
            </p>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={!selected.length || busy}>
          {busy ? "Creating…" : "Start conversation"}
          <ArrowRight size={18} />
        </button>
      </form>
    </dialog>
  );
}

function Message({ message, user, chat, state, messenger }) {
  const own = message.senderId === user.id;
  const sender = chat.members.find((m) => m.id === message.senderId);
  const recipients = (state?.members || chat.members).filter(
    (m) => m.id !== user.id,
  );
  const read = recipients.filter((m) => m.readSeq >= message.seq).length;
  const delivered = recipients.filter(
    (m) => m.deliveredSeq >= message.seq,
  ).length;
  const votes = (state?.votes || []).filter((v) => v.messageId === message.id);
  const myVote = votes.find((v) => v.userId === user.id)?.choice;
  const status =
    message.status === "failed"
      ? "Not sent"
      : message.status === "queued"
        ? "Queued"
        : message.status === "sending"
          ? "Sending"
          : read === recipients.length && read
            ? "Read"
            : read
              ? `Read ${read}/${recipients.length}`
              : delivered
                ? `Delivered${recipients.length > 1 ? ` ${delivered}/${recipients.length}` : ""}`
                : "Sent";
  return (
    <article
      className={`message-row ${own ? "own" : ""} ${message.kind === "decision" ? "decision-row" : ""}`}
    >
      {!own && <Avatar name={sender?.name || "?"} small />}
      <div className="message-stack">
        {!own && chat.kind === "group" && (
          <span className="sender-name">{sender?.name}</span>
        )}
        <div
          className={`bubble ${message.kind === "decision" ? "decision-card" : ""}`}
        >
          {message.kind === "decision" && (
            <div className="decision-label">
              <ListChecks size={15} />
              LET’S DECIDE
            </div>
          )}
          {message.body && <p>{message.body}</p>}
          {message.attachment?.mime?.startsWith("audio/") && <audio className="voice-player" controls preload="none" src={`/api/files/${message.attachment.id}?play=1`} aria-label="Voice note" />}
          {message.attachment && (
            <a
              className="file-card"
              href={`/api/files/${message.attachment.id}`}
              download
            >
              <FileText size={25} />
              <span>
                <strong>{message.attachment.filename}</strong>
                <small>
                  {Math.max(1, Math.round(message.attachment.size / 1024))} KB ·
                  Download file
                </small>
              </span>
              <Download size={17} />
            </a>
          )}
          {message.kind === "decision" && (
            <div className="decision-actions">
              <button
                disabled={Boolean(message.status) || !messenger.connected}
                className={myVote === "agree" ? "voted" : ""}
                onClick={() =>
                  messenger
                    .vote(message.id, "agree")
                    .catch((e) => messenger.setError(e.message))
                }
              >
                <Check size={15} />
                Agree{" "}
                <span>{votes.filter((v) => v.choice === "agree").length}</span>
              </button>
              <button
                disabled={Boolean(message.status) || !messenger.connected}
                className={myVote === "discuss" ? "voted" : ""}
                onClick={() =>
                  messenger
                    .vote(message.id, "discuss")
                    .catch((e) => messenger.setError(e.message))
                }
              >
                Discuss{" "}
                <span>
                  {votes.filter((v) => v.choice === "discuss").length}
                </span>
              </button>
            </div>
          )}
        </div>
        <div className="message-meta">
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {time(message.createdAt)}
          </time>
          {own && (
            <span className={read ? "read-status" : ""}>
              {status}
              {!message.status &&
                (delivered || read ? (
                  <CheckCheck size={13} />
                ) : (
                  <Check size={13} />
                ))}
            </span>
          )}
          {message.status === "failed" && (
            <button
              onClick={() =>
                messenger
                  .retry(message.clientId)
                  .catch((e) => messenger.setError(e.message))
              }
              title={message.error}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Conversation({
  user,
  chat,
  messenger,
  onBack,
  showDetails,
  setShowDetails,
}) {
  const [draft, setDraft] = useState("");
  const [decision, setDecision] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState("conversation");
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef(null);
  const bottom = useRef(null);
  const file = useRef(null);
  const textarea = useRef(null);
  const persisted = messenger.messages[chat.id] || [];
  const pending = messenger.outbox.filter(
    (m) =>
      m.chatId === chat.id && !persisted.some((p) => p.clientId === m.clientId),
  );
  const all = [...persisted, ...pending];
  const shown = all.filter(
    (m) =>
      tab === "conversation" ||
      (tab === "decisions" ? m.kind === "decision" : m.kind === "file"),
  );
  const title = chatTitle(chat, user);
  const state = messenger.states[chat.id];
  const mode = MODES[chat.mode];
  const ModeIcon = mode.icon;
  const typers = Object.values(messenger.typing)
    .filter((t) => t.chatId === chat.id && t.until > Date.now())
    .map((t) => chat.members.find((m) => m.id === t.userId)?.name)
    .filter(Boolean);
  useEffect(() => {
    if (atBottom)
      bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [all.length, atBottom, tab]);
  useEffect(() => {
    const mark = () => {
      if (atBottom && tab === "conversation") void messenger.markRead(chat.id);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    window.addEventListener("focus", mark);
    return () => {
      document.removeEventListener("visibilitychange", mark);
      window.removeEventListener("focus", mark);
    };
  }, [
    chat.id,
    persisted.length,
    atBottom,
    tab,
    messenger.connected,
    messenger.markRead,
  ]);
  async function send(event) {
    event?.preventDefault();
    if (!draft.trim()) return;
    try {
      await messenger.send(draft, decision ? "decision" : "text");
      setDraft("");
      setDecision(false);
      setTab("conversation");
      setAtBottom(true);
      messenger.indicateTyping(false);
      textarea.current?.focus();
    } catch (error) {
      messenger.setError(error.message);
    }
  }
  async function upload(event) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    if (selected.size > 10 * 1024 * 1024) {
      messenger.setError("Choose a file smaller than 10 MB.");
      return;
    }
    try { await uploadFile(selected); } catch (error) { messenger.setError(error.message); }
  }
  async function uploadFile(selected) {
    setUploading(true);
    try {
      const data = new FormData();
      data.append("file", selected);
      const result = await api(`/chats/${chat.id}/files`, {
        method: "POST",
        body: data,
      });
      await messenger.send("", "file", result.attachment);
      setAtBottom(true);
      setTab("conversation");
    } finally {
      setUploading(false);
    }
  }
  return (
    <section className="conversation">
      <header className="conversation-header">
        <IconButton label="Back to inbox" onClick={onBack}>
          <ArrowLeft size={20} />
        </IconButton>
        <Avatar name={title} group={chat.kind === "group"} />
        <div className="conversation-identity">
          <h2>{title}</h2>
          <span>
            {chat.kind === "group" ? `${chat.members.length} people · ` : ""}
            {mode.label} space
          </span>
        </div>
        {chat.kind === "direct" && (
          <div className="header-call-actions">
            <IconButton
              label="Start audio call"
              disabled={!messenger.connected || Boolean(messenger.calls.call)}
              onClick={() => messenger.calls.start(chat, user, "audio")}
            >
              <Phone size={19} />
            </IconButton>
            <IconButton
              label="Start video call"
              disabled={!messenger.connected || Boolean(messenger.calls.call)}
              onClick={() => messenger.calls.start(chat, user, "video")}
            >
              <Video size={20} />
            </IconButton>
          </div>
        )}
        <button
          className="details-toggle"
          aria-expanded={showDetails}
          onClick={() => setShowDetails(!showDetails)}
        >
          <Users size={17} />
          <span>Details</span>
        </button>
      </header>
      <div
        className="conversation-tabs"
        role="tablist"
        aria-label="Conversation views"
      >
        {["conversation", "decisions", "files"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => {
              setTab(value);
              setAtBottom(true);
            }}
          >
            {value === "conversation"
              ? "Conversation"
              : value === "decisions"
                ? "Decisions"
                : "Shared files"}
            {value === "decisions" && (
              <span>{all.filter((m) => m.kind === "decision").length}</span>
            )}
          </button>
        ))}
        <span className="mode-pill">
          <ModeIcon size={13} />
          {mode.label}
        </span>
      </div>
      {chat.mode !== "social" && (
        <div className="mode-banner">
          <ModeIcon size={16} />
          {chat.mode === "focus"
            ? "A quieter space. Typing activity and unread counts are tucked away."
            : "Make the next step clear. Turn a message into a shared decision."}
        </div>
      )}
      <div
        className="message-scroller"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        <div className="conversation-intro">
          <span className="intro-icon">
            <MessageCircle size={22} />
          </span>
          <h3>Your space with {title}</h3>
          <p>A good conversation starts with a little hello.</p>
        </div>
        {shown.map((message, index) => (
          <React.Fragment key={message.id}>
            {(index === 0 ||
              new Date(shown[index - 1].createdAt).toDateString() !==
                new Date(message.createdAt).toDateString()) && (
              <div className="date-divider">
                <span>
                  {new Date(message.createdAt).toLocaleDateString([], {
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </div>
            )}
            <Message
              message={message}
              user={user}
              chat={chat}
              state={state}
              messenger={messenger}
            />
          </React.Fragment>
        ))}
        {!shown.length && tab !== "conversation" && (
          <p className="empty-inline">
            {tab === "decisions"
              ? "Shared decisions will live here."
              : "Files shared in this conversation will appear here."}
          </p>
        )}
        <div ref={bottom} className="scroll-anchor" />
      </div>
      {!atBottom && (
        <button className="jump-bottom" onClick={() => setAtBottom(true)}>
          <ArrowDown size={15} />
          Latest messages
        </button>
      )}
      <div className="composer-wrap">
        <VoiceRecorder key={chat.id} disabled={uploading || !messenger.connected || Boolean(messenger.calls.call)} onSend={uploadFile} onError={messenger.setError} />
        <div className="typing-line" aria-live="polite">
          {chat.mode !== "focus" && typers.length
            ? `${typers.join(", ")} ${typers.length === 1 ? "is" : "are"} typing…`
            : !messenger.connected
              ? "Offline — messages will send when connected."
              : uploading
                ? "Uploading your file…"
                : ""}
        </div>
        {decision && (
          <div className="compose-mode">
            <ListChecks size={14} />
            New decision · ask something your group can agree on
            <IconButton
              label="Cancel decision mode"
              onClick={() => setDecision(false)}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
        <form
          className={`composer ${decision ? "decision-composer" : ""}`}
          onSubmit={send}
        >
          <input ref={file} type="file" hidden onChange={upload} />
          <IconButton
            type="button"
            label="Attach a file, up to 10 MB"
            disabled={uploading || !messenger.connected}
            onClick={() => file.current.click()}
          >
            <Paperclip size={20} />
          </IconButton>
          <textarea
            ref={textarea}
            aria-label={decision ? "Write a decision" : "Write a message"}
            placeholder={
              decision
                ? "What should we decide?"
                : "A thought, a plan, a little hello…"
            }
            value={draft}
            rows={1}
            maxLength={4000}
            onChange={(e) => {
              setDraft(e.target.value);
              messenger.indicateTyping(Boolean(e.target.value));
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <IconButton
            type="button"
            label="Create a decision card"
            aria-pressed={decision}
            onClick={() => {
              setDecision(!decision);
              textarea.current.focus();
            }}
          >
            <ListChecks size={20} />
          </IconButton>
          <button
            className="send-button"
            aria-label="Send message"
            disabled={!draft.trim() || !messenger.ready}
          >
            <Send size={18} />
          </button>
        </form>
        <div className="composer-hint">
          <span>Enter to send · Shift + Enter for a new line</span>
          <span>
            {draft.length > 3500
              ? `${draft.length}/4000`
              : "A little more intention."}
          </span>
        </div>
      </div>
    </section>
  );
}

function Messenger({ user, onLogout }) {
  const [activeId, setActiveId] = useState(null);
  const [newChat, setNewChat] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [section, setSection] = useState("inbox");
  const [showDetails, setShowDetails] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const messenger = useMessenger(user, activeId);
  const calls = useCalls(messenger.socketRef, messenger.ready);
  messenger.calls = calls;
  const chat = messenger.chats.find((c) => c.id === activeId);
  const list = messenger.chats.filter(
    (c) =>
      (section !== "groups" || c.kind === "group") &&
      (filter !== "unread" || c.unread > 0) &&
      chatTitle(c, user).toLowerCase().includes(search.toLowerCase()),
  );
  async function logout() {
    if (
      messenger.outbox.length &&
      !window.confirm("Sign out and discard unsent messages on this browser?")
    )
      return;
    setLoggingOut(true);
    try {
      await api("/auth/logout", { method: "POST" });
      await messenger.stop();
      await clearLocalUser(user.id);
      onLogout();
    } catch (error) {
      messenger.setError(error.message);
    } finally {
      setLoggingOut(false);
    }
  }
  async function setMode(mode) {
    try {
      await api(`/chats/${chat.id}/mode`, {
        method: "PATCH",
        body: JSON.stringify({ mode }),
      });
      await messenger.refreshChats();
    } catch (error) {
      messenger.setError(error.message);
    }
  }
  return (
    <div className={`app-shell ${chat ? "has-chat" : ""}`}>
      <nav className="rail" aria-label="Main navigation">
        <a className="rail-logo" href="/" aria-label="Still home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
        </a>
        <button
          className={section === "inbox" ? "active" : ""}
          aria-label="Inbox"
          title="Inbox"
          onClick={() => {
            setSection("inbox");
            setActiveId(null);
          }}
        >
          <MessageCircle size={22} />
        </button>
        <button
          className={section === "groups" ? "active" : ""}
          aria-label="Groups"
          title="Groups"
          onClick={() => {
            setSection("groups");
            setActiveId(null);
          }}
        >
          <Users size={22} />
        </button>
        <div className="rail-bottom">
          <span
            className={`connection-dot ${messenger.connected ? "online" : ""}`}
            title={messenger.connected ? "Connected" : "Offline"}
            aria-label={messenger.connected ? "Connected" : "Offline"}
          />
          <Avatar name={user.name} small />
          <IconButton
            label="Sign out and clear local history"
            disabled={loggingOut}
            onClick={logout}
          >
            <LogOut size={19} />
          </IconButton>
        </div>
      </nav>
      <aside className="inbox">
        <header className="inbox-header">
          <Brand />
          <button
            className="compose-button"
            aria-label="New conversation"
            onClick={() => setNewChat(true)}
          >
            <Plus size={21} />
          </button>
        </header>
        <div className="inbox-title">
          <h1>{section === "groups" ? "Your groups" : "Your inbox"}</h1>
          <span>{messenger.chats.length} spaces</span>
        </div>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search conversations"
            placeholder="Find a conversation"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <div className="inbox-filters">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            All conversations
          </button>
          <button
            className={filter === "unread" ? "active" : ""}
            onClick={() => setFilter("unread")}
          >
            Unread
          </button>
        </div>
        <div className="chat-list">
          {list.map((c) => {
            const title = chatTitle(c, user);
            return (
              <button
                key={c.id}
                className={`chat-item ${c.id === activeId ? "selected" : ""}`}
                onClick={() => {
                  setActiveId(c.id);
                  setShowDetails(false);
                }}
              >
                <Avatar name={title} group={c.kind === "group"} />
                <div className="chat-item-copy">
                  <div>
                    <strong>{title}</strong>
                    <time>
                      {c.lastMessage ? time(c.lastMessage.createdAt) : "New"}
                    </time>
                  </div>
                  <p>
                    {c.lastMessage?.kind === "decision" ? "Decision: " : ""}
                    {c.lastMessage?.body ||
                      c.lastMessage?.attachment?.filename ||
                      "Say a little hello"}
                  </p>
                  <span className="chat-mode">
                    {c.mode === "focus" ? (
                      <Moon size={11} />
                    ) : c.mode === "coordinate" ? (
                      <ListChecks size={11} />
                    ) : (
                      <Circle size={7} />
                    )}{" "}
                    {MODES[c.mode].label}
                  </span>
                </div>
                {c.unread > 0 && c.mode !== "focus" && (
                  <span className="unread-badge">{c.unread}</span>
                )}
              </button>
            );
          })}
          {!list.length && (
            <div className="list-empty">
              <MessageCircle size={27} />
              <h3>
                {search || filter === "unread"
                  ? "All clear here."
                  : "Your people belong here."}
              </h3>
              <p>
                {search
                  ? "Try another name."
                  : filter === "unread"
                    ? "No unread conversations."
                    : "Start a conversation by finding a friend’s username."}
              </p>
              {!search && filter === "all" && (
                <button
                  className="text-button"
                  onClick={() => setNewChat(true)}
                >
                  Find someone <ArrowRight size={14} />
                </button>
              )}
            </div>
          )}
        </div>
        <footer className="inbox-footer">
          <span className="tiny-orbit">
            <MessageCircle size={15} />
          </span>
          <div>
            <strong>Less noise. More meaning.</strong>
            <span>Make a little room for connection.</span>
          </div>
        </footer>
      </aside>
      <main className="main-panel">
        {messenger.error && (
          <div className="error-banner" role="alert">
            <span>{messenger.error}</span>
            <IconButton
              label="Dismiss error"
              onClick={() => messenger.setError("")}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {!messenger.connected && messenger.ready && (
          <div className="offline-banner">
            <WifiOff size={14} />
            Reconnecting. Your queued messages stay on this device.
          </div>
        )}
        {chat ? (
          <Conversation
            key={chat.id}
            user={user}
            chat={chat}
            messenger={messenger}
            onBack={() => setActiveId(null)}
            showDetails={showDetails}
            setShowDetails={setShowDetails}
          />
        ) : (
          <div className="welcome">
            <span className="eyebrow">ROOM TO CONNECT</span>
            <div className="welcome-art">
              <span />
              <span />
              <MessageCircle size={52} />
            </div>
            <h2>
              A little less noise.
              <br />
              <em>A little more us.</em>
            </h2>
            <p>
              Hi {user.name.split(" ")[0]}. Choose a conversation,
              <br />
              or make space for a new one.
            </p>
            <button className="primary" onClick={() => setNewChat(true)}>
              <Plus size={18} />
              Start a conversation
            </button>
            <div className="welcome-features">
              <span>
                <Moon size={15} />
                Find your focus
              </span>
              <span>
                <ListChecks size={15} />
                Decide together
              </span>
            </div>
            <p className="privacy-foot">
              Single-server build · no end-to-end encryption
            </p>
          </div>
        )}
      </main>
      {chat && showDetails && (
        <aside className="details-panel">
          <header>
            <span>YOUR SPACE</span>
            <IconButton
              label="Close details"
              onClick={() => setShowDetails(false)}
            >
              <X size={18} />
            </IconButton>
          </header>
          <Avatar name={chatTitle(chat, user)} group={chat.kind === "group"} />
          <h2>{chatTitle(chat, user)}</h2>
          <p className="muted">
            {chat.members.length} people, one conversation.
          </p>
          <h3>Set the pace</h3>
          <p className="muted small-copy">
            A personal setting. Other people keep their own mode.
          </p>
          <div className="mode-options">
            {Object.entries(MODES).map(([key, mode]) => {
              const Icon = mode.icon;
              return (
                <button
                  key={key}
                  className={chat.mode === key ? "selected" : ""}
                  onClick={() => setMode(key)}
                >
                  <Icon size={19} />
                  <span>
                    <strong>{mode.label}</strong>
                    <small>{mode.detail}</small>
                  </span>
                  {chat.mode === key && <Check size={16} />}
                </button>
              );
            })}
          </div>
          <h3>People</h3>
          <div className="members-list">
            {chat.members.map((m) => (
              <div key={m.id}>
                <Avatar name={m.name} small />
                <span>
                  <strong>
                    {m.name}
                    {m.id === user.id ? " (you)" : ""}
                  </strong>
                  <small>@{m.username}</small>
                </span>
                {m.id === chat.ownerId && chat.kind === "group" && (
                  <Hash size={13} />
                )}
              </div>
            ))}
          </div>
          <div className="security-note">
            <CircleHelp size={16} />
            <span>
              Messages are stored on this server. Only chat members can access
              them through the app. This is not end-to-end encryption.
            </span>
          </div>
        </aside>
      )}
      <CallPanel calls={calls} />
      {newChat && (
        <NewChat
          user={user}
          onClose={() => setNewChat(false)}
          onCreated={async (id) => {
            await messenger.refreshChats();
            setActiveId(id);
            setNewChat(false);
          }}
        />
      )}
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    api("/auth/me")
      .then((data) => setUser(data.user))
      .catch((error) => {
        if (error.status !== 401) setFailure(error.message);
      })
      .finally(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <LoaderCircle className="spin" />
      </div>
    );
  if (failure)
    return (
      <div className="boot">
        <Brand />
        <p role="alert">{failure}</p>
        <button className="primary" onClick={() => location.reload()}>
          Retry connection
        </button>
      </div>
    );
  return user ? (
    <Messenger key={user.id} user={user} onLogout={() => setUser(null)} />
  ) : (
    <Auth onLogin={setUser} />
  );
}

createRoot(document.getElementById("root")).render(<App />);
