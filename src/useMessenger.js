import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, emit } from "./api";
import { readLocal, writeLocal } from "./storage";

export function useMessenger(user, activeId) {
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState({});
  const [states, setStates] = useState({});
  const [outbox, setOutbox] = useState([]);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState({});
  const socket = useRef(null);
  const cache = useRef({});
  const queue = useRef([]);
  const queueWrites = useRef(Promise.resolve());
  const locks = useRef(new Map());
  const flushLock = useRef(false);
  const loaded = useRef(false);
  const stateRef = useRef({});
  const lastTyped = useRef(0);
  const alive = useRef(true);
  const active = useRef(activeId);
  active.current = activeId;
  const report = useCallback((error) => {
    if (alive.current) setError(error.message || String(error));
  }, []);

  const saveQueue = useCallback(
    async (value) => {
      if (!alive.current) return;
      queue.current = value;
      setOutbox([...value]);
      const snapshot = structuredClone(value);
      queueWrites.current = queueWrites.current
        .catch(() => {})
        .then(() =>
          alive.current ? writeLocal(`${user.id}:outbox`, snapshot) : undefined,
        );
      await queueWrites.current;
    },
    [user.id],
  );

  const refreshChats = useCallback(async () => {
    const data = await api("/chats");
    if (!alive.current) return [];
    setChats(data.chats);
    await writeLocal(`${user.id}:chats`, data.chats);
    return data.chats;
  }, [user.id]);

  const syncChat = useCallback(
    (chatId) => {
      const current = locks.current.get(chatId);
      if (current) {
        current.again = true;
        return current.promise;
      }
      const lock = { again: false, promise: null };
      lock.promise = (async () => {
        do {
          lock.again = false;
          if (!cache.current[chatId])
            cache.current[chatId] =
              (await readLocal(`${user.id}:chat:${chatId}`)) || [];
          let list = cache.current[chatId];
          if (alive.current)
            setMessages((previous) => ({ ...previous, [chatId]: list }));
          let more = true;
          while (more && alive.current) {
            const after = list.at(-1)?.seq || 0;
            const data = await api(`/chats/${chatId}/messages?after=${after}`);
            const deleted = new Set(data.deleted || []);
            list = [...list, ...data.messages].map(m => deleted.has(m.id) ? {...m, body:"Message deleted", kind:"text", attachment:null, deletedAt: m.deletedAt || Date.now()} : m);
            more = data.hasMore;
          }
          if (!alive.current) return;
          await writeLocal(`${user.id}:chat:${chatId}`, list);
          cache.current[chatId] = list;
          if (!alive.current) return;
          setMessages((previous) => ({ ...previous, [chatId]: list }));
          const state = await api(`/chats/${chatId}/state`);
          stateRef.current[chatId] = state;
          setStates((previous) => ({ ...previous, [chatId]: state }));
          const me = state.members.find((m) => m.id === user.id);
          const seq = list.at(-1)?.seq || 0;
          if (socket.current?.connected && seq > (me?.deliveredSeq || 0)) {
            await emit(socket.current, "message:receipt", {
              chatId,
              seq,
              type: "delivered",
            });
          }
        } while (lock.again && alive.current);
      })().finally(() => locks.current.delete(chatId));
      locks.current.set(chatId, lock);
      return lock.promise;
    },
    [user.id],
  );

  const flush = useCallback(async () => {
    if (flushLock.current || !loaded.current || !socket.current?.connected)
      return;
    flushLock.current = true;
    try {
      for (const item of [...queue.current]) {
        if (!alive.current || !socket.current?.connected) break;
        if (
          item.status === "failed" ||
          !queue.current.some((m) => m.clientId === item.clientId)
        )
          continue;
        try {
          await saveQueue(
            queue.current.map((m) =>
              m.clientId === item.clientId ? { ...m, status: "sending" } : m,
            ),
          );
          await emit(socket.current, "message:send", {
            chatId: item.chatId,
            clientId: item.clientId,
            kind: item.kind,
            body: item.body,
            ...(item.attachment ? { attachmentId: item.attachment.id } : {}),
          });
          await syncChat(item.chatId);
          await saveQueue(
            queue.current.filter((m) => m.clientId !== item.clientId),
          );
        } catch (error) {
          const permanent = [400, 403, 404, 409].includes(error.status);
          await saveQueue(
            queue.current.map((m) =>
              m.clientId === item.clientId
                ? {
                    ...m,
                    status: permanent ? "failed" : "queued",
                    error: error.message,
                  }
                : m,
            ),
          );
          if (!permanent) break;
        }
      }
    } catch (error) {
      report(error);
    } finally {
      flushLock.current = false;
    }
  }, [saveQueue, syncChat, report]);

  useEffect(() => {
    alive.current = true;
    let reconnectTimer;
    const realtimeOrigin = import.meta.env.VITE_REALTIME_ORIGIN || undefined;
    const connection = io(realtimeOrigin, {
      auth: callback => {
        api('/auth/socket-ticket', { method: 'POST' })
          .then(({ ticket }) => { if (alive.current) callback({ ticket }); })
          .catch(error => {
            if (error.status === 401) report(error);
            if (alive.current) callback({ ticket: '' });
          });
      },
      autoConnect: false,
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
    });
    socket.current = connection;
    let refreshing = false;
    async function reconcile() {
      if (refreshing || !connection.connected) return;
      refreshing = true;
      try {
        const list = await refreshChats();
        for (const chat of list) {
          if (!alive.current) break;
          await syncChat(chat.id);
        }
        await flush();
      } catch (error) {
        report(error);
      } finally {
        refreshing = false;
      }
    }
    connection.on("connect", () => {
      clearTimeout(reconnectTimer);
      setConnected(true);
      setError("");
      if (active.current)
        emit(connection, "chat:join", { chatId: active.current }).catch(report);
      void reconcile();
    });
    connection.on("disconnect", (reason) => {
      setConnected(false);
      if (reason === "io server disconnect")
        setError("Your session ended. Sign out and sign in again.");
    });
    connection.on("connect_error", () => {
      // Rejected/expired single-use tickets need a fresh handshake, not replay.
      if (!connection.active && alive.current) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connection.connect(), 8000);
      }
    });
    connection.on("chat:changed", () => {
      void reconcile();
    });
    connection.on("message:deleted", ({ chatId }) => { syncChat(chatId).then(refreshChats).catch(report); });
    connection.on("message:new", ({ message }) => {
      syncChat(message.chatId).then(refreshChats).catch(report);
    });
    connection.on("receipt:changed", ({ chatId, members }) => {
      stateRef.current[chatId] = { ...stateRef.current[chatId], members };
      setStates((previous) => ({
        ...previous,
        [chatId]: { ...previous[chatId], members },
      }));
      setChats((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                members,
                unread: (cache.current[chatId] || []).filter(
                  (m) =>
                    m.senderId !== user.id &&
                    m.seq >
                      (members.find((x) => x.id === user.id)?.readSeq || 0),
                ).length,
              }
            : chat,
        ),
      );
    });
    connection.on("decision:changed", (vote) => {
      setStates((previous) => {
        const state = previous[vote.chatId] || {};
        return {
          ...previous,
          [vote.chatId]: {
            ...state,
            votes: [
              ...(state.votes || []).filter(
                (v) =>
                  !(v.messageId === vote.messageId && v.userId === vote.userId),
              ),
              vote,
            ],
          },
        };
      });
    });
    connection.on("typing", (value) =>
      setTyping((previous) => ({
        ...previous,
        [`${value.chatId}:${value.userId}`]: {
          ...value,
          until: value.active ? Date.now() + 4000 : 0,
        },
      })),
    );
    (async () => {
      try {
        const saved = (await readLocal(`${user.id}:outbox`)) || [];
        await saveQueue(
          saved.map((item) => ({
            ...item,
            status: item.status === "failed" ? "failed" : "queued",
          })),
        );
        const cachedChats = await readLocal(`${user.id}:chats`);
        if (!alive.current) return;
        if (cachedChats) setChats(cachedChats);
        loaded.current = true;
        setReady(true);
        connection.connect();
      } catch (error) {
        report(new Error(`Local storage is unavailable: ${error.message}`));
      }
    })();
    const timer = setInterval(() => {
      void flush();
    }, 3000);
    const syncTimer = setInterval(() => {
      void reconcile();
    }, 20_000);
    const typingTimer = setInterval(
      () =>
        setTyping((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(
              ([, value]) => value.until > Date.now(),
            ),
          ),
        ),
      2000,
    );
    window.addEventListener("online", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      alive.current = false;
      clearTimeout(reconnectTimer);
      connection.removeAllListeners();
      connection.disconnect();
      clearInterval(timer);
      clearInterval(syncTimer);
      clearInterval(typingTimer);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [user.id, refreshChats, syncChat, saveQueue, flush, report]);

  useEffect(() => {
    if (!activeId || !ready) return;
    if (socket.current?.connected)
      emit(socket.current, "chat:join", { chatId: activeId }).catch(report);
    syncChat(activeId).catch(report);
  }, [activeId, ready, syncChat, report]);

  async function send(body, kind = "text", attachment) {
    if (!activeId || !loaded.current)
      throw new Error("Please wait for local storage to initialize.");
    const item = {
      id: crypto.randomUUID(),
      clientId: crypto.randomUUID(),
      chatId: activeId,
      senderId: user.id,
      kind,
      body: body.trim(),
      attachment,
      createdAt: Date.now(),
      status: "queued",
    };
    await saveQueue([...queue.current, item]);
    void flush();
  }
  async function retry(clientId) {
    await saveQueue(
      queue.current.map((m) =>
        m.clientId === clientId ? { ...m, status: "queued", error: null } : m,
      ),
    );
    void flush();
  }
  const readLocks = useRef(new Set());
  const markRead = useCallback(
    async (chatId) => {
      if (
        document.visibilityState !== "visible" ||
        !socket.current?.connected ||
        readLocks.current.has(chatId)
      )
        return;
      const seq = cache.current[chatId]?.at(-1)?.seq || 0;
      const prior =
        stateRef.current[chatId]?.members?.find((m) => m.id === user.id)
          ?.readSeq || 0;
      if (seq <= prior) return;
      readLocks.current.add(chatId);
      try {
        await emit(socket.current, "message:receipt", {
          chatId,
          seq,
          type: "read",
        });
      } catch (error) {
        report(error);
      } finally {
        readLocks.current.delete(chatId);
      }
    },
    [user.id, report],
  );
  function indicateTyping(value) {
    if (
      !socket.current?.connected ||
      (value && Date.now() - lastTyped.current < 1800)
    )
      return;
    lastTyped.current = Date.now();
    emit(socket.current, "typing", { chatId: activeId, active: value }).catch(
      () => {},
    );
  }
  return {
    socketRef: socket,
    chats,
    messages,
    states,
    outbox,
    connected,
    ready,
    error,
    setError,
    typing,
    send,
    retry,
    markRead,
    indicateTyping,
    refreshChats,
    stop: async () => {
      alive.current = false;
      loaded.current = false;
      socket.current?.disconnect();
      await Promise.allSettled([
        queueWrites.current,
        ...[...locks.current.values()].map((lock) => lock.promise),
      ]);
    },
    deleteMessage: async (message) => {
      await api(`/messages/${message.id}`, {method:"DELETE"});
      await syncChat(message.chatId);
      await refreshChats();
    },
    vote: (messageId, choice) =>
      emit(socket.current, "decision:vote", { messageId, choice }),
  };
}
