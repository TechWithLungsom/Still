import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { createApplication } from '../server/app.js';
import { configuration } from '../scripts/configure-hosting.js';

test('hosting configuration rejects unsafe origins and prevents API caching', () => {
  const config = configuration('https://still-a071.onrender.com', 'https://still-chatapp.vercel.app');
  assert.equal(config.rewrites[0].destination, 'https://still-a071.onrender.com/api/:path*');
  assert.ok(config.headers[0].headers.some(h => h.key === 'Cache-Control' && h.value === 'no-store'));
  for (const bad of ['http://localhost:3001', 'https://user:secret@host.com', 'https://host.com/path']) {
    assert.throws(() => configuration(bad, 'https://still-chatapp.vercel.app'));
  }
});

test('direct WebSocket tickets authenticate without cookies, cannot be replayed, and honor logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'still-hosting-'));
  const origin = 'https://still-chatapp.vercel.app';
  const app = createApplication({ origin, secure: false, database: join(directory, 'db.sqlite'), uploadDir: join(directory, 'uploads') });
  const sockets = [];
  await new Promise(resolve => app.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.http.address().port}`;
  async function post(path, cookie, body) {
    return fetch(`${base}/api${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}) });
  }
  async function connect(ticket) {
    const socket = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false, extraHeaders: { Origin: origin }, auth: { ticket } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  }
  try {
    assert.equal((await post('/auth/socket-ticket')).status, 401);
    const registered = await post('/auth/register', null, { username: 'hostingtester', name: 'Hosting Tester', password: 'strong-test-password-2026' });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    const response = await post('/auth/socket-ticket', cookie);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { ticket } = await response.json();
    const socket = await connect(ticket);
    assert.equal(socket.connected, true);
    await assert.rejects(connect(ticket), /sign in/);
    const pending = await (await post('/auth/socket-ticket', cookie)).json();
    const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
    assert.equal((await post('/auth/logout', cookie)).status, 200);
    await disconnected;
    await assert.rejects(connect(pending.ticket), /sign in/);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
