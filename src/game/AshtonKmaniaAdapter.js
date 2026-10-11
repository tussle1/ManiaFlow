/**
 * AshtonKmaniaAdapter — every line of game-specific code in ManiaFlow lives here.
 *
 * Nothing else in the application mentions `window.AshtonkMania`, a screen name, a mod id
 * or a bridge message type. The rest of the app sees:
 *
 *   • `ChartRecord`s, identical in shape to a locally imported file
 *   • an `IntegrationStatus` describing what is currently possible
 *   • a handful of verbs: readState, readLibrary, loadChart, practice.*, input.*, os.*
 *
 * That boundary is what lets ManiaFlow work with no game at all: with the bridge
 * disconnected, every method that needs the game rejects with a reason, and everything else
 * keeps running on imported charts.
 *
 * It also owns two refusals that are not negotiable:
 *   1. It never enables the game's `AT` (Auto) mod, never calls its `generateAutoInputs`,
 *      and never writes to a gameplay session's `feed`. Section 18 requires a separate
 *      keyboard path; the game's own autoplay is not it.
 *   2. It will not arm input unless the bridge's gate says the game is in its own practice
 *      mode, and not in multiplayer, not spectating, and not already being fed.
 */

import { Emitter } from '../utils/emitter.js';
import { IntegrationError, InputError, ChartError, ErrorCode } from '../utils/errors.js';
import { num, str, isPlainObject } from '../utils/validation.js';
import { parseOsu, toNotes, keyCount } from '../chart/ChartParser.js';
import { buildChartRecord, defaultKeyMap } from '../chart/ChartRecord.js';
import { assess, Level, shortLabel, SCREEN_LABELS } from './IntegrationStatus.js';
import { validateSchedule } from '../playback/Simulation.js';

/** Re-exported so callers have one place to look; the table lives in IntegrationStatus. */
export const GAME_SCREENS = SCREEN_LABELS;

export class AshtonKmaniaAdapter extends Emitter {
  /**
   * @param {object} config
   * @param {import('./bridgeClient.js').BridgeClient} config.client
   * @param {{ requestTimeoutMs?: number }} [config.options]
   */
  constructor(config = {}) {
    super();
    if (!config.client || typeof config.client.request !== 'function') {
      throw new IntegrationError('An adapter needs a bridge client', { code: ErrorCode.BRIDGE_UNAVAILABLE });
    }
    this.client = config.client;
    this.options = config.options || {};

    /** Last observed game state, or null when nothing has been reported. */
    this.gameState = null;
    this.library = [];
    this.libraryError = null;
    this.libraryLoadedAt = null;
    this.osDetect = null;
    this.osArmed = null;
    this._status = null;
    this._unsubscribers = [];
    this._statusQueued = false;
  }

  /* ── wiring ───────────────────────────────────────────────────────── */

  /** Start listening. Idempotent: a second call does not add duplicate listeners. */
  attach() {
    if (this._unsubscribers.length) return this;
    this._unsubscribers.push(
      this.client.on('bridge-message', (message) => this._onBridgeMessage(message)),
      this.client.on('hub', (hub) => { this._onHub(hub); }),
      this.client.on('bridge:connected', () => this._onBridgeArrived()),
      this.client.on('bridge:disconnected', () => {
        this.gameState = null;
        this._publishStatus();
      }),
      this.client.on('state', () => this._publishStatus()),
      this.client.on('error', (err) => { this._publishStatus(); this.emit('error', err); }),
      this.client.on('os-input', (message) => this._onOsMessage(message)),
    );
    this._publishStatus();
    return this;
  }

  _onBridgeMessage(message) {
    if (!isPlainObject(message)) return;
    if (message.type === 'bridge:state') {
      this.gameState = normaliseGameState(message.payload);
      this._publishStatus();
      this.emit('state', this.gameState);
      return;
    }
    if (message.type === 'bridge:event') {
      this.emit('event', message.payload);
      if (message.payload?.kind === 'gate-lost') {
        this.emit('gate-lost', message.payload.reason);
        this._publishStatus();
      }
      return;
    }
    if (message.type === 'bridge:input:end') {
      this.emit('input:end', message.payload);
      return;
    }
    if (message.type === 'bridge:hello') {
      this.gameState = normaliseGameState(message.payload?.state);
      this._publishStatus();
    }
  }

  _onHub(hub) {
    if (!hub?.bridgeConnected) this.gameState = null;
    this._publishStatus();
  }

  async _onBridgeArrived() {
    this._publishStatus();
    // Ask the bridge who it is, so the status has a version and a capability list.
    try {
      const reply = await this.client.requestBridge('state', {}, { timeoutMs: 4000 });
      if (reply?.payload) {
        this.gameState = normaliseGameState(reply.payload);
        this._publishStatus();
        this.emit('state', this.gameState);
      }
    } catch (err) {
      this.emit('error', err);
    }
    this.emit('bridge:ready', this.status);
  }

  _onOsMessage(message) {
    if (message.type === 'os-input:detect:result') this.osDetect = message.payload || null;
    if (message.type === 'os-input:armed') this.osArmed = { backendId: message.payload?.backendId, armed: true };
    if (message.type === 'os-input:disarmed') this.osArmed = null;
    if (message.type === 'os-input:stopped') this.osArmed = { ...(this.osArmed || {}), armed: true, lastStop: message.payload };
    this._publishStatus();
    this.emit('os-input', message);
  }

  /* ── status ───────────────────────────────────────────────────────── */

  /** The current integration status. Cached; recomputed when an observation changes. */
  get status() {
    if (!this._status) this._status = this._assess();
    return this._status;
  }

  get statusLabel() { return shortLabel(this.status); }

  _assess() {
    const client = this.client.describe();
    const gameplay = this.gameState?.gameplay || { active: false };
    const gateBlocked = gameplay.active && !(gameplay.practice && gameplay.running) || gameplay.auto || gameplay.feed;
    return assess({
      server: { state: client.state, connected: client.connected, lastError: client.lastError },
      bridge: { connected: client.bridgeConnected, info: client.bridge, latencyMs: client.latencyMs },
      game: {
        available: !!this.gameState?.available,
        screen: this.gameState?.screen ?? null,
        practice: !!gameplay.practice,
        // The gate verdict, so `capabilities.syntheticInput` and `localGate()` cannot
        // disagree: practice mode alone is not enough while Auto, a feed, multiplayer,
        // spectating or a pause also close the gate.
        blocked: this.gameState?.available === false || !!gateReason(gameplay),
        reason: this.gameState?.available === false ? (this.gameState.reason || 'The game has not finished loading') : gateReason(gameplay),
      },
      osInput: {
        required: this.options.inputBackend === 'os',
        detected: !!this.osDetect,
        available: !!this.osArmed?.armed || !!this.osDetect?.recommended,
        backendId: this.osArmed?.backendId || this.osDetect?.recommended || null,
        reason: this.osDetect?.recommended ? null : (this.osDetect?.warnings?.[0] || 'No helper was detected on this machine'),
      },
    });
  }

  /** Recompute and emit, coalesced to one microtask so a burst of state does not thrash. */
  _publishStatus() {
    this._status = null;
    if (this._statusQueued) return;
    this._statusQueued = true;
    queueMicrotask(() => {
      this._statusQueued = false;
      this.emit('status', this.status);
    });
  }

  /* ── reads ────────────────────────────────────────────────────────── */

  _requireBridge(what) {
    if (!this.client.isConnected) {
      throw new IntegrationError(`Cannot ${what}: the ManiaFlow server is not connected`, { code: ErrorCode.BRIDGE_UNAVAILABLE });
    }
    if (!this.client.bridgeConnected) {
      throw new IntegrationError(`Cannot ${what}: no bridge is running inside the game. Install it from Settings → Integration.`, {
        code: ErrorCode.BRIDGE_UNAVAILABLE,
      });
    }
  }

  /** Ask the bridge for the current state, rather than trusting the last poll. */
  async readState() {
    this._requireBridge('read game state');
    const reply = await this.client.requestBridge('state');
    this.gameState = normaliseGameState(reply?.payload);
    this._publishStatus();
    return this.gameState;
  }

  /** Begin (or stop) the bridge's state polling. */
  subscribeState(hz) {
    this._requireBridge('subscribe to game state');
    const rate = Math.max(0, Math.min(60, num(hz, 12)));
    return this.client.postBridge({ type: rate > 0 ? 'mf:subscribe' : 'mf:unsubscribe', hz: rate });
  }

  /**
   * Read the game's chart library and return it as ChartRecords.
   * The game's own analysis figures are carried through; ManiaFlow re-parses nothing here,
   * because a record already contains everything the library list shows.
   */
  async readLibrary() {
    this._requireBridge('read the chart library');
    const reply = await this.client.requestBridge('library', {}, { timeoutMs: 20000 });
    const payload = reply?.payload || {};
    if (payload.error) {
      this.libraryError = str(payload.error, 'The library could not be read');
      this.library = [];
      this.emit('library', { records: [], error: this.libraryError });
      throw new IntegrationError(this.libraryError, { code: ErrorCode.GAME_UNAVAILABLE });
    }
    const maps = Array.isArray(payload.maps) ? payload.maps : [];
    this.library = maps.map((record) => recordFromGame(record));
    this.libraryError = null;
    this.libraryLoadedAt = Date.now();
    this.emit('library', { records: this.library, error: null });
    return this.library;
  }

  /**
   * Load one chart from the game: its `.osu` text, parsed by ManiaFlow's own parser so the
   * preview and the Timing Lab work on the same notes the game plays, plus the game's own
   * record for the fields only it knows (star rating, hash, when it was added).
   */
  async loadChart(mapId) {
    this._requireBridge('load a chart from the game');
    if (!mapId) throw new IntegrationError('No chart id was given', { code: ErrorCode.GAME_UNAVAILABLE });
    const reply = await this.client.requestBridge('chart', { mapId }, { timeoutMs: 20000 });
    const payload = reply?.payload || {};
    const text = typeof payload.osuText === 'string' ? payload.osuText : null;
    if (!text) {
      throw new ChartError(
        `The game did not return the .osu text for ${mapId}. Its library record is still usable for metadata.`,
        { code: ErrorCode.CHART_UNSUPPORTED },
      );
    }
    const chart = parseOsu(text);
    let notes = [];
    try {
      notes = toNotes(chart, keyCount(chart));
    } catch (err) {
      // A converted osu!standard chart is the usual reason; the record still carries
      // everything the game knows, and the UI says why notes are unavailable.
      this.emit('error', err);
    }
    const record = buildChartRecord({
      chart, notes, source: 'bridge', record: payload.map, fileName: payload.map?.osuPath ?? null,
    });
    this.emit('chart', record);
    return record;
  }

  /**
   * The lane→key mapping to use. The game's own configured keybinds win; its documented
   * defaults are the fallback; a local override wins over both if the user set one.
   */
  async keybindsFor(keys, override = null) {
    const count = Math.max(1, Math.min(18, Math.round(num(keys, 4))));
    if (Array.isArray(override) && override.length === count) return override.map((codes) => (Array.isArray(codes) ? [...codes] : []));
    if (this.client.isConnected && this.client.bridgeConnected) {
      try {
        const reply = await this.client.requestBridge('keybinds', { keys: count }, { timeoutMs: 5000 });
        const bindings = reply?.payload?.bindings;
        if (Array.isArray(bindings) && bindings.length === count) {
          return { bindings: bindings.map((codes) => (Array.isArray(codes) ? [...codes] : [])), origin: 'game' };
        }
      } catch (err) {
        this.emit('error', err);
      }
    }
    return { bindings: defaultKeyMap(count), origin: 'default' };
  }

  /* ── the game's own practice controls ─────────────────────────────── */

  get practice() {
    const adapter = this;
    return {
      seek(timeMs) { return adapter._practiceCommand('practice.seek', { time: num(timeMs, 0) }); },
      speed(rate) { return adapter._practiceCommand('practice.speed', { speed: num(rate, 1) }); },
      loop(which, value) { return adapter._practiceCommand('practice.loop', { which: str(which, 'clear') }); },
      restart() { return adapter._practiceCommand('practice.restart', {}); },
    };
  }

  async _practiceCommand(kind, args) {
    this._requireBridge('use the game\'s practice controls');
    const reply = await this.client.requestBridge(kind, args);
    return reply?.payload ?? { ok: true };
  }

  /* ── the safety gate ──────────────────────────────────────────────── */

  /**
   * Ask the bridge whether input may be sent right now. The bridge checks the live game
   * state; this method adds nothing to that verdict except a local pre-check so a caller
   * gets an answer even when the bridge is missing.
   */
  async checkGate() {
    if (!this.client.isConnected || !this.client.bridgeConnected) {
      return { ok: false, reason: 'No bridge is connected, so the game cannot be asked', local: true };
    }
    try {
      const reply = await this.client.request({ type: 'relay', to: 'bridge', message: { type: 'mf:gate' } });
      return reply?.payload || { ok: false, reason: 'The bridge returned no verdict' };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Refuse locally when the last observed state is clearly not practice mode.
   * This is a fast pre-check, not the authority — the bridge re-checks at send time.
   */
  localGate() {
    if (this.options.requirePractice === false) return { ok: true, reason: null, bypassed: true };
    const gameplay = this.gameState?.gameplay;
    if (!gameplay?.active) return { ok: false, reason: 'No gameplay session is loaded in the game' };
    const reason = gateReason(gameplay);
    return reason ? { ok: false, reason } : { ok: true, reason: null };
  }

  /* ── input: synthetic, through the bridge ─────────────────────────── */

  get input() {
    const adapter = this;
    return {
      /**
       * Send a schedule to the bridge, which dispatches it as real KeyboardEvents inside
       * the game page. The bridge re-checks the gate before the first event.
       */
      async run(events, options = {}) {
        // Checked first: a malformed schedule is the caller's bug whatever the connection is
        // doing, and that is the more useful thing to be told.
        const check = validateSchedule(events);
        if (!check.ok) {
          throw new InputError(`The schedule is not valid: ${check.problems[0]}`, {
            code: ErrorCode.VALIDATION, detail: { problems: check.problems },
          });
        }
        adapter._requireBridge('send input');
        const local = adapter.localGate();
        if (!local.ok) throw new InputError(local.reason, { code: ErrorCode.INPUT_GATE_REFUSED });
        if (adapter.options.requirePractice !== false && !adapter.gameState?.gameplay?.practice) {
          throw new InputError('The game is not in practice mode', { code: ErrorCode.INPUT_GATE_REFUSED });
        }
        const accepted = await adapter.client.request({
          type: 'relay', to: 'bridge',
          message: {
            type: 'mf:input:run', events,
            anchor: options.anchor === 'now' ? 'now' : 'songPosition',
            atSongMs: num(options.atGameTimeMs, 0),
            leadMs: num(options.leadMs, 250),
          },
        }, { timeoutMs: 15000 });
        return accepted?.payload ?? { ok: true };
      },
      async stop() {
        adapter._requireBridge('stop input');
        const reply = await adapter.client.request({ type: 'relay', to: 'bridge', message: { type: 'mf:input:stop' } }, { timeoutMs: 5000 });
        return reply?.payload ?? { released: [] };
      },
      async releaseAll() {
        if (!adapter.client.isConnected) return { released: [] };
        const reply = await adapter.client.request({ type: 'relay', to: 'bridge', message: { type: 'mf:input:release-all' } }, { timeoutMs: 5000 });
        return reply?.payload ?? { released: [] };
      },
      async testKey(code, holdMs = 30) {
        adapter._requireBridge('test a key');
        const local = adapter.localGate();
        if (!local.ok) throw new InputError(local.reason, { code: ErrorCode.INPUT_GATE_REFUSED });
        const reply = await adapter.client.request({
          type: 'relay', to: 'bridge',
          message: { type: 'mf:input:test-key', code: str(code, ''), holdMs: num(holdMs, 30) },
        }, { timeoutMs: 5000 });
        return reply?.payload ?? { code, trusted: false };
      },
    };
  }

  /* ── input: operating-system level, through the server ────────────── */

  get os() {
    const adapter = this;
    const call = (message, timeoutMs = 8000) => adapter.client.request(message, { timeoutMs });
    return {
      detect: () => call({ type: 'os-input:detect' }, 12000),
      arm: (backendId) => call({ type: 'os-input:arm', backendId: str(backendId, '') }, 20000),
      disarm: () => call({ type: 'os-input:disarm' }, 8000),
      press: (code) => call({ type: 'os-input:press', code: str(code, '') }, 5000),
      release: (code) => call({ type: 'os-input:release', code: str(code, '') }, 5000),
      stop: () => call({ type: 'os-input:stop' }, 5000),
      /**
       * Hand a schedule to the server, which plays it through the armed OS helper.
       * The gate is checked here because the server has no view of the game.
       */
      async run(events, options = {}) {
        const check = validateSchedule(events);
        if (!check.ok) {
          throw new InputError(`The schedule is not valid: ${check.problems[0]}`, { code: ErrorCode.VALIDATION });
        }
        if (adapter.options.requirePractice !== false) {
          const verdict = await adapter.checkGate();
          if (!verdict.ok) throw new InputError(verdict.reason || 'The game is not in practice mode', { code: ErrorCode.INPUT_GATE_REFUSED });
        }
        adapter.client.request({ type: 'os-input:run', events, leadMs: num(options.leadMs, 250) }, { timeoutMs: 5000 })
          .catch((err) => adapter.emit('error', err));
        return { accepted: true, count: events.length };
      },
    };
  }

  /** Which input backend is selected, and whether it can run right now. */
  describeInputBackend() {
    const backend = this.options.inputBackend === 'os' ? 'os' : 'synthetic';
    if (backend === 'os') {
      return {
        id: 'os',
        label: 'Operating-system key input',
        available: !!this.osArmed?.armed || !!this.osDetect?.recommended,
        detail: this.osArmed?.armed ? `${this.osArmed.backendId} is armed`
          : this.osDetect?.recommended ? `${this.osDetect.recommended} is available but not armed`
            : this.osDetect ? 'No OS helper is available on this machine' : 'Not detected yet',
        trusted: true,
      };
    }
    return {
      id: 'synthetic',
      label: 'Synthetic DOM events (in-page bridge)',
      available: this.client.bridgeConnected && !!this.gameState?.available,
      detail: this.client.bridgeConnected ? 'Events are dispatched inside the game page' : 'Needs the in-page bridge',
      // Stated plainly: these are KeyboardEvents created in the page, and the browser marks
      // them isTrusted === false. The game accepts them; they are not hardware key presses.
      trusted: false,
    };
  }

  /** Everything the diagnostics panel shows, in one object. */
  diagnostics() {
    return {
      client: this.client.describe(),
      status: this.status,
      game: this.gameState,
      library: { count: this.library.length, error: this.libraryError, loadedAt: this.libraryLoadedAt },
      osDetect: this.osDetect,
      osArmed: this.osArmed,
      inputBackend: this.describeInputBackend(),
      screens: GAME_SCREENS,
    };
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) { try { unsubscribe(); } catch { /* already gone */ } }
    this._unsubscribers = [];
    this.removeAll();
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Why input is not allowed, given the last observed gameplay state. */
function gateReason(gameplay) {
  if (!gameplay || !gameplay.active) return 'No gameplay session is loaded in the game';
  // `auto` is the runtime flag the game sets when its own autoplay mod ("AT") is selected.
  // That flag — not the mod string — is the authoritative signal, and ManiaFlow never sets it.
  if (gameplay.auto) return 'The game\'s own Auto is active — ManiaFlow will not run alongside it';
  if (gameplay.feed) return 'The game is feeding a replay or Auto into its engine';
  if (gameplay.replay) return 'A replay is playing';
  if (gameplay.multiplayer) return 'Multiplayer is active — automated input is not permitted';
  if (gameplay.spectating) return 'Spectating — automated input is not permitted';
  if (!gameplay.practice) {
    return 'Not in practice mode. Start practice in the game (song select → Practice, or F4).';
  }
  if (!gameplay.running) return 'The practice session is paused';
  return null;
}

/** Keep only the fields the UI uses, so an unexpected payload shape cannot break anything. */
function normaliseGameState(payload) {
  if (!isPlainObject(payload)) return { available: false, reason: 'The bridge sent no state' };
  if (payload.available === false) return { available: false, reason: str(payload.reason, 'window.AshtonkMania is not present') };
  const gameplay = isPlainObject(payload.gameplay) ? payload.gameplay : { active: false };
  return {
    available: true,
    screen: str(payload.screen, null),
    screenLabel: GAME_SCREENS[str(payload.screen, '')] || str(payload.screen, null) || 'Unknown',
    busy: !!payload.busy,
    safeMode: !!payload.safeMode,
    gameplay: {
      active: !!gameplay.active,
      mode: str(gameplay.mode, null),
      practice: !!gameplay.practice,
      auto: !!gameplay.auto,
      feed: !!gameplay.feed,
      replay: !!gameplay.replay,
      multiplayer: !!gameplay.multiplayer,
      spectating: !!gameplay.spectating,
      running: !!gameplay.running,
      finished: !!gameplay.finished,
      failed: !!gameplay.failed,
      keys: num(gameplay.keys, 0),
      rate: num(gameplay.rate, 1),
      mods: Array.isArray(gameplay.mods) ? gameplay.mods.map((m) => str(m, '')).filter(Boolean) : [],
      endTime: num(gameplay.endTime, 0),
      firstNote: num(gameplay.firstNote, 0),
      loopA: gameplay.loopA == null ? null : num(gameplay.loopA, null),
      loopB: gameplay.loopB == null ? null : num(gameplay.loopB, null),
      mapOffset: num(gameplay.mapOffset, 0),
      mapId: str(gameplay.mapId, null),
      mapHash: str(gameplay.mapHash, null),
      title: str(gameplay.title, null),
      artist: str(gameplay.artist, null),
      version: str(gameplay.version, null),
      od: gameplay.od == null ? null : num(gameplay.od, null),
      held: Array.isArray(gameplay.held) ? gameplay.held.map(Boolean) : [],
      keyLabels: Array.isArray(gameplay.keyLabels) ? gameplay.keyLabels.map((l) => str(l, '')) : [],
      windows: isPlainObject(gameplay.windows) ? gameplay.windows : null,
    },
    clock: {
      playing: !!payload.clock?.playing,
      rate: num(payload.clock?.rate, 1),
      songPosition: payload.clock?.songPosition == null ? null : num(payload.clock.songPosition, null),
      gameTime: payload.clock?.gameTime == null ? null : num(payload.clock.gameTime, null),
      gen: num(payload.clock?.gen, 0),
      duration: num(payload.clock?.duration, 0),
    },
    settings: isPlainObject(payload.settings) ? payload.settings : {},
  };
}

/** A library record from the game, shaped like a local one but carrying no parsed chart. */
function recordFromGame(record) {
  const problems = Array.isArray(record.problems) ? record.problems.map((p) => str(p, '')) : [];
  const warnings = Array.isArray(record.warnings) ? record.warnings.map((w) => str(w, '')) : [];
  const n = (value) => (Number.isFinite(num(value, Number.NaN)) ? num(value) : null);
  return {
    id: str(record.id, null),
    source: 'bridge',
    hash: str(record.hash, null),
    setId: n(record.setId),
    onlineId: n(record.onlineId),
    title: str(record.title, 'Unknown title'),
    titleUnicode: str(record.titleUnicode, null),
    artist: str(record.artist, 'Unknown artist'),
    artistUnicode: str(record.artistUnicode, null),
    creator: str(record.creator, 'Unknown'),
    version: str(record.version, 'Normal'),
    sourceTag: str(record.source, ''),
    tags: String(record.tags || '').split(/\s+/).filter(Boolean),
    mode: n(record.mode),
    keys: n(record.keys) || 0,
    od: n(record.od),
    hp: n(record.hp),
    bpm: n(record.bpm),
    bpmMin: n(record.bpmMin),
    bpmMax: n(record.bpmMax),
    length: n(record.length),
    drainLength: n(record.drainLength),
    objectCount: n(record.objectCount),
    noteCount: n(record.noteCount),
    lnCount: n(record.lnCount),
    nps: n(record.nps),
    lnRatio: n(record.lnRatio),
    peakNps: null,
    stars: n(record.stars),
    previewTime: n(record.previewTime),
    audioFilename: str(record.audioFile, null),
    audioUrl: null,
    breaks: Array.isArray(record.breaks) ? record.breaks : [],
    problems,
    warnings,
    previewable: problems.length === 0 && (record.mode === 3 || record.mode === 0),
    valid: problems.length === 0,
    added: n(record.added) || Date.now(),
    openedAt: null,
    // Not loaded yet: the chart and notes arrive from loadChart().
    chart: null,
    notes: [],
    analysis: null,
    osuPath: str(record.osuPath, null),
  };
}

export { Level };
