/**
 * Integration error handling.
 *
 * The point of these tests is the failure paths, because the success path is easy. Every
 * way the integration can be missing — no server, no bridge, no game object, a game on the
 * wrong screen, a request that never answers — has to produce a specific, actionable
 * message and leave ManiaFlow usable offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeClient, ConnectionState } from '../src/game/bridgeClient.js';
import { AshtonKmaniaAdapter, GAME_SCREENS } from '../src/game/AshtonKmaniaAdapter.js';
import { assess, Level, shortLabel, Link } from '../src/game/IntegrationStatus.js';
import { IntegrationError, InputError, ErrorCode } from '../src/utils/errors.js';
import { FakeWebSocket, installDom } from './helpers/dom-stub.js';

const TOKEN = 'a'.repeat(48);

function pair(options = {}) {
  FakeWebSocket.reset();
  const client = new BridgeClient({ url: 'ws://127.0.0.1:4310/ws', token: TOKEN, WebSocket: FakeWebSocket, ...options });
  const adapter = new AshtonKmaniaAdapter({ client, options: { inputBackend: 'synthetic', requirePractice: true } });
  adapter.attach();
  return { client, adapter };
}

/** The socket a `connect()` call just created — never an earlier test's. */
function lastSocket() {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('no WebSocket was created');
  return socket;
}

/** Drive the fake socket through a successful handshake. */
function handshake(client) {
  client.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket._open();
  socket.simulateMessage({ type: 'hello:ok', role: 'app', clientId: 'c1', hub: { bridgeConnected: false, bridge: null, appClients: 1 } });
  return socket;
}

/** Push a game state through the bridge relay. */
function pushState(socket, payload) {
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:state', payload } });
}

const PLAYING_PRACTICE = {
  available: true, screen: 'gameplay', busy: false, safeMode: false,
  gameplay: { active: true, mode: 'practice', practice: true, auto: false, feed: false, replay: false, multiplayer: false, spectating: false, running: true, keys: 4, rate: 1, mods: [], endTime: 60000, firstNote: 1000, loopA: null, loopB: null, mapOffset: 0, mapId: 'map-1', title: 'T', artist: 'A', version: 'N', od: 5, held: [false, false, false, false], keyLabels: ['D', 'F', 'J', 'K'], windows: null },
  clock: { playing: true, rate: 1, songPosition: 1200, gameTime: 1200, gen: 3, duration: 60000 },
  settings: { audioOffset: 0, inputLatency: 0, practiceSpeed: 1, scrollSpeed: 22 },
};

/* ── status assessment ───────────────────────────────────────────────── */

test('with nothing connected the status is unavailable and every link says why', () => {
  const status = assess({
    server: { state: 'idle', connected: false, lastError: null },
    bridge: { connected: false, info: null, latencyMs: null },
    game: { available: false, screen: null, practice: false },
  });
  assert.equal(status.level, Level.UNAVAILABLE);
  assert.equal(status.label, 'Not connected');
  assert.match(status.detail, /server is not reachable/);
  assert.equal(status.links.length, 4);
  assert.equal(status.links.find((l) => l.id === Link.SERVER).ok, false);
  assert.match(status.links.find((l) => l.id === Link.BRIDGE).detail, /Needs the server first/);
  assert.match(status.links.find((l) => l.id === Link.GAME).detail, /Needs the bridge first/);
  // The OS helper is optional unless that backend is selected, so it is not a failure.
  assert.equal(status.links.find((l) => l.id === Link.OS_INPUT).ok, true);
  assert.equal(status.links.find((l) => l.id === Link.OS_INPUT).optional, true);
  assert.equal(status.capabilities.offline, true, 'imported charts always work');
  assert.equal(status.capabilities.syntheticInput, false);
  assert.equal(shortLabel(status), 'Offline');
});

test('a server error is an error, not merely unavailable', () => {
  const status = assess({
    server: { state: 'error', connected: false, lastError: 'the token was refused' },
    bridge: { connected: false }, game: { available: false },
  });
  assert.equal(status.level, Level.ERROR);
  assert.match(status.links[0].detail, /token was refused/);
});

test('a connected server with no bridge is unavailable and says how to fix it', () => {
  const status = assess({
    server: { state: 'ready', connected: true }, bridge: { connected: false }, game: { available: false },
  });
  assert.equal(status.level, Level.UNAVAILABLE);
  assert.match(status.detail, /No bridge is connected/);
  assert.match(status.links.find((l) => l.id === Link.BRIDGE).detail, /Settings → Integration/);
  assert.equal(status.capabilities.readLibrary, false);
  assert.equal(shortLabel(status), 'Offline');
});

test('a bridge with no game object reports the reason the bridge gave', () => {
  const status = assess({
    server: { connected: true, state: 'ready' },
    bridge: { connected: true, info: { bridgeVersion: '1.0.0' } },
    game: { available: false, reason: 'window.AshtonkMania is not present' },
  });
  assert.equal(status.links.find((l) => l.id === Link.GAME).ok, false);
  assert.match(status.links.find((l) => l.id === Link.GAME).detail, /AshtonkMania is not present/);
  assert.equal(status.capabilities.readState, false);
});

test('a connected game outside practice mode is partial: reads work, input does not', () => {
  const status = assess({
    server: { connected: true, state: 'ready' },
    bridge: { connected: true, info: null, latencyMs: 12 },
    game: { available: true, screen: 'songselect', practice: false, reason: 'Not in practice mode.' },
  });
  assert.equal(status.level, Level.PARTIAL);
  assert.equal(status.screen, 'songselect');
  assert.equal(status.capabilities.readLibrary, true);
  assert.equal(status.capabilities.readChart, true);
  assert.equal(status.capabilities.readKeybinds, true);
  assert.equal(status.capabilities.syntheticInput, false);
  assert.equal(status.capabilities.practiceControls, false);
  assert.match(status.blockingReason, /practice mode/);
  assert.equal(status.latencyMs, 12);
  assert.equal(shortLabel(status), 'Connected · Song select', 'a screen key is shown as the word the game uses');
});

test('practice mode opens the input capability', () => {
  const status = assess({
    server: { connected: true, state: 'ready' }, bridge: { connected: true },
    game: { available: true, screen: 'gameplay', practice: true },
  });
  assert.equal(status.level, Level.OK);
  assert.equal(status.capabilities.syntheticInput, true);
  assert.equal(status.capabilities.practiceControls, true);
  assert.equal(shortLabel(status), 'Practice live');
});

test('selecting the OS backend makes a missing helper a real failure, not an optional one', () => {
  const without = assess({
    server: { connected: true, state: 'ready' }, bridge: { connected: true },
    game: { available: true, screen: 'gameplay', practice: true },
    osInput: { required: false, detected: true, available: false },
  });
  assert.equal(without.level, Level.OK, 'not required, so not a failure');

  const withRequired = assess({
    server: { connected: true, state: 'ready' }, bridge: { connected: true },
    game: { available: true, screen: 'gameplay', practice: true },
    osInput: { required: true, detected: true, available: false, reason: 'xdotool was not found on PATH' },
  });
  assert.equal(withRequired.level, Level.ERROR);
  assert.equal(withRequired.capabilities.osInput, false);
  assert.match(withRequired.links.find((l) => l.id === Link.OS_INPUT).detail, /xdotool/);
});

/* ── the client ──────────────────────────────────────────────────────── */

test('the client authenticates and reports its state at every step', async () => {
  const seen = [];
  const client = new BridgeClient({ url: 'ws://x/ws', token: TOKEN, WebSocket: FakeWebSocket });
  client.on('state', ({ state }) => seen.push(state));

  assert.equal(client.state, ConnectionState.IDLE);
  client.connect();
  assert.equal(client.state, ConnectionState.CONNECTING);

  const socket = lastSocket();
  socket._open();
  assert.equal(client.state, ConnectionState.CONNECTED);
  assert.deepEqual(socket.lastSent, { type: 'hello', role: 'app', token: TOKEN });

  socket.simulateMessage({ type: 'hello:ok', clientId: 'c9', hub: { bridgeConnected: false, bridge: null, appClients: 1 } });
  assert.equal(client.state, ConnectionState.READY);
  assert.equal(client.clientId, 'c9');
  assert.equal(client.isConnected, true);
  assert.deepEqual(seen, ['connecting', 'connected', 'ready']);

  // With no bridge connected, the server refuses the relay and says so; the client turns
  // that into a typed error rather than waiting for a reply that will never come.
  const pending = client.requestBridge('library');
  const sent = socket.sent.find((m) => m.type === 'relay');
  socket.simulateMessage({ type: 'relay:error', message: 'no bridge is connected', replyTo: sent.id });
  await assert.rejects(() => pending, (err) => {
    assert.ok(err instanceof IntegrationError);
    assert.equal(err.code, ErrorCode.BRIDGE_UNAVAILABLE);
    assert.match(err.message, /no bridge is connected/i);
    return true;
  });
  client.dispose();
  assert.equal(client.state, ConnectionState.CLOSED);
});

test('a refused token is reported with the reason the server gave', async () => {
  const client = new BridgeClient({ url: 'ws://x/ws', token: 'wrong', WebSocket: FakeWebSocket });
  const errors = [];
  client.on('error', (err) => errors.push(err));
  client.connect();
  const socket = lastSocket();
  socket._open();
  socket.simulateMessage({ type: 'hello:error', message: 'Bridge token mismatch. Copy the current token from ManiaFlow → Settings → Integration.' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof IntegrationError);
  assert.equal(errors[0].code, ErrorCode.BRIDGE_REFUSED);
  assert.match(errors[0].message, /Settings → Integration/);
  client.dispose();
});

test('a request that never answers times out instead of hanging forever', async () => {
  // The client floors the timeout at 500ms: a shorter one would fire before a healthy
  // bridge could answer, so asking for 60 gets 500 and the message says which.
  const client = new BridgeClient({ url: 'ws://x/ws', token: TOKEN, WebSocket: FakeWebSocket, requestTimeoutMs: 60 });
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: { bridgeVersion: '1.0.0' }, appClients: 1 } });

  await assert.rejects(
    () => client.requestBridge('library'),
    (err) => {
      assert.ok(err instanceof IntegrationError);
      assert.equal(err.code, ErrorCode.BRIDGE_TIMEOUT);
      assert.match(err.message, /No reply within 500 ms/);
      assert.match(err.message, /library/, 'the message names the request that timed out');
      return true;
    },
  );
  assert.equal(client.describe().pendingRequests, 0, 'a timed-out request is dropped, not left pending');
  client.dispose();
});

test('a dropped connection rejects everything in flight and reconnects', async () => {
  const client = new BridgeClient({ url: 'ws://x/ws', token: TOKEN, WebSocket: FakeWebSocket, requestTimeoutMs: 5000 });
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });

  const pending = client.requestBridge('library');
  socket.simulateClose(1006, 'gone');
  await assert.rejects(() => pending, (err) => {
    assert.equal(err.code, ErrorCode.BRIDGE_UNAVAILABLE);
    assert.match(err.message, /closed \(1006\): gone/);
    return true;
  });
  assert.equal(client.state, ConnectionState.RECONNECTING);
  client.dispose();
});

test('a reply that says the request failed becomes a typed error', async () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });
  pushState(socket, PLAYING_PRACTICE);

  const pending = client.request({ type: 'relay', to: 'bridge', message: { type: 'mf:request', kind: 'chart', args: { mapId: 'nope' } } });
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:result', id: pending.id, ok: false, kind: 'chart', error: 'No chart with id nope' } });
  // The id is assigned inside request(), so correlate on the sent message instead.
  const sent = socket.sent.find((m) => m.type === 'relay' && m.message?.kind === 'chart');
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:result', id: sent.id, ok: false, kind: 'chart', error: 'No chart with id nope' } });
  await assert.rejects(() => pending, (err) => {
    assert.ok(err instanceof IntegrationError);
    assert.match(err.message, /No chart with id nope/);
    return true;
  });
  void adapter;
  client.dispose();
});

test('a gate refusal is distinguished from any other failure', async () => {
  const { client } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });
  const pending = client.request({ type: 'relay', to: 'bridge', message: { type: 'mf:input:run', events: [] } });
  const sent = socket.sent.find((m) => m.message?.type === 'mf:input:run');
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:result', id: sent.id, ok: false, kind: 'input:run', code: 'gate-refused', error: 'Not in practice mode.' } });
  await assert.rejects(() => pending, (err) => {
    assert.equal(err.code, ErrorCode.INPUT_GATE_REFUSED, 'the UI branches on this code');
    return true;
  });
  client.dispose();
});

test('a browser with no WebSocket reports that plainly', () => {
  const client = new BridgeClient({ url: 'ws://x/ws', token: TOKEN, WebSocket: null });
  const errors = [];
  client.on('error', (e) => errors.push(e));
  client.connect();
  assert.equal(client.state, ConnectionState.ERROR);
  assert.match(errors[0].message, /no WebSocket support/);
  assert.equal(errors[0].code, ErrorCode.BRIDGE_UNAVAILABLE);
  client.dispose();
});

/* ── the adapter ─────────────────────────────────────────────────────── */

test('every game-dependent method refuses with a reason when there is no server', async () => {
  const { client, adapter } = pair();
  const noServer = /ManiaFlow server is not connected/i;
  for (const call of [
    () => adapter.readState(),
    () => adapter.readLibrary(),
    () => adapter.loadChart('map-1'),
    () => adapter.practice.seek(1000),
    () => adapter.practice.speed(1.5),
    () => adapter.practice.loop('clear'),
    () => adapter.input.stop(),
  ]) {
    await assert.rejects(call, (err) => {
      assert.ok(err instanceof IntegrationError);
      assert.equal(err.code, ErrorCode.BRIDGE_UNAVAILABLE);
      assert.match(err.message, noServer);
      return true;
    });
  }

  // The gate answers locally rather than throwing, because a caller needs a verdict.
  const verdict = await adapter.checkGate();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.local, true);
  assert.match(verdict.reason, /No bridge is connected/);

  client.dispose();
  adapter.dispose();
});

test('a connected server with no bridge says how to install one', async () => {
  const { client, adapter } = pair();
  handshake(client);
  const noBridge = /no bridge is running inside the game/i;
  await assert.rejects(() => adapter.readLibrary(), (err) => {
    assert.match(err.message, noBridge);
    assert.match(err.message, /Settings → Integration/, 'the message says what to do about it');
    return true;
  });
  await assert.rejects(() => adapter.loadChart('map-1'), noBridge);
  client.dispose();
  adapter.dispose();
});

test('a game state is normalised, so an unexpected payload cannot break the UI', () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: { bridgeVersion: '1.0.0' }, appClients: 1 } });

  pushState(socket, { available: true, screen: 'gameplay', gameplay: { active: true, practice: 'yes', keys: '4', rate: null, mods: 'AT', held: null, windows: 'nope' }, clock: { songPosition: 'x' }, settings: null });
  const state = adapter.gameState;
  assert.equal(state.gameplay.practice, true, 'a truthy string becomes a boolean');
  assert.equal(state.gameplay.keys, 4, 'a numeric string becomes a number');
  assert.equal(state.gameplay.rate, 1, 'a null rate falls back');
  assert.deepEqual(state.gameplay.mods, [], 'a non-array mods field becomes an empty array');
  assert.deepEqual(state.gameplay.held, []);
  assert.equal(state.gameplay.windows, null, 'a non-object windows field is dropped');
  assert.equal(state.clock.songPosition, null, 'an unreadable position is null, not NaN');
  assert.deepEqual(state.settings, {});
  assert.equal(state.screenLabel, GAME_SCREENS.gameplay, 'a screen key becomes the word the game uses');

  pushState(socket, null);
  assert.equal(adapter.gameState.available, false);
  pushState(socket, { available: false, reason: 'still loading' });
  assert.equal(adapter.gameState.reason, 'still loading');

  client.dispose();
  adapter.dispose();
});

test('the local gate refuses each non-practice state with the game\'s own reason', () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });

  const cases = [
    [{ active: false }, /No gameplay session/],
    [{ active: true, auto: true }, /game's own Auto/],
    [{ active: true, feed: true }, /feeding a replay or Auto/],
    [{ active: true, replay: true }, /replay is playing/],
    [{ active: true, multiplayer: true }, /Multiplayer/],
    [{ active: true, spectating: true }, /Spectating/],
    [{ active: true, practice: false }, /Not in practice mode/],
    [{ active: true, practice: true, running: false }, /paused/],
  ];
  for (const [gameplay, pattern] of cases) {
    pushState(socket, { ...PLAYING_PRACTICE, gameplay: { ...PLAYING_PRACTICE.gameplay, ...gameplay } });
    const verdict = adapter.localGate();
    assert.equal(verdict.ok, false, JSON.stringify(gameplay));
    assert.match(verdict.reason, pattern, JSON.stringify(gameplay));
  }

  pushState(socket, PLAYING_PRACTICE);
  assert.equal(adapter.localGate().ok, true, 'practice, running, nothing else active: the gate opens');
  client.dispose();
  adapter.dispose();
});

test('the gate refuses to run alongside the game\'s own autoplay', () => {
  // Section 18: ManiaFlow must not use the built-in Auto. If the game is already feeding
  // itself, running a second input path on top would be both wrong and unmeasurable.
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });
  pushState(socket, { ...PLAYING_PRACTICE, gameplay: { ...PLAYING_PRACTICE.gameplay, practice: true, auto: true, feed: true, mods: ['AT'] } });
  const verdict = adapter.localGate();
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Auto/);
  assert.equal(adapter.status.capabilities.syntheticInput, false);
  client.dispose();
  adapter.dispose();
});

test('a library record from the game keeps only the fields ManiaFlow displays', () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });

  const sent = [];
  const pending = adapter.readLibrary();
  const request = socket.sent.find((m) => m.message?.kind === 'library');
  socket.simulateMessage({
    type: 'relay', from: 'bridge',
    message: {
      type: 'bridge:result', id: request.id, ok: true, kind: 'library',
      payload: {
        maps: [{
          id: 'map-1', hash: 'h', setId: 9, title: 'Song', artist: 'Artist', creator: 'Mapper', version: 'Insane',
          mode: 3, keys: 7, od: 8, hp: 7, stars: 5.43, bpm: 180, length: 130000, objectCount: 2100, lnCount: 300,
          nps: 16.2, added: 1700000000000, problems: [], warnings: ['Missing background'],
          // Fields the game holds that ManiaFlow must not carry around by reference.
          liveObject: { mutable: true }, aFunction: () => 1, deeplyNested: { a: { b: { c: 1 } } },
        }],
        sets: [{ id: 9, title: 'Song' }],
      },
    },
  });
  void sent;

  return pending.then((records) => {
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.id, 'map-1');
    assert.equal(record.stars, 5.43, 'the game’s star rating is carried through untouched');
    assert.equal(record.source, 'bridge');
    assert.equal(record.previewable, true);
    assert.deepEqual(record.warnings, ['Missing background']);
    assert.equal(record.liveObject, undefined, 'an unexpected field is not copied');
    assert.equal(record.aFunction, undefined);
    assert.equal(record.chart, null, 'notes are not loaded until the chart is opened');
    assert.deepEqual(record.notes, []);
    assert.equal(adapter.library.length, 1);
    assert.equal(adapter.libraryError, null);
    client.dispose();
    adapter.dispose();
  });
});

test('a library error from the bridge is surfaced, not swallowed', async () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });

  const pending = adapter.readLibrary();
  const request = socket.sent.find((m) => m.message?.kind === 'library');
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:result', id: request.id, ok: true, kind: 'library', payload: { error: 'BeatmapManager is unavailable' } } });

  await assert.rejects(() => pending, (err) => {
    assert.ok(err instanceof IntegrationError);
    assert.match(err.message, /BeatmapManager is unavailable/);
    return true;
  });
  assert.equal(adapter.libraryError, 'BeatmapManager is unavailable');
  assert.deepEqual(adapter.library, []);
  client.dispose();
  adapter.dispose();
});

test('keybinds come from the game when it is connected and fall back to its defaults when not', async () => {
  const { client, adapter } = pair();
  const offline = await adapter.keybindsFor(4);
  assert.deepEqual(offline.bindings, [['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK']], 'the game’s documented 4K defaults');
  assert.equal(offline.origin, 'default');

  const seven = await adapter.keybindsFor(7);
  assert.deepEqual(seven.bindings[3], ['Space'], 'the 7K default has Space in the middle');
  assert.equal(seven.bindings.length, 7);

  // A wrongly sized override is ignored rather than half-applied. Checked while offline so
  // the fallback is exercised directly instead of waiting on a bridge round trip.
  const badOverride = await adapter.keybindsFor(4, [['KeyQ']]);
  assert.equal(badOverride.origin, 'default');
  assert.deepEqual(badOverride.bindings, [['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK']]);

  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });
  const pending = adapter.keybindsFor(4);
  const request = socket.sent.find((m) => m.message?.kind === 'keybinds');
  socket.simulateMessage({ type: 'relay', from: 'bridge', message: { type: 'bridge:result', id: request.id, ok: true, kind: 'keybinds', payload: { keys: 4, bindings: [['KeyV'], ['KeyB'], ['KeyN'], ['KeyM']] } } });
  const fromGame = await pending;
  assert.deepEqual(fromGame.bindings, [['KeyV'], ['KeyB'], ['KeyN'], ['KeyM']], 'the player’s own binds win');
  assert.equal(fromGame.origin, 'game');

  // A local override wins over both.
  const override = await adapter.keybindsFor(4, [['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR']]);
  assert.deepEqual(override, [['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR']]);
  client.dispose();
  adapter.dispose();
});

test('a bridge that reports the game missing is reflected in the status', async () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: { bridgeVersion: '1.0.0' }, appClients: 1 } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(adapter.status.links.find((l) => l.id === Link.GAME).ok, false);

  pushState(socket, PLAYING_PRACTICE);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(adapter.status.capabilities.syntheticInput, true);

  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: false, bridge: null, appClients: 1 } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(adapter.gameState, null, 'losing the bridge drops the state rather than keeping a stale one');
  assert.equal(adapter.status.capabilities.syntheticInput, false);

  client.dispose();
  adapter.dispose();
});

test('diagnostics describe the whole integration in one serialisable object', () => {
  const { client, adapter } = pair();
  handshake(client);
  const diagnostics = adapter.diagnostics();
  for (const key of ['client', 'status', 'game', 'library', 'osDetect', 'osArmed', 'inputBackend', 'screens']) {
    assert.ok(key in diagnostics, `diagnostics include ${key}`);
  }
  assert.equal(diagnostics.inputBackend.id, 'synthetic');
  assert.equal(diagnostics.inputBackend.trusted, false, 'synthetic input is reported as not hardware-equivalent');
  assert.ok(JSON.stringify(diagnostics), 'and the whole thing serialises for the diagnostics dialog');
  client.dispose();
  adapter.dispose();
});

test('attaching twice does not double the listeners', () => {
  const { client, adapter } = pair();
  adapter.attach();
  adapter.attach();
  const socket = handshake(client);
  socket.simulateMessage({ type: 'bridge:status', payload: { bridgeConnected: true, bridge: {}, appClients: 1 } });
  let events = 0;
  adapter.on('state', () => events++);
  pushState(socket, PLAYING_PRACTICE);
  assert.equal(events, 1, 'one state push produces one event');
  client.dispose();
  adapter.dispose();
});

test('disposing the adapter stops it reacting to anything', async () => {
  const { client, adapter } = pair();
  const socket = handshake(client);
  adapter.dispose();
  let events = 0;
  adapter.on('state', () => events++);
  pushState(socket, PLAYING_PRACTICE);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events, 0);
  client.dispose();
});

test('input validation rejects a malformed schedule before anything is armed', async () => {
  const { client, adapter } = pair();
  handshake(client);
  await assert.rejects(
    () => adapter.input.run([[0, 'KeyD']]),
    (err) => err instanceof InputError && err.code === ErrorCode.VALIDATION,
  );
  await assert.rejects(
    () => adapter.input.run('not a schedule'),
    (err) => err instanceof InputError,
  );
  client.dispose();
  adapter.dispose();
});

test('the DOM stub reports synthetic events as untrusted, as a browser does', () => {
  // This is the fact the UI states rather than glosses over: a constructed KeyboardEvent is
  // never isTrusted, and ManiaFlow does not claim otherwise.
  const dom = installDom();
  try {
    const event = new dom.window.KeyboardEvent('keydown', { code: 'KeyD', bubbles: true });
    assert.equal(event.isTrusted, false);
    assert.equal(event.code, 'KeyD');
    assert.equal(event.repeat, false, 'the game ignores auto-repeat, so the bridge never sets it');
  } finally {
    dom.uninstall();
  }
});
