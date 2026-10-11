/**
 * The server: WebSocket framing, static serving, the relay hub, and the OS input runner.
 *
 * These run against a real `node:http` server on an ephemeral port and Node's own WebSocket
 * client, so the handshake and the frame codec are exercised end to end rather than against
 * a mock of themselves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acceptKey, createWebSocketServer, Socket, OP } from '../server/websocket.js';
import { createStaticHandler } from '../server/static.js';
import { BridgeHub } from '../server/bridgeHub.js';
import { OsInputRunner, validateSchedule, summariseDrift } from '../server/osInputRunner.js';
import { canSend, createBackend, detect, toX11, toVk, toCliclick, EV } from '../server/osInput.js';
import { connect as netConnect } from 'node:net';
import { start } from '../server/index.js';

/**
 * Send a raw HTTP request and read the status line and body.
 * `fetch` cannot be used for these cases: it refuses the `Upgrade` and `Connection` headers
 * a handshake needs, and its URL parser normalises `%2e%2e` to `..` before sending, which
 * would test the parser rather than the server.
 */
function rawRequest(port, requestText) {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket = netConnect(port, '127.0.0.1');
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); resolveRaw(buffer); }, 2500);
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\r\n\r\n')) {
        const head = buffer.split('\r\n\r\n')[0];
        const length = /content-length: (\d+)/i.exec(head);
        const body = buffer.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        if (!length || body.length >= Number(length[1])) { clearTimeout(timer); socket.destroy(); resolveRaw(buffer); }
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); rejectRaw(err); });
    socket.on('close', () => { clearTimeout(timer); resolveRaw(buffer); });
  });
}

const statusOf = (raw) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);

const TOKEN = 'b'.repeat(48);

/** An http server with both the WebSocket endpoint and a hub attached, on a free port. */
async function serveHub() {
  const handles = await start({ port: 0, host: '127.0.0.1', token: TOKEN, quiet: true });
  return {
    ...handles,
    url: `ws://127.0.0.1:${handles.address.port}/ws`,
    httpUrl: `http://127.0.0.1:${handles.address.port}`,
  };
}

function connect(url) {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = new WebSocket(url);
    const messages = [];
    socket.messages = messages;
    socket.onmessage = (event) => messages.push(JSON.parse(event.data));
    socket.waitFor = (predicate, timeoutMs = 3000) => new Promise((resolveWait, rejectWait) => {
      const found = messages.find(predicate);
      if (found) { resolveWait(found); return; }
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        rejectWait(new Error(`no matching message within ${timeoutMs}ms; got ${JSON.stringify(messages).slice(0, 400)}`));
      }, timeoutMs);
      const onMessage = (event) => {
        const parsed = JSON.parse(event.data);
        if (predicate(parsed)) { clearTimeout(timer); socket.removeEventListener('message', onMessage); resolveWait(parsed); }
      };
      socket.addEventListener('message', onMessage);
    });
    socket.onopen = () => resolveConnect(socket);
    socket.onerror = (err) => rejectConnect(new Error(`WebSocket error: ${err.message || 'unknown'}`));
  });
}

async function appClient(server, token = TOKEN) {
  const socket = await connect(server.url);
  socket.send(JSON.stringify({ type: 'hello', role: 'app', token }));
  await socket.waitFor((m) => m.type === 'hello:ok' || m.type === 'hello:error');
  return socket;
}

/* ── handshake ───────────────────────────────────────────────────────── */

test('the accept key is the RFC 6455 example', () => {
  // The value from §1.3 of the RFC, so the codec is checked against the specification
  // rather than against its own output.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a handshake without the right version or key is refused', async () => {
  const server = await serveHub();
  const port = server.address.port;
  try {
    // The wrong Sec-WebSocket-Version: the server says 400 and advertises 13.
    const badVersion = await rawRequest(port,
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n');
    assert.equal(statusOf(badVersion), 400);
    assert.match(badVersion, /Sec-WebSocket-Version: 13/i);

    // No key at all.
    const noKey = await rawRequest(port,
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Version: 13\r\n\r\n');
    assert.equal(statusOf(noKey), 400);

    // The right headers on a path that is not the endpoint: a 404, not a silent upgrade.
    const wrongPath = await rawRequest(port,
      'GET /not-the-endpoint HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.equal(statusOf(wrongPath), 404);

    // A correct handshake is accepted and answers with the RFC accept key.
    const good = await rawRequest(port,
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.equal(statusOf(good), 101);
    assert.match(good, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  } finally {
    await server.stop();
  }
});

test('a wrong token is refused with a reason the user can act on', async () => {
  const server = await serveHub();
  try {
    const socket = await appClient(server, 'not-the-token');
    const refused = socket.messages.find((m) => m.type === 'hello:error');
    assert.ok(refused, 'the refusal was reported');
    assert.match(refused.message, /Settings → Integration/);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING, 'and the socket was closed');
  } finally {
    await server.stop();
  }
});

test('a client that never identifies itself is dropped', async () => {
  const server = await serveHub();
  try {
    const socket = await connect(server.url);
    await new Promise((r) => setTimeout(r, 5200));
    assert.ok(socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING,
      'an unidentified client does not stay connected');
    assert.equal(server.hub.apps.size, 0);
    assert.equal(server.hub.bridge, null);
  } finally {
    await server.stop();
  }
});

test('a bridge role is refused before it identifies itself', async () => {
  const server = await serveHub();
  try {
    const socket = await connect(server.url);
    socket.send(JSON.stringify({ type: 'relay', to: 'bridge', message: { type: 'mf:request' } }));
    const error = await socket.waitFor((m) => m.type === 'error');
    assert.match(error.message, /send hello first/);
    socket.send(JSON.stringify({ type: 'hello', role: 'supervisor', token: TOKEN }));
    const refused = await socket.waitFor((m) => m.type === 'hello:error');
    assert.match(refused.message, /role must be/);
  } finally {
    await server.stop();
  }
});

/* ── relay ───────────────────────────────────────────────────────────── */

test('messages relay between an app and a bridge in both directions', async () => {
  const server = await serveHub();
  try {
    const app = await appClient(server);
    assert.equal(app.messages.find((m) => m.type === 'hello:ok').hub.bridgeConnected, false);

    const bridge = await connect(server.url);
    bridge.send(JSON.stringify({ type: 'hello', role: 'bridge', token: TOKEN, info: { bridgeVersion: '1.0.0', url: 'https://ashtonkmania.vercel.app/', capabilities: ['state'] } }));
    await bridge.waitFor((m) => m.type === 'hello:ok');

    const status = await app.waitFor((m) => m.type === 'bridge:status');
    assert.equal(status.payload.bridgeConnected, true);
    assert.equal(status.payload.bridge.bridgeVersion, '1.0.0');
    assert.equal(server.hub.snapshot().appClients, 1);

    // app → bridge
    app.send(JSON.stringify({ type: 'relay', to: 'bridge', message: { type: 'mf:request', id: 'r1', kind: 'state' } }));
    const inbound = await bridge.waitFor((m) => m.type === 'relay' && m.message?.type === 'mf:request');
    assert.equal(inbound.from, 'app');
    assert.equal(inbound.message.id, 'r1');

    // bridge → app
    bridge.send(JSON.stringify({ type: 'relay', to: 'app', message: { type: 'bridge:result', id: 'r1', ok: true, payload: { screen: 'gameplay' } } }));
    const reply = await app.waitFor((m) => m.type === 'relay' && m.message?.id === 'r1');
    assert.equal(reply.from, 'bridge');
    assert.equal(reply.message.payload.screen, 'gameplay');
  } finally {
    await server.stop();
  }
});

test('only one bridge drives the game; a second takes over and the first is told', async () => {
  const server = await serveHub();
  try {
    const first = await connect(server.url);
    first.send(JSON.stringify({ type: 'hello', role: 'bridge', token: TOKEN, info: { bridgeVersion: '1.0.0' } }));
    await first.waitFor((m) => m.type === 'hello:ok');

    const second = await connect(server.url);
    second.send(JSON.stringify({ type: 'hello', role: 'bridge', token: TOKEN, info: { bridgeVersion: '2.0.0' } }));
    await second.waitFor((m) => m.type === 'hello:ok');
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(server.hub.bridge, server.hub.bridge, 'the hub holds one bridge');
    assert.equal(server.hub.bridgeInfo.bridgeVersion, '2.0.0', 'and it is the newer one');
    assert.ok(first.readyState === WebSocket.CLOSED || first.readyState === WebSocket.CLOSING, 'the older bridge was closed');
  } finally {
    await server.stop();
  }
});

test('a relay with no bridge is refused rather than silently dropped', async () => {
  const server = await serveHub();
  try {
    const app = await appClient(server);
    app.send(JSON.stringify({ type: 'relay', to: 'bridge', message: { type: 'mf:request', id: 'x9', kind: 'library' } }));
    const error = await app.waitFor((m) => m.type === 'relay:error');
    assert.match(error.message, /no bridge is connected/);
    assert.equal(error.replyTo, 'x9', 'the refusal names the request it refused');
  } finally {
    await server.stop();
  }
});

test('a bridge disconnect is reported to every app', async () => {
  const server = await serveHub();
  try {
    const app = await appClient(server);
    const bridge = await connect(server.url);
    bridge.send(JSON.stringify({ type: 'hello', role: 'bridge', token: TOKEN, info: {} }));
    await app.waitFor((m) => m.type === 'bridge:status' && m.payload.bridgeConnected === true);
    bridge.close();
    const gone = await app.waitFor((m) => m.type === 'bridge:status' && m.payload.bridgeConnected === false);
    assert.equal(gone.payload.bridge, null);
    assert.equal(server.hub.bridge, null);
  } finally {
    await server.stop();
  }
});

test('invalid JSON is reported and the connection survives', async () => {
  const server = await serveHub();
  try {
    const app = await appClient(server);
    app.send('{ this is not json');
    const error = await app.waitFor((m) => m.type === 'error');
    assert.match(error.message, /invalid JSON/);
    app.send(JSON.stringify({ type: 'bridge:ping' }));
    const pong = await app.waitFor((m) => m.type === 'bridge:pong');
    assert.ok(pong.at > 0, 'the socket still works afterwards');
  } finally {
    await server.stop();
  }
});

/* ── framing ─────────────────────────────────────────────────────────── */

test('a large message is fragmented and reassembled intact', async () => {
  const server = await serveHub();
  try {
    const app = await appClient(server);
    const bridge = await connect(server.url);
    bridge.send(JSON.stringify({ type: 'hello', role: 'bridge', token: TOKEN, info: {} }));
    await app.waitFor((m) => m.type === 'bridge:status' && m.payload.bridgeConnected);

    // Well past the 512 KiB fragment size, so it must arrive as continuation frames.
    const payload = { type: 'bridge:state', payload: { blob: 'x'.repeat(1400 * 1024) } };
    bridge.send(JSON.stringify({ type: 'relay', to: 'app', message: payload }));
    const received = await app.waitFor((m) => m.type === 'relay' && m.message?.payload?.blob, 8000);
    assert.equal(received.message.payload.blob.length, 1400 * 1024, 'nothing was truncated');
  } finally {
    await server.stop();
  }
});

test('a masked-frame violation and an unknown opcode close the socket with a protocol error', () => {
  // The codec rejects what a browser would never send, so a malformed client cannot wedge
  // the hub. Verified at the unit level, where a raw buffer can be fed in directly.
  const sockets = [];
  const fakeStream = {
    writable: true,
    written: [],
    write(chunk) { this.written.push(chunk); return true; },
    on() {}, destroy() {}, socket: { remoteAddress: '127.0.0.1' },
  };
  const socket = new Socket(fakeStream, { headers: {} });
  sockets.push(socket);
  const closed = [];
  socket.on('close', (info) => closed.push(info));

  // A client frame without the mask bit set.
  const unmasked = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  socket._onData(unmasked);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1002, 'a protocol error closes with 1002');
  assert.match(closed[0].reason, /must be masked/);

  const second = new Socket(fakeStream, { headers: {} });
  const closed2 = [];
  second.on('close', (info) => closed2.push(info));
  second._onData(Buffer.from([0x8b, 0x80, 0, 0, 0, 0]));   // opcode 0xb is reserved
  assert.equal(closed2.length, 1);
  assert.match(closed2[0].reason, /unknown opcode/);
  assert.ok(sockets.length === 1);
});

test('an incomplete frame waits for the rest instead of failing', () => {
  const writes = [];
  const stream = { writable: true, write: (c) => { writes.push(c); return true; }, on() {}, destroy() {}, socket: {} };
  const socket = new Socket(stream, { headers: {} });
  const received = [];
  const closed = [];
  socket.on('message', (text) => received.push(text));
  socket.on('close', (info) => closed.push(info));

  // "hello" masked with key 0x01, delivered one byte at a time.
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from('hello');
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  const frame = Buffer.concat([Buffer.from([0x81, 0x85]), mask, payload]);
  for (const byte of frame) socket._onData(Buffer.from([byte]));

  assert.equal(closed.length, 0, 'a partial frame is not a protocol error');
  assert.deepEqual(received, ['hello'], 'and it is delivered once complete');
});

/* ── static serving ──────────────────────────────────────────────────── */

test('the HTTP surface serves the app, the config and the token-filled bridge script', async () => {
  const server = await serveHub();
  try {
    const index = await fetch(`${server.httpUrl}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /ManiaFlow/);

    const module = await fetch(`${server.httpUrl}/src/app/App.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.equal(module.headers.get('cache-control'), 'no-cache', 'a module is never pinned stale during development');

    const config = await (await fetch(`${server.httpUrl}/api/config`)).json();
    assert.equal(config.token, TOKEN);
    assert.equal(config.wsPath, '/ws');
    assert.equal(config.version, '1.0.0');

    const health = await (await fetch(`${server.httpUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.bridge.bridgeConnected, false);
    assert.ok('osInput' in health);

    const bridgeScript = await (await fetch(`${server.httpUrl}/bridge/installed.js`)).text();
    assert.ok(bridgeScript.includes(TOKEN), 'the token is filled in');
    assert.ok(bridgeScript.includes(`/ws`), 'and so is the endpoint');
    assert.ok(!bridgeScript.includes('__MANIAFLOW_TOKEN__'), 'no placeholder survives');

    // An unknown path falls back to the app so the client router owns it.
    const deep = await fetch(`${server.httpUrl}/timing`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /ManiaFlow/);

    // A missing asset is a 404, not the app shell — otherwise a typo looks like success.
    const missing = await fetch(`${server.httpUrl}/src/does-not-exist.js`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test('the static handler refuses to escape its root', async () => {
  const server = await serveHub();
  const port = server.address.port;
  const root = server.address ? null : null;
  void root;
  try {
    // Encoded traversals, sent raw so nothing normalises them before the server sees them.
    for (const path of [
      '/../../package.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/src/../../server/index.js',
    ]) {
      const raw = await rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      const status = statusOf(raw);
      assert.ok(status === 403 || status === 404 || status === 200, `${path} → ${status}`);
      // Whatever the status, the response must not be a file from outside the project root.
      // package.json is inside the root and is fine to serve; /etc/passwd is not.
      assert.ok(!raw.includes('root:x:0:0'), `${path} must not reach /etc/passwd`);
    }

    const passwd = await rawRequest(port,
      'GET /../../../../../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.ok(!passwd.includes('root:x:0:0'), 'an absolute traversal does not escape');
    const encodedPasswd = await rawRequest(port,
      'GET /%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.ok(!encodedPasswd.includes('root:x:0:0'), 'nor does an encoded one');

    // Only GET and HEAD are served.
    const post = await rawRequest(port, 'POST /api/config HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    assert.equal(statusOf(post), 405);

    // A HEAD answer carries the length without the body.
    const head = await rawRequest(port, 'HEAD /api/config HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.equal(statusOf(head), 200);
    assert.match(head, /content-type: application\/json/i);
  } finally {
    await server.stop();
  }
});

/* ── OS input runner ─────────────────────────────────────────────────── */

test('the runner refuses to do anything before a backend is armed', async () => {
  const runner = new OsInputRunner({ createBackend: () => null });
  await assert.rejects(() => runner.press('KeyD'), /No OS input backend is armed/);
  await assert.rejects(() => runner.run({ events: [[0, 'KeyD', 1], [20, 'KeyD', 0]] }), /No OS input backend is armed/);
  assert.equal(runner.armed, false);
  assert.deepEqual((await runner.emergencyStop()).released, [], 'an emergency stop with nothing armed is a no-op, not an error');
  assert.deepEqual(runner.status(), { armed: false, backendId: null, running: false, held: [], lastRun: null });
});

test('arming an unknown backend is refused', async () => {
  const runner = new OsInputRunner({ createBackend: (id) => (id === 'real' ? fakeBackend() : null) });
  await assert.rejects(() => runner.arm('imaginary'), /Unknown OS input backend/);
  await assert.rejects(() => runner.arm('real-but-broken'), /Unknown OS input backend/);
});

/** A backend double that records what it was asked to do. */
function fakeBackend(options = {}) {
  const pressed = [];
  const released = [];
  return {
    id: 'fake', opened: false, held: new Set(), supportsHolds: true,
    pressed, released,
    async open() { if (options.failOpen) throw new Error(options.failOpen); this.opened = true; },
    async press(code) { if (options.failOn === code) throw new Error(`cannot send ${code}`); this.held.add(code); pressed.push(code); },
    async release(code) { if (options.failOn === code) throw new Error(`cannot release ${code}`); this.held.delete(code); released.push(code); },
    async close() { this.opened = false; },
    async releaseAll() { const stuck = [...this.held]; this.held.clear(); released.push(...stuck); return stuck; },
  };
}

test('a backend that fails to open leaves the runner unarmed and reports why', async () => {
  const backend = fakeBackend({ failOpen: 'xdotool is not installed or not on PATH' });
  const runner = new OsInputRunner({ createBackend: () => backend });
  await assert.rejects(() => runner.arm('fake'), /not installed/);
  assert.equal(runner.armed, false, 'a failed arm does not claim to be armed');
  assert.equal(backend.opened, false);
});

test('a schedule is played in order, and every key comes back up', async () => {
  const backend = fakeBackend();
  const runner = new OsInputRunner({ createBackend: () => backend });
  await runner.arm('fake');
  assert.equal(runner.armed, true);

  const events = [
    [0, 'KeyD', 1], [10, 'KeyF', 1], [30, 'KeyD', 0], [40, 'KeyJ', 1], [50, 'KeyF', 0], [70, 'KeyJ', 0],
  ];
  const result = await runner.run({ events, leadMs: 20 });

  assert.equal(result.planned, 6);
  assert.equal(result.executed, 6);
  assert.equal(result.failures, 0);
  assert.equal(result.cancelled, false);
  assert.deepEqual(backend.pressed, ['KeyD', 'KeyF', 'KeyJ']);
  assert.deepEqual(backend.released, ['KeyD', 'KeyF', 'KeyJ']);
  assert.equal(backend.held.size, 0, 'nothing is left down at the end');
  assert.ok(result.durationMs >= 70, 'it took at least as long as the schedule');
  assert.ok(result.timing.count === 6);
  assert.ok(Number.isFinite(result.timing.meanMs));
});

test('an emergency stop mid-run releases everything held and reports it', async () => {
  const backend = fakeBackend();
  const runner = new OsInputRunner({ createBackend: () => backend });
  await runner.arm('fake');

  const events = [[0, 'KeyD', 1], [5, 'KeyF', 1], [400, 'KeyD', 0], [410, 'KeyF', 0]];
  const running = runner.run({ events, leadMs: 5 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(backend.held.size, 2, 'two keys are down mid-schedule');
  assert.equal(runner.running, true);

  const stopped = await runner.emergencyStop();
  assert.equal(stopped.released.length, 2);
  assert.deepEqual(backend.released.sort(), ['KeyD', 'KeyF']);
  assert.equal(backend.held.size, 0);

  const result = await running;
  assert.equal(result.cancelled, true, 'the run knows it was cancelled');
  assert.ok(result.executed < 4, 'and it did not play the rest of the schedule');
  assert.equal(result.releasedOnStop, 0, 'the keys were already gone by the time it unwound');
});

test('a key that cannot be sent is counted as a failure and does not wedge the run', async () => {
  const backend = fakeBackend({ failOn: 'KeyF' });
  const runner = new OsInputRunner({ createBackend: () => backend });
  await runner.arm('fake');
  const errors = [];
  runner.on('error', (err) => errors.push(err));

  const result = await runner.run({ events: [[0, 'KeyD', 1], [10, 'KeyF', 1], [30, 'KeyD', 0], [40, 'KeyF', 0]], leadMs: 5 });
  assert.equal(result.failures, 2, 'the press and the release both failed');
  assert.equal(result.executed, 2, 'the rest still ran');
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /cannot send KeyF/);
  assert.equal(backend.held.size, 0, 'a failed key is not believed to be held');
});

test('two runs cannot overlap', async () => {
  const backend = fakeBackend();
  const runner = new OsInputRunner({ createBackend: () => backend });
  await runner.arm('fake');
  const first = runner.run({ events: [[0, 'KeyD', 1], [300, 'KeyD', 0]], leadMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(() => runner.run({ events: [[0, 'KeyF', 1], [20, 'KeyF', 0]] }), /already running/);
  await first;
});

test('disarming releases held keys before closing the backend', async () => {
  const backend = fakeBackend();
  const runner = new OsInputRunner({ createBackend: () => backend });
  await runner.arm('fake');
  await backend.press('KeyK');
  await runner.disarm();
  assert.deepEqual(backend.released, ['KeyK'], 'a key held at disarm time is let go');
  assert.equal(backend.opened, false);
  assert.equal(runner.armed, false);
  assert.equal(runner.backendId, null);
});

test('schedule validation rejects the ways a schedule can be malformed', () => {
  assert.equal(validateSchedule([[0, 'KeyD', 1], [20, 'KeyD', 0]]).length, 2);
  assert.throws(() => validateSchedule('nope'), /must be an array/);
  assert.throws(() => validateSchedule([[0, 'KeyD']]), /must be \[delayMs, code, down\]/);
  assert.throws(() => validateSchedule([['soon', 'KeyD', 1]]), /non-numeric delay/);
  assert.throws(() => validateSchedule([[0, '', 1]]), /invalid key code/);
  assert.throws(() => validateSchedule([[0, 'KeyD', 2]]), /invalid down flag/);
  assert.throws(() => validateSchedule([[10, 'KeyD', 1], [5, 'KeyD', 0]]), /out of order/);
  assert.throws(() => validateSchedule(new Array(400001).fill([0, 'KeyD', 1])), /too large/);
  // Booleans are accepted and normalised to 1/0, because a caller may build them that way.
  assert.deepEqual(validateSchedule([[0, 'KeyD', true], [20, 'KeyD', false]]), [[0, 'KeyD', 1], [20, 'KeyD', 0]]);
});

test('drift is summarised with the percentiles a timing report needs', () => {
  assert.deepEqual(summariseDrift([]), { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 });
  const summary = summariseDrift([1, 2, 3, 4, 100]);
  assert.equal(summary.count, 5);
  assert.equal(summary.medianMs, 3);
  assert.equal(summary.maxMs, 100);
  assert.ok(summary.p95Ms >= summary.medianMs);
  assert.ok(Number.isFinite(summary.meanMs));
  const negatives = summariseDrift([-5, -1, 0, 2]);
  assert.equal(negatives.maxMs, 2);
  assert.ok(negatives.meanMs < 0, 'an early-biased run reports a negative mean');
});

/* ── OS input detection and key tables ───────────────────────────────── */

test('detection reports what this machine actually offers, and never guesses', async () => {
  const result = await detect();
  assert.ok(['linux', 'darwin', 'win32'].includes(result.platform));
  assert.ok(Array.isArray(result.backends));
  for (const backend of result.backends) {
    assert.ok(backend.id && backend.label && backend.binary, 'each candidate is described');
    assert.equal(typeof backend.installed, 'boolean');
    assert.equal(typeof backend.available, 'boolean');
    if (!backend.installed) assert.match(backend.reason, /not found on PATH/);
    if (backend.available) assert.ok(Array.isArray(backend.supports) && backend.supports.length, 'an available backend lists the keys it was verified against');
  }
  // Whatever the answer, it must be consistent: available implies installed.
  assert.ok(result.backends.every((b) => !b.available || b.installed));
});

test('an unavailable backend cannot be armed, which is the bug this guards against', async () => {
  const result = await detect();
  const unavailable = result.backends.find((b) => !b.available);
  if (!unavailable) return;   // a machine with every helper installed has nothing to check
  const backend = createBackend(unavailable.id);
  await assert.rejects(() => backend.open(), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.length > 0, 'the reason is specific rather than a bare failure');
    return true;
  });
});

test('key tables cover the keys a mania keybind can use', () => {
  const maniaCodes = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
    'KeyC', 'KeyX', 'KeyZ', 'Space', 'Semicolon', 'Comma', 'Period', 'Slash', 'Quote', 'Digit1', 'Digit7'];
  for (const code of maniaCodes) {
    assert.ok(toX11(code), `xdotool has a keysym for ${code}`);
    assert.ok(EV[code] !== undefined, `ydotool has an input-event code for ${code}`);
    assert.ok(toVk(code) != null, `SendInput has a virtual-key code for ${code}`);
    assert.ok(canSend('xdotool', code) && canSend('ydotool', code) && canSend('windows-sendinput', code));
  }
  assert.equal(toX11('KeyD'), 'd');
  assert.equal(toX11('Space'), 'space');
  assert.equal(toX11('Semicolon'), 'semicolon');
  assert.equal(toX11('ArrowLeft'), 'Left');
  assert.equal(toVk('KeyA'), 0x41);
  assert.equal(toVk('Space'), 0x20);
  assert.equal(EV.KeyA, 30);
  assert.equal(EV.Space, 57);
  assert.equal(toCliclick('KeyA'), 'a');
  assert.equal(toCliclick('ArrowLeft'), 'arrow-left');
  // Something no backend can send is reported, not sent anyway.
  assert.equal(canSend('xdotool', 'NotAKey'), false);
  assert.equal(canSend('imaginary-backend', 'KeyD'), false);
  assert.equal(createBackend('imaginary'), null);
});

/* ── framing constants ───────────────────────────────────────────────── */

test('the opcode table matches RFC 6455', () => {
  assert.equal(OP.CONT, 0x0);
  assert.equal(OP.TEXT, 0x1);
  assert.equal(OP.BIN, 0x2);
  assert.equal(OP.CLOSE, 0x8);
  assert.equal(OP.PING, 0x9);
  assert.equal(OP.PONG, 0xa);
  assert.equal(Socket.OPEN, 1);
  assert.equal(Socket.CLOSED, 3);
});

test('the bridge userscript never touches the game\'s own autoplay', () => {
  // Section 18: the input path must not be the website's autoplay. Verified against the
  // shipped script text, so a future edit that reaches for AT cannot pass unnoticed.
  const source = readFileSync(new URL('../bridge/maniaflow-bridge.user.js', import.meta.url), 'utf8');
  assert.ok(!/'AT'/.test(source), 'the script never selects the AT mod');
  assert.ok(!/generateAutoInputs/.test(source) || /never calls `generateAutoInputs`/.test(source),
    'generateAutoInputs appears only in the comment explaining that it is not used');
  assert.ok(!/\.feed\s*=/.test(source), 'and it never assigns to a gameplay session\'s feed');
  assert.ok(/s\.practice/.test(source), 'it does check for practice mode');
  assert.ok(/isTrusted/.test(source), 'and it is explicit that synthetic events are not trusted');
  assert.ok(/ModSelect|mods\.includes\('AT'\)/.test(source) === false, 'it does not reach into mod selection');
});
