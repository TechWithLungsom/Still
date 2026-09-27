import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { io as connect } from "socket.io-client";
import { createApplication } from "../server/app.js";

test("Still end-to-end API and real-time integration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "still-test-"));
  const origin = "http://localhost:5173";
  const options = {
    origin,
    secure: false,
    database: join(directory, "test.sqlite"),
    uploadDir: join(directory, "files"),
  };
  let service = createApplication(options);
  let base;
  const sockets = [];
  async function listen() {
    await new Promise((resolve) =>
      service.http.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${service.http.address().port}`;
  }
  await listen();
  async function request(
    path,
    { cookie, method = "GET", body, requestOrigin = origin } = {},
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Origin: requestOrigin,
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
  }
  async function account(username) {
    const result = await request("/auth/register", {
      method: "POST",
      body: { username, name: username, password: "a-strong-test-password" },
    });
    assert.equal(result.status, 201);
    return { ...result.data.user, cookie: result.cookie };
  }
  async function socketFor(user) {
    const socket = connect(base, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: { Origin: origin, Cookie: user.cookie },
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
      socket.connect();
    });
    return socket;
  }
  function emit(socket, event, payload) {
    return new Promise((resolve, reject) =>
      socket
        .timeout(2000)
        .emit(event, payload, (error, result) =>
          error ? reject(error) : resolve(result),
        ),
    );
  }
  function nextEvent(socket, event) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, done);
        reject(new Error(`Missing ${event}`));
      }, 2500);
      function done(value) {
        clearTimeout(timer);
        resolve(value);
      }
      socket.once(event, done);
    });
  }
  let alice, bob, outsider, a, b, o, chatId, first, decisionId;
  try {
    await t.test(
      "authentication, validation, origin checks, and hashed passwords",
      async () => {
        assert.equal((await request("/chats")).status, 401);
        assert.equal(
          (
            await request("/auth/register", {
              method: "POST",
              requestOrigin: "https://evil.invalid",
              body: {},
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/auth/register", {
              method: "POST",
              body: { username: "a", password: "bad" },
            })
          ).status,
          400,
        );
        alice = await account("alice");
        bob = await account("bob");
        outsider = await account("outsider");
        const row = service.db
          .prepare("SELECT password_hash FROM users WHERE id=?")
          .get(alice.id);
        assert.notEqual(row.password_hash, "a-strong-test-password");
        assert.equal(
          (
            await request("/auth/login", {
              method: "POST",
              body: { username: "alice", password: "incorrect-password" },
            })
          ).status,
          401,
        );
        assert.equal(
          (await request("/auth/me", { cookie: alice.cookie })).data.user.id,
          alice.id,
        );
        a = await socketFor(alice);
        b = await socketFor(bob);
        o = await socketFor(outsider);
      },
    );
    await t.test(
      "creates one direct chat and prevents unauthorized access",
      async () => {
        const body = { kind: "direct", memberIds: [bob.id] };
        const created = await request("/chats", {
          cookie: alice.cookie,
          method: "POST",
          body,
        });
        assert.equal(created.status, 201);
        chatId = created.data.chatId;
        assert.equal(
          (
            await request("/chats", {
              cookie: alice.cookie,
              method: "POST",
              body,
            })
          ).data.chatId,
          chatId,
        );
        assert.equal(
          (
            await request(`/chats/${chatId}/messages`, {
              cookie: outsider.cookie,
            })
          ).status,
          403,
        );
        assert.equal((await emit(o, "chat:join", { chatId })).status, 403);
        assert.equal((await emit(b, "chat:join", { chatId })).ok, true);
      },
    );
    await t.test(
      "delivers live messages only after durable commit; retries are idempotent",
      async () => {
        const input = {
          chatId,
          clientId: randomUUID(),
          kind: "text",
          body: "Hello from Alice",
        };
        const incoming = nextEvent(b, "message:new");
        first = (await emit(a, "message:send", input)).message;
        assert.equal((await incoming).message.id, first.id);
        assert.equal(first.seq, 1);
        assert.equal(
          service.db
            .prepare("SELECT body FROM messages WHERE id=?")
            .get(first.id).body,
          input.body,
        );
        const again = await emit(a, "message:send", input);
        assert.equal(again.message.id, first.id);
        assert.equal(
          service.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
          1,
        );
        assert.equal(
          (await emit(a, "message:send", { ...input, body: "different" }))
            .status,
          409,
        );
        assert.equal(
          (await emit(o, "message:send", { ...input, clientId: randomUUID() }))
            .status,
          403,
        );
      },
    );
    await t.test(
      "delivery and read receipts are monotonic and membership protected",
      async () => {
        assert.equal(
          (
            await emit(b, "message:receipt", {
              chatId,
              seq: first.seq,
              type: "delivered",
            })
          ).ok,
          true,
        );
        assert.equal(
          (
            await emit(b, "message:receipt", {
              chatId,
              seq: first.seq,
              type: "read",
            })
          ).ok,
          true,
        );
        assert.equal(
          (await emit(b, "message:receipt", { chatId, seq: 0, type: "read" }))
            .ok,
          true,
        );
        assert.equal(
          (await emit(b, "message:receipt", { chatId, seq: 999, type: "read" }))
            .status,
          400,
        );
        assert.equal(
          (await emit(o, "message:receipt", { chatId, seq: 1, type: "read" }))
            .status,
          403,
        );
        const state = (
          await request(`/chats/${chatId}/state`, { cookie: alice.cookie })
        ).data;
        assert.equal(state.members.find((u) => u.id === bob.id).readSeq, 1);
        assert.equal(
          state.members.find((u) => u.id === bob.id).deliveredSeq,
          1,
        );
      },
    );
    await t.test(
      "reconnect sync recovers missed messages in order",
      async () => {
        b.disconnect();
        await emit(a, "message:send", {
          chatId,
          clientId: randomUUID(),
          kind: "text",
          body: "While offline 1",
        });
        await emit(a, "message:send", {
          chatId,
          clientId: randomUUID(),
          kind: "text",
          body: "While offline 2",
        });
        b = await socketFor(bob);
        const result = await request(`/chats/${chatId}/messages?after=1`, {
          cookie: bob.cookie,
        });
        assert.deepEqual(
          result.data.messages.map((m) => m.seq),
          [2, 3],
        );
        assert.equal(result.data.hasMore, false);
      },
    );
    await t.test(
      "decisions preserve one editable vote per member",
      async () => {
        decisionId = (
          await emit(a, "message:send", {
            chatId,
            clientId: randomUUID(),
            kind: "decision",
            body: "Dinner at seven?",
          })
        ).message.id;
        assert.equal(
          (
            await emit(b, "decision:vote", {
              messageId: decisionId,
              choice: "agree",
            })
          ).ok,
          true,
        );
        assert.equal(
          (
            await emit(b, "decision:vote", {
              messageId: decisionId,
              choice: "discuss",
            })
          ).ok,
          true,
        );
        assert.equal(
          (
            await emit(o, "decision:vote", {
              messageId: decisionId,
              choice: "agree",
            })
          ).status,
          403,
        );
        const state = (
          await request(`/chats/${chatId}/state`, { cookie: alice.cookie })
        ).data;
        assert.deepEqual(state.votes, [
          { messageId: decisionId, userId: bob.id, choice: "discuss" },
        ]);
      },
    );
    await t.test(
      "personal conversation modes do not modify other members",
      async () => {
        assert.equal(
          (
            await request(`/chats/${chatId}/mode`, {
              method: "PATCH",
              cookie: alice.cookie,
              body: { mode: "focus" },
            })
          ).status,
          200,
        );
        assert.equal(
          (await request("/chats", { cookie: alice.cookie })).data.chats[0]
            .mode,
          "focus",
        );
        assert.equal(
          (await request("/chats", { cookie: bob.cookie })).data.chats[0].mode,
          "social",
        );
      },
    );
    await t.test(
      "group chat broadcasts to all members and validates group title",
      async () => {
        const body = {
          kind: "group",
          title: "Weekend",
          memberIds: [bob.id, outsider.id],
        };
        const group = await request("/chats", {
          cookie: alice.cookie,
          method: "POST",
          body,
        });
        assert.equal(group.status, 201);
        const incoming = nextEvent(o, "message:new");
        await emit(a, "message:send", {
          chatId: group.data.chatId,
          clientId: randomUUID(),
          kind: "text",
          body: "Group hello",
        });
        assert.equal((await incoming).message.body, "Group hello");
        assert.equal(
          (
            await request("/chats", {
              cookie: alice.cookie,
              method: "POST",
              body: { ...body, title: "" },
            })
          ).status,
          400,
        );
      },
    );
    await t.test("voice notes preserve audio type and enforce access during ranged playback", async () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array([26,69,223,163,0,0,0,0])], { type: "audio/webm" }), "voice.webm");
      const response = await fetch(`${base}/api/chats/${chatId}/files`, { method: "POST", headers: { Origin: origin, Cookie: alice.cookie }, body: form });
      assert.equal(response.status, 201);
      const { attachment } = await response.json();
      assert.equal(attachment.mime, "audio/webm");
      const url = `${base}/api/files/${attachment.id}?play=1`;
      assert.equal((await fetch(url, { headers: { Cookie: bob.cookie } })).status, 404);
      await emit(a, "message:send", { chatId, clientId: randomUUID(), kind: "file", body: "", attachmentId: attachment.id });
      const playback = await fetch(url, { headers: { Cookie: bob.cookie, Range: "bytes=0-3" } });
      assert.equal(playback.status, 206);
      assert.match(playback.headers.get("content-type"), /audio\/webm/);
      assert.equal((await playback.arrayBuffer()).byteLength, 4);
      assert.equal((await fetch(url, { headers: { Cookie: outsider.cookie } })).status, 403);
      assert.equal((await fetch(url)).status, 401);
    });
    await t.test(
      "file sharing enforces membership and hides unshared files",
      async () => {
        const form = new FormData();
        form.append("file", new Blob(["private file"]), "note.txt");
        const response = await fetch(`${base}/api/chats/${chatId}/files`, {
          method: "POST",
          headers: { Origin: origin, Cookie: alice.cookie },
          body: form,
        });
        assert.equal(response.status, 201);
        const { attachment } = await response.json();
        assert.equal(
          (await request(`/files/${attachment.id}`, { cookie: bob.cookie }))
            .status,
          404,
        );
        assert.equal(
          (
            await emit(a, "message:send", {
              chatId,
              clientId: randomUUID(),
              kind: "file",
              body: "",
              attachmentId: attachment.id,
            })
          ).ok,
          true,
        );
        const download = await fetch(`${base}/api/files/${attachment.id}`, {
          headers: { Cookie: bob.cookie },
        });
        assert.equal(download.status, 200);
        assert.equal(await download.text(), "private file");
        assert.match(download.headers.get("content-disposition"), /attachment/);
        assert.equal(
          (
            await request(`/files/${attachment.id}`, {
              cookie: outsider.cookie,
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "typing is emitted only to authorized conversation rooms",
      async () => {
        await emit(b, "chat:join", { chatId });
        const incoming = nextEvent(b, "typing");
        assert.equal(
          (await emit(a, "typing", { chatId, active: true })).ok,
          true,
        );
        assert.equal((await incoming).userId, alice.id);
        assert.equal(
          (await emit(o, "typing", { chatId, active: true })).status,
          403,
        );
      },
    );
    await t.test(
      "logout revokes both HTTP and active socket sessions",
      async () => {
        const disconnected = nextEvent(o, "disconnect");
        assert.equal(
          (
            await request("/auth/logout", {
              cookie: outsider.cookie,
              method: "POST",
            })
          ).status,
          200,
        );
        await disconnected;
        assert.equal(
          (await request("/chats", { cookie: outsider.cookie })).status,
          401,
        );
      },
    );
    await t.test(
      "messages, sessions and votes survive a server restart",
      async () => {
        for (const socket of sockets) socket.disconnect();
        await service.close();
        service = createApplication(options);
        await listen();
        const messages = (
          await request(`/chats/${chatId}/messages`, { cookie: alice.cookie })
        ).data.messages;
        assert.equal(messages[0].id, first.id);
        assert.equal(messages.length, 6);
        assert.equal(
          (await request(`/chats/${chatId}/state`, { cookie: alice.cookie }))
            .data.votes[0].messageId,
          decisionId,
        );
      },
    );
  } finally {
    for (const socket of sockets) socket.disconnect();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
