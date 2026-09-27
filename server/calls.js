import { z } from "zod";

const uuid = z.string().uuid();
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export function createCalls(io, db) {
  const calls = new Map();
  const busy = new Map();
  function finish(call, reason) {
    clearTimeout(call.timer);
    calls.delete(call.id);
    busy.delete(call.callerId);
    busy.delete(call.calleeId);
    io.to(`user:${call.callerId}`)
      .to(`user:${call.calleeId}`)
      .emit("call:ended", { callId: call.id, reason });
  }
  function bind(socket, event) {
    const userId = socket.data.userId;
    function lookup(callId) {
      const call = calls.get(uuid.parse(callId));
      if (!call || ![call.callerId, call.calleeId].includes(userId))
        fail(404, "Call is no longer available.");
      return call;
    }
    event("call:start", (payload) => {
      const input = z
        .object({
          callId: uuid,
          chatId: uuid,
          kind: z.enum(["audio", "video"]),
        })
        .parse(payload);
      const chat = db
        .prepare(
          "SELECT c.id FROM chats c JOIN members m ON m.chat_id=c.id WHERE c.id=? AND c.kind='direct' AND m.user_id=?",
        )
        .get(input.chatId, userId);
      if (!chat)
        fail(403, "Calls are available in your one-to-one conversations.");
      const target = db
        .prepare(
          "SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id<>?",
        )
        .get(input.chatId, userId);
      if (busy.has(userId) || busy.has(target.id))
        fail(409, "You or the other person are already in a call.");
      if (calls.has(input.callId)) fail(409, "Call ID already exists.");
      if (!io.sockets.adapter.rooms.get(`user:${target.id}`)?.size)
        fail(
          409,
          "The other person is offline. Try again when they are connected.",
        );
      const caller = db
        .prepare("SELECT name FROM users WHERE id=?")
        .get(userId);
      const call = {
        id: input.callId,
        chatId: input.chatId,
        kind: input.kind,
        callerId: userId,
        calleeId: target.id,
        callerSocket: socket.id,
        calleeSocket: null,
        status: "ringing",
      };
      calls.set(call.id, call);
      busy.set(userId, call.id);
      busy.set(target.id, call.id);
      call.timer = setTimeout(() => finish(call, "No answer"), 45_000);
      call.timer.unref();
      io.to(`user:${target.id}`).emit("call:incoming", {
        callId: call.id,
        chatId: call.chatId,
        kind: call.kind,
        name: caller.name,
      });
      return { callId: call.id };
    });
    event("call:accept", (payload) => {
      const call = lookup(payload.callId);
      if (call.calleeId !== userId || call.status !== "ringing")
        fail(409, "This call was already answered or ended.");
      call.calleeSocket = socket.id;
      call.status = "active";
      clearTimeout(call.timer);
      call.timer = setTimeout(
        () => finish(call, "Call duration limit reached"),
        4 * 60 * 60_000,
      );
      call.timer.unref();
      socket.to(`user:${userId}`).emit("call:dismiss", { callId: call.id });
      io.to(call.callerSocket).emit("call:accepted", { callId: call.id });
      return {};
    });
    event("call:signal", (payload) => {
      const input = z
        .object({
          callId: uuid,
          description: z
            .object({
              type: z.enum(["offer", "answer"]),
              sdp: z.string().max(24000),
            })
            .optional(),
          candidate: z
            .object({
              candidate: z.string().max(4000),
              sdpMid: z.string().nullable().optional(),
              sdpMLineIndex: z.number().int().nullable().optional(),
              usernameFragment: z.string().nullable().optional(),
            })
            .optional(),
        })
        .parse(payload);
      const call = lookup(input.callId);
      if (
        call.status !== "active" ||
        ![call.callerSocket, call.calleeSocket].includes(socket.id)
      )
        fail(403, "This device is not participating in the call.");
      if (Boolean(input.description) === Boolean(input.candidate))
        fail(400, "Send one signaling item.");
      if (
        input.description &&
        input.description.type !==
          (socket.id === call.callerSocket ? "offer" : "answer")
      )
        fail(400, "Unexpected call negotiation.");
      io.to(
        socket.id === call.callerSocket ? call.calleeSocket : call.callerSocket,
      ).emit("call:signal", input);
      return {};
    });
    event("call:end", (payload) => {
      const call = lookup(payload.callId);
      if (
        socket.id !== call.callerSocket &&
        !(call.calleeId === userId && call.status === "ringing") &&
        socket.id !== call.calleeSocket
      )
        fail(403, "This device is not participating in the call.");
      finish(
        call,
        call.status === "ringing"
          ? userId === call.calleeId
            ? "Call declined"
            : "Call cancelled"
          : "Call ended",
      );
      return {};
    });
    socket.on("disconnect", () => {
      const call = calls.get(busy.get(userId));
      if (
        call &&
        (socket.id === call.callerSocket ||
          socket.id === call.calleeSocket ||
          (call.calleeId === userId &&
            !io.sockets.adapter.rooms.get(`user:${userId}`)?.size))
      )
        finish(call, "Connection lost");
    });
  }
  return {
    bind,
    close: () => {
      for (const call of [...calls.values()]) finish(call, "Server restarting");
    },
  };
}
