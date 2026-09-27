import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { createApplication } from "../server/app.js";

test("call signaling and lifecycle", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "still-calls-"));
  const service = createApplication({
    database: join(dir, "db.sqlite"),
    uploadDir: join(dir, "files"),
    secure: false,
  });
  await new Promise((r) => service.http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${service.http.address().port}`;
  const clients = [];
  const request = async (path, cookie, body) => {
    const response = await fetch(url + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: "http://localhost:5173",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const register = async (name) => {
    const r = await request("/auth/register", null, {
      username: name,
      name,
      password: "test-calling-password",
    });
    return { ...r.data.user, cookie: r.cookie };
  };
  const socket = async (user) => {
    const s = io(url, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { Origin: "http://localhost:5173", Cookie: user.cookie },
    });
    clients.push(s);
    await new Promise((resolve, reject) => {
      s.once("connect", resolve);
      s.once("connect_error", reject);
    });
    return s;
  };
  const emit = (s, event, payload) =>
    new Promise((resolve, reject) =>
      s
        .timeout(2000)
        .emit(event, payload, (err, value) =>
          err ? reject(err) : resolve(value),
        ),
    );
  const next = (s, event) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.off(event, done);
        reject(new Error("Missing " + event));
      }, 2000);
      function done(value) {
        clearTimeout(timer);
        resolve(value);
      }
      s.once(event, done);
    });
  try {
    const alice = await register("call_alice"),
      bob = await register("call_bob"),
      eve = await register("call_eve");
    const a = await socket(alice),
      b = await socket(bob),
      b2 = await socket(bob),
      e = await socket(eve);
    const chat = (
      await request("/chats", alice.cookie, {
        kind: "direct",
        memberIds: [bob.id],
      })
    ).data.chatId;
    const callId = randomUUID();
    await t.test(
      "requires authentication for media server config",
      async () => {
        assert.equal((await request("/calls/config")).status, 401);
        assert.ok(
          Array.isArray(
            (await request("/calls/config", alice.cookie)).data.iceServers,
          ),
        );
      },
    );
    await t.test("rejects calls from nonmembers", async () => {
      assert.equal(
        (
          await emit(e, "call:start", {
            chatId: chat,
            callId: randomUUID(),
            kind: "video",
          })
        ).status,
        403,
      );
    });
    await t.test(
      "rings all recipient devices and rejects simultaneous calls",
      async () => {
        const ring = next(b, "call:incoming"),
          ring2 = next(b2, "call:incoming");
        assert.equal(
          (await emit(a, "call:start", { chatId: chat, callId, kind: "video" }))
            .ok,
          true,
        );
        assert.equal((await ring).callId, callId);
        assert.equal((await ring2).name, alice.name);
        assert.equal(
          (
            await emit(b, "call:start", {
              chatId: chat,
              callId: randomUUID(),
              kind: "audio",
            })
          ).status,
          409,
        );
        assert.equal((await emit(a, "call:accept", { callId })).status, 409);
      },
    );
    await t.test("claims a single answering device", async () => {
      const accepted = next(a, "call:accepted"),
        dismissed = next(b2, "call:dismiss");
      assert.equal((await emit(b, "call:accept", { callId })).ok, true);
      assert.equal((await accepted).callId, callId);
      assert.equal((await dismissed).callId, callId);
      assert.equal((await emit(b2, "call:accept", { callId })).status, 409);
    });
    await t.test(
      "relays SDP and ICE only between selected endpoints",
      async () => {
        const offer = {
          callId,
          description: { type: "offer", sdp: "test-offer" },
        };
        const incoming = next(b, "call:signal");
        assert.equal((await emit(a, "call:signal", offer)).ok, true);
        assert.deepEqual(await incoming, offer);
        assert.equal((await emit(e, "call:signal", offer)).status, 404);
        assert.equal(
          (
            await emit(b2, "call:signal", {
              callId,
              candidate: { candidate: "test" },
            })
          ).status,
          403,
        );
        assert.equal((await emit(b, "call:signal", offer)).status, 400);
        const answer = {
          callId,
          description: { type: "answer", sdp: "test-answer" },
        };
        const answered = next(a, "call:signal");
        assert.equal((await emit(b, "call:signal", answer)).ok, true);
        assert.deepEqual(await answered, answer);
        const ice = {
          callId,
          candidate: {
            candidate: "candidate:1 1 UDP 1 127.0.0.1 10000 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        };
        const candidate = next(b, "call:signal");
        assert.equal((await emit(a, "call:signal", ice)).ok, true);
        assert.deepEqual(await candidate, ice);
        assert.equal((await emit(b2, "call:end", { callId })).status, 403);
      },
    );
    await t.test(
      "hang-up notifies both sides and releases busy state",
      async () => {
        const ended = next(a, "call:ended");
        assert.equal((await emit(b, "call:end", { callId })).ok, true);
        assert.equal((await ended).reason, "Call ended");
        assert.equal(
          (
            await emit(a, "call:signal", {
              callId,
              candidate: { candidate: "stale" },
            })
          ).status,
          404,
        );
        const id = randomUUID();
        assert.equal(
          (
            await emit(a, "call:start", {
              chatId: chat,
              callId: id,
              kind: "audio",
            })
          ).ok,
          true,
        );
        const rejected = next(a, "call:ended");
        assert.equal((await emit(b, "call:end", { callId: id })).ok, true);
        assert.equal((await rejected).reason, "Call declined");
      },
    );
    await t.test(
      "disconnect ends a call; offline recipients cannot be called",
      async () => {
        const id = randomUUID();
        assert.equal(
          (
            await emit(a, "call:start", {
              chatId: chat,
              callId: id,
              kind: "audio",
            })
          ).ok,
          true,
        );
        await emit(b, "call:accept", { callId: id });
        const ended = next(a, "call:ended");
        b.disconnect();
        assert.equal((await ended).reason, "Connection lost");
        b2.disconnect();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(
          (
            await emit(a, "call:start", {
              chatId: chat,
              callId: randomUUID(),
              kind: "audio",
            })
          ).status,
          409,
        );
      },
    );
  } finally {
    clients.forEach((s) => s.disconnect());
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
