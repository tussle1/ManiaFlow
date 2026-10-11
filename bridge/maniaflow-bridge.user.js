// ==UserScript==
// @name         ManiaFlow Bridge
// @namespace    https://github.com/tussle1/ManiaFlow
// @version      1.0.0
// @description  Connects Ashtonk!mania to a locally running ManiaFlow instance. Read-only state relay plus a practice-only raw keyboard input path. It never enables the game's Auto mod and never touches its internal autoplay.
// @author       ManiaFlow
// @match        https://ashtonkmania.vercel.app/*
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * ManiaFlow Bridge — the script that runs *inside* the Ashtonk!mania page.
 *
 * Why it exists: ManiaFlow is served from 127.0.0.1 and the game from
 * ashtonkmania.vercel.app. That is a cross-origin boundary; no amount of cleverness in
 * ManiaFlow can read `window.AshtonkMania` across it. This script is the only supported
 * way in, and it is installed by the user, on purpose, into their own browser.
 *
 * Install: open ManiaFlow → Settings → Integration → copy the script, then paste it into a
 * userscript manager (Tampermonkey, Violentmonkey) or into the game page's DevTools
 * console. The copy served at `/bridge/installed.js` already contains this machine's token.
 *
 * What it does
 *   1. Connects to the local ManiaFlow WebSocket and presents the bridge token.
 *   2. Relays read-only game state: screen, library, the loaded chart, keybinds, clock.
 *   3. Runs an input schedule by dispatching real `KeyboardEvent`s on `window`, which is
 *      where the game listens (capture phase) and which it resolves by `event.code`.
 *
 * What it refuses to do
 *   - It never sets the `AT` (Auto) mod, never calls `generateAutoInputs`, and never
 *     assigns to `state.feed`. The game's own autoplay is not used, per specification.
 *   - It will not dispatch input unless the game reports its own practice mode
 *     (`GameplayScreen.s.practice === true`), and not during multiplayer or spectating.
 *     Practice mode never records input events and is never submitted for score
 *     verification, so a practice session cannot become a ranked score.
 *
 * Honesty about synthetic input: events created here have `isTrusted === false`. The game
 * does not check that flag, so they are accepted — but they are not hardware key events,
 * and ManiaFlow's UI says so rather than implying otherwise.
 */
(function maniaFlowBridge() {
  'use strict';

  if (window.__maniaflowBridge) {
    console.warn('[ManiaFlow] bridge already running — ignoring the second copy.');
    return;
  }

  // Filled in by the ManiaFlow server when this file is served from /bridge/installed.js.
  const TOKEN = '__MANIAFLOW_TOKEN__';
  const WS_URL = '__MANIAFLOW_WS__';
  const BRIDGE_VERSION = '1.0.0';

  const DEFAULT_WS = 'ws://127.0.0.1:4310/ws';
  const wsUrl = WS_URL.startsWith('ws') ? WS_URL : DEFAULT_WS;
  const token = /^[0-9a-f]{16,}$/.test(TOKEN) ? TOKEN : null;

  const log = (...args) => console.info('[ManiaFlow]', ...args);
  const warn = (...args) => console.warn('[ManiaFlow]', ...args);

  if (!token) {
    warn('No bridge token is embedded in this copy. Load it from',
      'http://127.0.0.1:4310/bridge/installed.js (ManiaFlow → Settings → Integration) so it can authenticate.');
  }

  /* ───────────────────────── game access ───────────────────────── */

  /** The single supported integration surface, verified against the game's own source. */
  function game() {
    const g = window.AshtonkMania;
    return g && typeof g === 'object' ? g : null;
  }

  function gameVersion() {
    const g = game();
    if (!g) return null;
    return g.App?.version || g.App?.VERSION || null;
  }

  /** Read-only snapshot of where the game is right now. Never mutates game state. */
  function readState() {
    const g = game();
    if (!g) return { available: false, reason: 'window.AshtonkMania is not present' };

    const screens = g.Screens;
    const gp = g.GameplayScreen;
    const s = gp && gp.s;
    const music = g.Music;

    let songPosition = null;
    let gameTime = null;
    try {
      if (music) songPosition = typeof music.timeAt === 'function' ? music.timeAt() : null;
      if (typeof gp?.gameTime === 'function' && s) gameTime = gp.gameTime();
    } catch (err) {
      warn('could not read the clock:', err.message);
    }

    return {
      available: true,
      screen: screens?.currentName ?? null,
      busy: !!screens?.busy,
      safeMode: !!g.SafeMode?.on,
      gameplay: s ? {
        active: true,
        mode: s.mode,
        practice: !!s.practice,
        auto: !!s.auto,
        feed: !!s.feed,
        replay: !!s.replay,
        multiplayer: !!s.mp,
        spectating: !!s.spectate,
        running: !!s.running,
        finished: !!s.finished,
        failed: !!s.failed,
        keys: s.keys,
        rate: s.rate,
        mods: Array.isArray(s.mods) ? [...s.mods] : [],
        endTime: s.endTime,
        firstNote: s.firstNote,
        loopA: s.loopA,
        loopB: s.loopB,
        mapOffset: s.mapOffset ?? 0,
        mapId: s.rec?.id ?? null,
        mapHash: s.rec?.hash ?? null,
        title: s.bm?.metadata?.Title ?? null,
        artist: s.bm?.metadata?.Artist ?? null,
        version: s.bm?.metadata?.Version ?? null,
        od: s.bm?.od ?? null,
        held: Array.isArray(s.held) ? [...s.held] : [],
        keyLabels: Array.isArray(s.keyLabels) ? [...s.keyLabels] : [],
        // Read-only view of the timing windows the game itself computed.
        windows: s.windows ? JSON.parse(JSON.stringify(s.windows)) : null,
      } : { active: false },
      clock: {
        playing: !!music?.playing,
        rate: music?.rate ?? 1,
        songPosition,
        gameTime,
        gen: music?.gen ?? 0,
        duration: music?.duration ?? 0,
      },
      settings: readSettings(g),
    };
  }

  function readSettings(g) {
    const get = (key) => { try { return g.Settings?.get(key); } catch { return null; } };
    return {
      audioOffset: get('audio.offset'),
      inputLatency: get('input.latency'),
      practiceSpeed: get('practice.speed'),
      scrollSpeed: get('gameplay.scrollSpeed'),
      scrollDirection: get('gameplay.scrollDirection'),
      preservePitch: get('audio.preservePitch'),
      judgementMode: get('gameplay.judgementMode'),
      safeMode: get('online.safeMode'),
    };
  }

  /** Lane → key-code mapping exactly as the game resolves it. */
  function readKeybinds(keys) {
    const g = game();
    if (!g || typeof keys !== 'number' || keys < 1) return null;
    try {
      const binds = g.Settings.keybinds(keys);
      return { keys, bindings: binds.map((codes) => [...codes]) };
    } catch (err) {
      warn('could not read keybinds:', err.message);
      return null;
    }
  }

  /** The chart library, mapped onto ManiaFlow's own record shape. */
  async function readLibrary() {
    const g = game();
    if (!g?.BeatmapManager) return { maps: [], sets: [], error: 'BeatmapManager is unavailable' };
    const bm = g.BeatmapManager;
    const maps = [];
    try {
      for (const record of (bm.maps || new Map()).values()) maps.push(pickMapRecord(record));
    } catch (err) {
      return { maps: [], sets: [], error: err.message };
    }
    const sets = [];
    try {
      for (const set of (bm.setById || new Map()).values()) {
        sets.push({
          id: set.id, title: set.title ?? null, artist: set.artist ?? null,
          creator: set.creator ?? null, added: set.added ?? null,
          mapCount: Array.isArray(set.maps) ? set.maps.length : (set.mapIds?.length ?? 0),
        });
      }
    } catch { /* sets are a convenience; the map list is the real payload */ }
    maps.sort((a, b) => (b.added || 0) - (a.added || 0));
    return { maps, sets };
  }

  // Only the fields ManiaFlow displays, copied out so a live record is never sent by reference.
  const MAP_FIELDS = ['id', 'hash', 'setId', 'onlineId', 'title', 'titleUnicode', 'artist',
    'artistUnicode', 'creator', 'version', 'source', 'tags', 'osuPath', 'audioFile',
    'previewTime', 'mode', 'keys', 'od', 'hp', 'problems', 'warnings', 'breaks', 'added',
    'stars', 'bpm', 'bpmMin', 'bpmMax', 'length', 'drainLength', 'noteCount', 'lnCount',
    'objectCount', 'lnRatio', 'nps', 'firstNote', 'lastNote'];

  function pickMapRecord(record) {
    const out = {};
    for (const field of MAP_FIELDS) if (record[field] !== undefined) out[field] = record[field];
    return out;
  }

  /** A single chart: its .osu text and normalised notes, read through the game's own parser. */
  async function readChart(mapId) {
    const g = game();
    if (!g?.BeatmapManager) throw new Error('BeatmapManager is unavailable');
    const record = g.BeatmapManager.maps.get(mapId);
    if (!record) throw new Error(`No chart with id ${mapId}`);

    let osuText = null;
    try {
      const loaded = await g.BeatmapManager.load(mapId);
      osuText = typeof loaded?.osuText === 'string' ? loaded.osuText
        : typeof loaded?.text === 'string' ? loaded.text : null;
    } catch (err) {
      warn('could not read the .osu text:', err.message);
    }
    if (osuText == null) {
      try {
        const raw = await g.BeatmapManager.getFile(record.setId, record.osuPath);
        if (typeof raw === 'string') osuText = raw;
        else if (raw instanceof ArrayBuffer) osuText = new TextDecoder().decode(raw);
        else if (raw instanceof Blob) osuText = await raw.text();
      } catch (err) {
        warn('could not fetch the chart file:', err.message);
      }
    }

    return { map: pickMapRecord(record), osuText };
  }

  /* ─────────────────── practice-mode safety gate ─────────────────── */

  /**
   * The input path is armed only inside the game's own practice mode.
   * Returns `{ ok: true }` or `{ ok: false, reason }` — the reason is shown in ManiaFlow
   * verbatim, so a refusal is never mysterious.
   */
  function checkInputGate() {
    const g = game();
    if (!g) return { ok: false, reason: 'window.AshtonkMania is not present' };
    if (g.Screens?.currentName !== 'gameplay') {
      return { ok: false, reason: `The game is on "${g.Screens?.currentName || 'unknown'}", not gameplay` };
    }
    const s = g.GameplayScreen?.s;
    if (!s) return { ok: false, reason: 'No gameplay session is loaded' };
    if (s.auto || s.feed) {
      return { ok: false, reason: 'The game\'s own Auto/feed is active — ManiaFlow will not run alongside it' };
    }
    if (s.replay) return { ok: false, reason: 'A replay is playing; input is not accepted' };
    if (s.mp) return { ok: false, reason: 'Multiplayer is active — automated input is not permitted' };
    if (s.spectate) return { ok: false, reason: 'Spectating — automated input is not permitted' };
    if (!s.practice) {
      return {
        ok: false,
        reason: 'Not in practice mode. Start practice in the game (song select → Practice, or F4). '
          + 'A scored play is verified server-side and perfect-timing input would be rejected as inhuman.',
      };
    }
    if (!s.running) return { ok: false, reason: 'The practice session is paused' };
    return { ok: true, keys: s.keys, mode: s.mode };
  }

  /* ─────────────────────── keyboard dispatch ─────────────────────── */

  const downCodes = new Set();

  function keyEvent(code, down) {
    // `code` is what the game resolves (`s.keyMap.get(e.code)`); `key` is only cosmetic.
    return new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code, key: keyNameFor(code), bubbles: true, cancelable: true, repeat: false,
      // The game reads `event.timeStamp` to judge a hit, and the browser stamps a
      // constructed event with the dispatch time — so dispatch accuracy *is* timing accuracy.
    });
  }

  function keyNameFor(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    return ({ Space: ' ', Enter: 'Enter', Semicolon: ';', Comma: ',', Period: '.', Slash: '/',
      Minus: '-', Equal: '=', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace' })[code] || code;
  }

  function dispatch(code, down) {
    if (down) {
      if (downCodes.has(code)) return false; // already down: a duplicate would confuse the game's per-column Set
      downCodes.add(code);
    } else if (!downCodes.delete(code)) {
      return false; // never went down
    }
    window.dispatchEvent(keyEvent(code, down));
    return true;
  }

  /** Let every key go. Runs on stop, on refusal, on disconnect and on page hide/unload. */
  function releaseAll(reason) {
    const released = [...downCodes];
    downCodes.clear();
    for (const code of released) {
      try { window.dispatchEvent(keyEvent(code, false)); } catch { /* best effort */ }
    }
    if (released.length) log(`released ${released.length} key(s)${reason ? ` — ${reason}` : ''}`);
    return released;
  }

  /* ─────────────────────── the input scheduler ───────────────────────
   * Events are `[milliseconds after the anchor, code, down]`.
   *
   * Anchors:
   *   'songPosition' (default, gameplay) — the anchor is when the game's own audio clock
   *       reaches `atSongMs`. Because `Music.timeAt()` is linear in performance time, the
   *       wall-clock start is derived once from the audio clock and the schedule inherits
   *       the audio's accuracy instead of the timer's.
   *   'now' — `performance.now() + leadMs`.
   *
   * Waiting: a coarse `setTimeout` until ~12 ms before the target, then a MessageChannel
   * task loop. Message tasks are not subject to the 4 ms nested-timer clamp and still yield
   * to the event loop, so the game keeps rendering while we wait for the millisecond.
   */

  const scheduler = {
    timer: 0,
    channel: null,
    cancelled: true,
    stats: null,

    _fineLoop(run) {
      if (this.channel) { this.channel.port1.onmessage = null; this.channel.port2.close?.(); }
      const channel = new MessageChannel();
      this.channel = channel;
      channel.port1.onmessage = () => {
        if (run.cancelled) return;
        if (run.step()) channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    },

    start({ events, anchor = 'songPosition', atSongMs = 0, leadMs = 250 }, onEvent, onEnd) {
      this.stop('restarted');
      const gate = checkInputGate();
      if (!gate.ok) { onEnd({ ok: false, reason: gate.reason, executed: 0 }); return; }

      const list = events.map(([delay, code, down]) => [Number(delay), String(code), down ? 1 : 0])
        .sort((a, b) => a[0] - b[0]);

      const run = { cancelled: false, index: 0, startPerf: 0, drifts: [] };
      this.cancelled = false;

      const begin = () => {
        if (run.cancelled) return;
        run.startPerf = performance.now();
        this.stats = run;
        const tick = () => {
          if (run.cancelled) return false;
          const now = performance.now();
          let dispatched = false;
          while (run.index < list.length) {
            const [delay, code, down] = list[run.index];
            const target = run.startPerf + delay;
            if (target > now) break;
            run.drifts.push(now - target);
            try { dispatch(code, !!down); onEvent?.({ code, down: !!down, delay, drift: now - target }); }
            catch (err) { warn('dispatch failed:', err.message); }
            run.index++;
            dispatched = true;
          }
          if (run.index >= list.length) { this._finish(run, onEnd, list.length); return false; }
          return dispatched || true;
        };
        run.step = () => {
          const next = list[run.index];
          if (!next) { this._finish(run, onEnd, list.length); return false; }
          const remaining = run.startPerf + next[0] - performance.now();
          if (remaining > 12) {
            // Back to a coarse timer; the fine loop resumes closer to the target.
            this.timer = setTimeout(() => { if (!run.cancelled) this._fineLoop(run); }, Math.max(0, remaining - 12));
            return false;
          }
          return tick();
        };
        this._fineLoop(run);
      };

      if (anchor === 'songPosition') {
        const startPerf = songTimeToPerf(atSongMs);
        if (startPerf == null) { onEnd({ ok: false, reason: 'The game clock is not running, so a song-position anchor is impossible', executed: 0 }); return; }
        const wait = startPerf - performance.now();
        log(`input anchored to song position ${atSongMs.toFixed(1)} ms — starts in ${wait.toFixed(0)} ms`);
        if (wait <= 0) begin();
        else this.timer = setTimeout(begin, Math.max(0, wait - 4));
      } else {
        this.timer = setTimeout(begin, Math.max(0, leadMs));
      }
    },

    _finish(run, onEnd, planned) {
      if (run.finished) return;
      run.finished = true;
      const drifts = run.drifts.slice().sort((a, b) => a - b);
      onEnd({
        ok: true, planned, executed: run.index,
        timing: {
          count: drifts.length,
          meanMs: mean(drifts),
          medianMs: drifts.length ? drifts[drifts.length >> 1] : 0,
          p95Ms: drifts.length ? drifts[Math.min(drifts.length - 1, Math.round(0.95 * (drifts.length - 1)))] : 0,
          maxMs: drifts.length ? drifts[drifts.length - 1] : 0,
        },
      });
      this.stats = null;
    },

    stop(reason) {
      this.cancelled = true;
      clearTimeout(this.timer);
      if (this.channel) { this.channel.port1.onmessage = null; this.channel = null; }
      if (this.stats) { this.stats.cancelled = true; this.stats = null; }
      const released = releaseAll(reason);
      return released;
    },
  };

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Invert the game's audio clock: which performance.now() will hear song position `songMs`?
   * `Music.timeAt(perf) = startPos + (AudioManager.now(perf) - startCtx) * 1000 * rate`,
   * and `AudioManager.now` tracks performance time, so the mapping is affine.
   */
  function songTimeToPerf(songMs) {
    const g = game();
    const music = g?.Music;
    const gp = g?.GameplayScreen;
    if (!music || !music.playing || typeof music.timeAt !== 'function') return null;
    const perfA = performance.now();
    const songA = typeof gp?.gameTime === 'function' && gp.s ? gp.gameTime(perfA) : music.timeAt(perfA);
    const probe = perfA + 50;
    const songB = typeof gp?.gameTime === 'function' && gp.s ? gp.gameTime(probe) : music.timeAt(probe);
    const slope = (songB - songA) / (probe - perfA); // ≈ playback rate
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-6) return null;
    return perfA + (songMs - songA) / slope;
  }

  /* ─────────────────── game commands (explicit, narrow) ─────────────────── */

  async function runCommand(kind, args = {}) {
    const g = game();
    if (!g) throw new Error('window.AshtonkMania is not present');
    const gp = g.GameplayScreen;
    switch (kind) {
      case 'state': return readState();
      case 'keybinds': return readKeybinds(Number(args.keys) || gp?.s?.keys || 4);
      case 'library': return await readLibrary();
      case 'chart': return await readChart(String(args.mapId));
      case 'gate': return checkInputGate();
      // Practice-only controls. Each one is a public method of the game's own practice mode.
      case 'practice.seek':
        requirePractice(gp);
        gp.practiceSeek(Number(args.time) || 0);
        return { ok: true };
      case 'practice.speed':
        requirePractice(gp);
        await gp.practiceSpeed(Number(args.speed) || 1);
        return { ok: true };
      case 'practice.loop':
        requirePractice(gp);
        gp.setLoop(String(args.which || 'clear'));
        return { ok: true };
      case 'practice.restart':
        requirePractice(gp);
        gp.restartSection();
        return { ok: true };
      case 'releaseAll':
        return { released: releaseAll('commanded') };
      default:
        throw new Error(`Unknown command: ${kind}`);
    }
  }

  function requirePractice(gp) {
    if (!gp?.s?.practice) throw new Error('Practice-mode controls need the game to be in practice mode');
  }

  /* ───────────────────────── the connection ───────────────────────── */

  let socket = null;
  let pollTimer = 0;
  let pollHz = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = 0;
  let disposed = false;

  function connect() {
    if (disposed) return;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      warn('could not open the WebSocket:', err.message);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      send({ type: 'hello', role: 'bridge', token, info: {
        bridgeVersion: BRIDGE_VERSION, gameVersion: gameVersion(), url: location.href,
        origin: location.origin, userAgent: navigator.userAgent,
        capabilities: capabilities(),
      } });
      log('connected to', wsUrl);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'hello:error') { warn(message.message); return; }
      if (message.type !== 'relay') return;
      handle(message.message).catch((err) => {
        warn('handler failed:', err.message);
        send({ type: 'bridge:error', message: err.message });
      });
    });

    socket.addEventListener('close', () => {
      socket = null;
      scheduler.stop('connection closed');
      stopPolling();
      scheduleReconnect();
    });
    socket.addEventListener('error', () => { /* the close handler reports and reconnects */ });
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    // Exponential backoff capped at 15 s: a closed ManiaFlow should not be hammered.
    const delay = Math.min(15000, 500 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = 0; connect(); }, delay);
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function capabilities() {
    const g = game();
    const list = ['state', 'library', 'chart', 'keybinds', 'gate', 'input:synthetic', 'practice:controls'];
    if (g?.BeatmapManager?.maps?.size) list.push('library:populated');
    if (typeof g?.Music?.timeAt === 'function') list.push('clock:audio');
    return list;
  }

  async function handle(message) {
    if (!message || typeof message.type !== 'string') return;
    const id = message.id ?? null;

    switch (message.type) {
      case 'mf:hello':
        send({ type: 'bridge:hello', id, payload: { bridgeVersion: BRIDGE_VERSION, gameVersion: gameVersion(), capabilities: capabilities(), state: readState() } });
        return;

      case 'mf:subscribe':
        pollHz = Math.min(60, Math.max(0, Number(message.hz) || 0));
        startPolling();
        send({ type: 'bridge:ack', id, ok: true, payload: { hz: pollHz } });
        return;

      case 'mf:unsubscribe':
        pollHz = 0;
        stopPolling();
        send({ type: 'bridge:ack', id, ok: true });
        return;

      case 'mf:request': {
        try {
          const payload = await runCommand(message.kind, message.args || {});
          send({ type: 'bridge:result', id, ok: true, kind: message.kind, payload });
        } catch (err) {
          send({ type: 'bridge:result', id, ok: false, kind: message.kind, error: err.message });
        }
        return;
      }

      case 'mf:gate':
        send({ type: 'bridge:result', id, ok: true, kind: 'gate', payload: checkInputGate() });
        return;

      case 'mf:input:run': {
        const gate = checkInputGate();
        if (!gate.ok) {
          send({ type: 'bridge:result', id, ok: false, kind: 'input:run', error: gate.reason, code: 'gate-refused' });
          return;
        }
        const events = Array.isArray(message.events) ? message.events : [];
        if (events.length > 200000) {
          send({ type: 'bridge:result', id, ok: false, kind: 'input:run', error: 'Schedule too large (over 200 000 events)', code: 'too-large' });
          return;
        }
        send({ type: 'bridge:result', id, ok: true, kind: 'input:accepted', payload: { count: events.length } });
        scheduler.start({
          events, anchor: message.anchor || 'songPosition',
          atSongMs: Number(message.atSongMs) || 0, leadMs: Number(message.leadMs) || 250,
        }, null, (result) => send({ type: 'bridge:input:end', id, payload: result }));
        return;
      }

      case 'mf:input:stop':
        send({ type: 'bridge:result', id, ok: true, kind: 'input:stop', payload: { released: scheduler.stop('stop command') } });
        return;

      case 'mf:input:release-all':
        send({ type: 'bridge:result', id, ok: true, kind: 'input:release-all', payload: { released: releaseAll('release-all command') } });
        return;

      case 'mf:input:test-key': {
        // The mapping-test screen: one press and release, gated the same way a session is.
        const testGate = checkInputGate();
        if (!testGate.ok) { send({ type: 'bridge:result', id, ok: false, kind: 'input:test-key', error: testGate.reason, code: 'gate-refused' }); return; }
        const code = String(message.code || '');
        dispatch(code, true);
        setTimeout(() => dispatch(code, false), Math.max(8, Number(message.holdMs) || 30));
        send({ type: 'bridge:result', id, ok: true, kind: 'input:test-key', payload: { code, trusted: false } });
        return;
      }

      case 'mf:ping':
        send({ type: 'bridge:pong', id, at: performance.now() });
        return;

      default:
        send({ type: 'bridge:error', id, message: `Unknown message type: ${message.type}` });
    }
  }

  function startPolling() {
    stopPolling();
    if (!pollHz) return;
    const interval = Math.max(16, Math.round(1000 / pollHz));
    let lastScreen = null;
    pollTimer = setInterval(() => {
      if (!socket) return;
      const state = readState();
      send({ type: 'bridge:state', payload: state });
      // Announce transitions immediately rather than waiting for the next poll.
      if (state.screen !== lastScreen) {
        lastScreen = state.screen;
        send({ type: 'bridge:event', payload: { kind: 'screen', screen: state.screen } });
      }
      if (state.gameplay.active && !state.gameplay.practice && downCodes.size) {
        scheduler.stop('left practice mode');
        send({ type: 'bridge:event', payload: { kind: 'gate-lost', reason: 'Left practice mode — all keys released' } });
      }
    }, interval);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  }

  /* ── never leave a key down ─────────────────────────────────────── */

  window.addEventListener('pagehide', () => { releaseAll('page hidden'); scheduler.stop('page hidden'); });
  window.addEventListener('beforeunload', () => releaseAll('page unloading'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // A hidden tab throttles timers hard enough that timing would be wrong anyway; let go.
      scheduler.stop('tab hidden');
    }
  });
  window.addEventListener('blur', () => scheduler.stop('window lost focus'));

  window.__maniaflowBridge = {
    version: BRIDGE_VERSION,
    state: readState,
    gate: checkInputGate,
    keybinds: readKeybinds,
    stop: () => scheduler.stop('manual'),
    releaseAll,
    disconnect: () => { disposed = true; clearTimeout(reconnectTimer); scheduler.stop('disconnect'); socket?.close(); },
  };

  log('bridge loaded — connecting to', wsUrl);
  connect();
})();
