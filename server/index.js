/**
 * ManiaFlow server: static UI, the bridge relay, and OS-level keyboard input.
 *
 *   node server/index.js                      # http://127.0.0.1:4310
 *   PORT=8080 HOST=0.0.0.0 node server/index.js
 *
 * One process, no dependencies, no build step. Everything the browser cannot do — talk to
 * the game page across an origin boundary, and press real keys through the operating
 * system — happens here.
 *
 * `start()` is exported and the server only listens when this file is the entry point, so a
 * test or a startup check can import the module without opening a port.
 */
import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStaticHandler } from './static.js';
import { createWebSocketServer } from './websocket.js';
import { BridgeHub } from './bridgeHub.js';
import { OsInputRunner, validateSchedule } from './osInputRunner.js';
import { canSend, createBackend, detect } from './osInput.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const VERSION = '1.0.0';
const TOKEN_PATH = join(ROOT, '.maniaflow', 'token');

/**
 * The bridge token: reused across restarts so an installed userscript keeps working.
 * It stops another page in the browser from posing as a bridge or reading chart data; it is
 * not a secret from anyone who can already load the ManiaFlow UI.
 */
export async function loadOrCreateToken(env = process.env) {
  if (env.MANIAFLOW_TOKEN) return env.MANIAFLOW_TOKEN.trim();
  try {
    const existing = await readFile(TOKEN_PATH, 'utf8');
    if (existing.trim().length >= 16) return existing.trim();
  } catch { /* first run */ }
  const token = randomBytes(24).toString('hex');
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/**
 * Build and start everything.
 * @param {{ port?: number, host?: string, token?: string, quiet?: boolean }} [options]
 */
export async function start(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 4310);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const token = options.token ?? await loadOrCreateToken();
  const log = options.quiet ? () => {} : (...args) => console.log(...args);

  const handleStatic = createStaticHandler(ROOT);
  const runner = new OsInputRunner({ createBackend });

  const server = createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('Bad request');
      return;
    }

    // Every endpoint below is a read. Answering one on POST would mean a form on some other
    // page could request the bridge token, so the method is checked before anything else.
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (!isRead && (url.pathname.startsWith('/api/') || url.pathname === '/bridge/installed.js')) {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
      response.end('Method not allowed');
      return;
    }

    if (url.pathname === '/api/config') {
      const body = JSON.stringify({
        version: VERSION,
        token,
        wsPath: '/ws',
        origin: `http://${request.headers.host || `${host}:${port}`}`,
        osInput: { platform: process.platform },
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, version: VERSION, bridge: hub.snapshot(), osInput: runner.status() }));
      return;
    }

    // The bridge script with this machine's token and WebSocket address already filled in,
    // so installing it is one copy-paste and never a stale token.
    if (url.pathname === '/bridge/installed.js') {
      try {
        const source = await readFile(join(ROOT, 'bridge', 'maniaflow-bridge.user.js'), 'utf8');
        const wsUrl = `ws://${request.headers.host || `${host}:${port}`}/ws`;
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(source.replace(/__MANIAFLOW_TOKEN__/g, token).replace(/__MANIAFLOW_WS__/g, wsUrl));
      } catch (err) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`bridge script unavailable: ${err.message}`);
      }
      return;
    }

    return handleStatic(request, response);
  });

  const wss = createWebSocketServer(server, { path: '/ws' });
  const hub = new BridgeHub({ token, timingSafeEqual }).attach(wss);

  /* ── OS input control messages, driven by the UI ───────────────────── */

  hub.on('message', async ({ socket, message }) => {
    if (socket.role !== 'app') {
      socket.send(JSON.stringify({ type: 'error', message: 'only the ManiaFlow UI can drive OS input' }));
      return;
    }
    const reply = (payload) => socket.send(JSON.stringify(payload));
    const id = message.id ?? null;

    try {
      switch (message.type) {
        case 'os-input:detect':
          reply({ type: 'os-input:detect:result', id, payload: await detect() });
          return;
        case 'os-input:arm': {
          const backendId = String(message.backendId || '');
          if (!backendId) throw new Error('backendId is required');
          const info = await runner.arm(backendId);
          reply({ type: 'os-input:arm:result', id, payload: { ok: true, ...info } });
          return;
        }
        case 'os-input:disarm':
          await runner.disarm();
          reply({ type: 'os-input:disarm:result', id, payload: { ok: true } });
          return;
        case 'os-input:press':
        case 'os-input:release': {
          const code = String(message.code || '');
          if (!runner.armed) throw new Error('No OS input backend is armed');
          if (!canSend(runner.backendId, code)) throw new Error(`${runner.backendId} cannot send the key "${code}"`);
          if (message.type === 'os-input:press') await runner.press(code);
          else await runner.release(code);
          reply({ type: 'os-input:key:result', id, payload: { code, down: message.type === 'os-input:press' } });
          return;
        }
        case 'os-input:run':
          // Validated here as well as in the runner: a bad schedule is refused before
          // anything is armed, rather than halfway through pressing keys.
          validateSchedule(message.events);
          reply({ type: 'os-input:run:accepted', id, payload: { count: message.events.length } });
          reply({ type: 'os-input:run:result', id, payload: await runner.run({ events: message.events, leadMs: message.leadMs }) });
          return;
        case 'os-input:stop':
          reply({ type: 'os-input:stop:result', id, payload: await runner.emergencyStop() });
          return;
        default:
          reply({ type: 'error', id, message: `unknown message type: ${message.type}` });
      }
    } catch (err) {
      reply({ type: 'os-input:error', id, message: err.message, name: err.name });
    }
  });

  // Mirror runner lifecycle to every UI tab so they never disagree about whether keys are held.
  for (const event of ['armed', 'disarmed', 'stopped', 'run:start', 'run:end', 'key']) {
    runner.on(event, (payload) => {
      const text = JSON.stringify({ type: `os-input:${event}`, payload });
      for (const client of hub.apps) client.send(text);
    });
  }
  runner.on('error', (err) => {
    const text = JSON.stringify({ type: 'os-input:error', message: err.message });
    for (const client of hub.apps) client.send(text);
  });
  // A bridge that goes away while input is running must not leave keys down.
  hub.on('bridge:disconnected', () => { runner.emergencyStop().catch(() => {}); });

  await new Promise((listening, failed) => {
    server.once('error', failed);
    server.listen(port, host, listening);
  });

  const address = server.address();
  const shown = address.address === '0.0.0.0' || address.address === '::' ? `127.0.0.1:${address.port}` : `${address.address}:${address.port}`;
  log(`ManiaFlow  →  http://${shown}`);
  log(`WebSocket bridge endpoint  →  ws://${shown}/ws`);
  log(`Bridge script (token filled in)  →  http://${shown}/bridge/installed.js`);
  log(`OS input on this machine: ${process.platform} — run detect from Settings → Integration`);

  async function stop(signal) {
    log(`\n${signal || 'stop'} — releasing keys and closing.`);
    try { await runner.emergencyStop(); } catch { /* best effort */ }
    try { await runner.disarm(); } catch { /* best effort */ }
    hub.close();
    wss.close();
    await new Promise((closed) => server.close(closed));
  }

  return { server, hub, runner, wss, token, address, url: `http://${shown}`, stop };
}

/* ── entry point ─────────────────────────────────────────────────────── */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  start().then((handles) => {
    const shutdown = (signal) => handles.stop(signal).then(() => process.exit(0)).catch(() => process.exit(1));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${err.port || process.env.PORT || 4310} is already in use. Start on another one: PORT=${Number(process.env.PORT || 4310) + 1} npm start`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
