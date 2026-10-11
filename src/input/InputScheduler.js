/**
 * InputScheduler — the armed-session controller.
 *
 * One instance, one active run, one source of truth about whether keys might be down.
 * It sits between the timing engine (which produced a schedule) and the keyboard backends
 * (which execute one), and it owns the lifecycle the specification asks for: start, pause,
 * resume and an emergency stop that works from any state, including a broken one.
 *
 * What "pause" means here, stated plainly because it is not what it sounds like:
 * ManiaFlow stops sending keys and releases everything it is holding. It does not pause
 * Ashtonk!mania — the game keeps playing, because pausing someone else's game from an
 * external tool is not something a practice aid should do silently. Resuming rebuilds the
 * schedule from the game's current clock, so no note is played twice and none is skipped.
 *
 * Every path out of `running` releases keys: pause, resume failure, gate loss, window blur,
 * tab hide, page unload, backend error and disposal.
 */

import { Emitter } from '../utils/emitter.js';
import { InputError, ErrorCode, toAppError } from '../utils/errors.js';
import { num } from '../utils/validation.js';
import { buildInputSchedule, validateSchedule } from '../playback/Simulation.js';

export const InputState = Object.freeze({
  IDLE: 'idle',
  ARMING: 'arming',
  ARMED: 'armed',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  ERROR: 'error',
});

export class InputScheduler extends Emitter {
  /**
   * @param {object} config
   * @param {import('./KeyboardAdapter.js').KeyboardAdapterRegistry} config.registry
   * @param {import('../game/AshtonKmaniaAdapter.js').AshtonKmaniaAdapter} config.adapter
   * @param {import('../storage/PreferencesStore.js').PreferencesStore} config.preferences
   * @param {() => number|null} [config.gameClock] reads the game's chart time, or null
   * @param {(fn: Function) => void} [config.onCleanup] registers a teardown callback
   */
  constructor(config = {}) {
    super();
    if (!config.registry || !config.adapter) {
      throw new InputError('An InputScheduler needs a backend registry and a game adapter', { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE });
    }
    this.registry = config.registry;
    this.adapter = config.adapter;
    this.preferences = config.preferences || null;
    this.gameClock = typeof config.gameClock === 'function' ? config.gameClock : () => null;

    this.state = InputState.IDLE;
    this.lastError = null;
    this.lastRun = null;
    this.held = new Set();
    this._session = null;
    this._runToken = 0;
    this._installed = false;
  }

  get backend() { return this.registry.selected; }
  get isRunning() { return this.state === InputState.RUNNING; }
  get canStart() { return this.state === InputState.IDLE || this.state === InputState.ARMED || this.state === InputState.PAUSED || this.state === InputState.ERROR; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * Check the gate and arm the selected backend.
   * A refusal carries the reason the game or the backend gave; nothing is paraphrased.
   */
  async arm({ backendId, helperId } = {}) {
    if (this.state === InputState.RUNNING) throw new InputError('A run is already in progress — stop it first', { code: ErrorCode.INPUT_BUSY });
    if (backendId) this.registry.select(backendId);
    this._setState(InputState.ARMING);
    try {
      const backend = this.registry.selected;
      if (backend.id === 'os' && helperId) await backend.arm(helperId);
      else await backend.arm();
      this.lastError = null;
      this._setState(InputState.ARMED);
      this.emit('armed', { backend: backend.describe() });
      return { ok: true, backend: backend.describe() };
    } catch (err) {
      const error = toAppError(err);
      this.lastError = error;
      this._setState(InputState.ERROR);
      this.emit('refused', error);
      throw error;
    }
  }

  /**
   * Build and send a schedule.
   *
   * @param {object} plan
   * @param {import('../chart/ChartParser.js').Note[]} plan.notes
   * @param {string[][]} plan.keyMap lane → key codes
   * @param {number} [plan.rate]
   * @param {number} [plan.startChartTime] where in the chart to begin
   * @param {number} [plan.endChartTime]
   * @param {object} [plan.distribution]
   * @param {number|string} [plan.seed]
   * @param {number} [plan.latencyMs] the game's input.latency, compensated for
   * @param {number} [plan.tapHoldMs]
   * @param {number} [plan.minHoldMs]
   * @param {number} [plan.leadMs]
   * @param {'songPosition'|'now'} [plan.anchor]
   */
  async start(plan = {}) {
    if (this.state === InputState.RUNNING) throw new InputError('A run is already in progress — stop it first', { code: ErrorCode.INPUT_BUSY });
    if (this.state !== InputState.ARMED && this.state !== InputState.PAUSED) {
      await this.arm({ backendId: plan.backendId, helperId: plan.helperId });
    }
    this.installGuards();

    const prefs = this.preferences;
    const read = (key, fallback) => (prefs && prefs.get(key) !== undefined ? prefs.get(key) : fallback);
    const rate = num(plan.rate ?? read('practice.defaultRate', 1), 1) || 1;
    const startChartTime = num(plan.startChartTime ?? this.gameClock() ?? 0, 0);
    const latencyMs = plan.latencyMs != null
      ? num(plan.latencyMs, 0)
      : (read('input.compensateLatency', true) ? num(this.adapter.gameState?.settings?.inputLatency, 0) : 0);

    const schedule = buildInputSchedule({
      notes: plan.notes,
      keyMap: plan.keyMap,
      rate,
      startChartTime,
      endChartTime: plan.endChartTime,
      latencyMs,
      seed: plan.seed ?? read('simulation.seed', 1),
      tapHoldMs: plan.tapHoldMs ?? read('simulation.tapHoldMs', 20),
      minHoldMs: plan.minHoldMs ?? read('simulation.minHoldMs', 5),
      distribution: plan.distribution ?? {
        kind: read('simulation.distribution', 'none'),
        sigmaMs: read('simulation.sigmaMs', 0),
        rangeMs: read('simulation.rangeMs', 0),
        biasMs: read('simulation.biasMs', 0),
        splitRatio: read('simulation.splitRatio', 0.5),
      },
    });

    const check = validateSchedule(schedule.events);
    if (!check.ok) {
      const error = new InputError(`The generated schedule is not valid: ${check.problems[0]}`, {
        code: ErrorCode.VALIDATION, detail: { problems: check.problems, warnings: schedule.warnings },
      });
      this.lastError = error;
      this._setState(InputState.ERROR);
      this.emit('refused', error);
      throw error;
    }

    const token = ++this._runToken;
    this._session = {
      token,
      startedAt: Date.now(),
      startChartTime,
      rate,
      latencyMs,
      schedule,
      anchor: plan.anchor === 'now' ? 'now' : 'songPosition',
      backendId: this.registry.selectedId,
      trusted: this.registry.selected.trusted,
      pausedAt: null,
      pausedChartTime: null,
    };

    this._setState(InputState.RUNNING);
    this.emit('start', { ...schedule.stats, backendId: this._session.backendId, trusted: this._session.trusted });

    try {
      const result = await this.registry.selected.run(schedule.events, {
        anchor: this._session.anchor,
        atGameTimeMs: this._session.anchor === 'songPosition' ? startChartTime : 0,
        leadMs: num(plan.leadMs ?? read('simulation.leadMs', 250), 250),
      });
      if (token !== this._runToken) return result; // superseded by a stop or a new run
      this._watchCompletion(token, schedule);
      return result;
    } catch (err) {
      const error = toAppError(err);
      this.lastError = error;
      await this._release('backend error');
      this._setState(InputState.ERROR);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * The backend acknowledges a schedule but runs it asynchronously; this waits for the
   * bridge's completion report so `lastRun` carries real numbers rather than the plan.
   */
  _watchCompletion(token, schedule) {
    if (this._session?.backendId !== 'synthetic') {
      // The OS backend reports through the server's own run:end event.
      const off = this.adapter.on('os-input', (message) => {
        if (message.type !== 'os-input:run:end' && message.type !== 'os-input:run:result') return;
        off();
        if (token !== this._runToken) return;
        this._complete({ executed: message.payload?.executed ?? schedule.events.length, backend: message.payload, source: 'os' });
      });
      return;
    }
    const off = this.adapter.on('input:end', (payload) => {
      off();
      if (token !== this._runToken) return;
      this._complete({ ...payload, source: 'bridge' });
    });
    // If nothing reports back, the schedule's own length bounds the wait.
    const wait = Math.min(600000, num(schedule.stats.realDurationMs, 0) + num(schedule.stats.lastEventMs, 0) + 30000);
    const timer = setTimeout(() => {
      off();
      if (token === this._runToken && this.state === InputState.RUNNING) {
        this._complete({ executed: schedule.events.length, timedOut: true, source: 'timeout' });
      }
    }, Math.max(2000, wait));
    this._completionTimer = timer;
  }

  _complete(result) {
    clearTimeout(this._completionTimer);
    this.lastRun = {
      ...(this._session?.schedule?.stats || {}),
      ...result,
      backendId: this._session?.backendId ?? null,
      trusted: this._session?.trusted ?? false,
      finishedAt: Date.now(),
      durationMs: this._session ? Date.now() - this._session.startedAt : 0,
    };
    this._session = null;
    this.held.clear();
    if (this.state === InputState.RUNNING) this._setState(InputState.IDLE);
    this.emit('complete', this.lastRun);
  }

  /**
   * Stop sending and release everything. The game keeps playing; see the note at the top
   * of this file for why that is the honest behaviour.
   */
  async pause() {
    if (this.state !== InputState.RUNNING) return { ok: false, reason: 'Nothing is running' };
    const at = this.gameClock();
    this._setState(InputState.STOPPING);
    if (this._session) {
      this._session.pausedAt = Date.now();
      this._session.pausedChartTime = Number.isFinite(+at) ? +at : null;
    }
    this._runToken++;                     // any completion report for this run is now stale
    clearTimeout(this._completionTimer);
    await this._release('paused');
    this._setState(InputState.PAUSED);
    this.emit('pause', { chartTime: this._session?.pausedChartTime ?? null });
    return { ok: true, chartTime: this._session?.pausedChartTime ?? null };
  }

  /** Rebuild from the game's current clock and carry on. */
  async resume(plan = {}) {
    if (this.state !== InputState.PAUSED) throw new InputError('Nothing is paused', { code: ErrorCode.INPUT_BUSY });
    const session = this._session;
    const from = Number.isFinite(num(this.gameClock(), Number.NaN)) && this.gameClock() != null
      ? this.gameClock()
      : session?.pausedChartTime ?? session?.startChartTime ?? 0;
    return this.start({
      ...plan,
      startChartTime: Math.max(0, num(from, 0)),
      rate: session?.rate ?? plan.rate,
      seed: (session?.schedule?.stats?.seed ?? plan.seed),
    });
  }

  /** Normal stop: release, disarm nothing, return to idle. */
  async stop(reason = 'stopped') {
    if (this.state === InputState.IDLE) return { ok: true, released: [] };
    this._setState(InputState.STOPPING);
    this._runToken++;
    clearTimeout(this._completionTimer);
    const released = await this._release(reason);
    this._session = null;
    this._setState(InputState.IDLE);
    this.emit('stop', { reason, released });
    return { ok: true, released };
  }

  /**
   * Emergency stop. Works from any state including ERROR, releases on *every* backend
   * rather than only the selected one, and never throws — a control that can fail is not an
   * emergency control.
   */
  async emergencyStop(reason = 'emergency stop') {
    this._runToken++;
    clearTimeout(this._completionTimer);
    const released = await this.registry.releaseAll().catch(() => []);
    this.held.clear();
    this._session = null;
    const previous = this.state;
    this._setState(InputState.IDLE);
    this.emit('emergency-stop', { reason, released, previous });
    return { ok: true, released, previous };
  }

  async _release(reason) {
    const released = [];
    try {
      const result = await this.registry.selected.stop();
      if (Array.isArray(result?.released)) released.push(...result.released);
    } catch (err) {
      this.emit('error', toAppError(err));
    }
    // Belt and braces: if the selected backend could not release, try the others too.
    if (!released.length) {
      const others = await this.registry.releaseAll().catch(() => []);
      released.push(...others);
    }
    this.held.clear();
    if (released.length) this.emit('released', { reason, released });
    return released;
  }

  /* ── guards: never leave a key down ───────────────────────────────── */

  /**
   * Install the global guards once. Losing focus, hiding the tab, unloading the page or
   * losing the practice gate all release every key, because in each case the timing that
   * made the run safe no longer holds.
   */
  installGuards() {
    if (this._installed || typeof window === 'undefined') return () => {};
    this._installed = true;

    const releaseIfRunning = (reason) => {
      if (this.state !== InputState.RUNNING && this.state !== InputState.ARMED) return;
      if (reason === 'blur' && this.preferences?.get('input.releaseOnBlur') === false) return;
      this.emergencyStop(reason).catch(() => {});
    };

    const onBlur = () => releaseIfRunning('window lost focus');
    const onVisibility = () => { if (document.hidden) releaseIfRunning('tab hidden'); };
    const onPageHide = () => releaseIfRunning('page hidden');
    const onBeforeUnload = () => { this.registry.releaseAll().catch(() => {}); };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);

    this._gateOff = this.adapter.on('gate-lost', (reason) => releaseIfRunning(reason || 'practice mode ended'));
    this._bridgeOff = this.adapter.client.on('bridge:disconnected', () => releaseIfRunning('bridge disconnected'));

    this._removeGuards = () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      this._gateOff?.();
      this._bridgeOff?.();
      this._installed = false;
    };
    return this._removeGuards;
  }

  removeGuards() {
    this._removeGuards?.();
  }

  /* ── reporting ────────────────────────────────────────────────────── */

  _setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.emit('state', { state, previous });
  }

  /** Everything the input lab shows about the current session. */
  describe() {
    const backend = this.registry.selected.describe();
    return {
      state: this.state,
      backend,
      trusted: backend.trusted,
      canStart: this.canStart,
      held: [...this.held],
      session: this._session ? {
        startedAt: this._session.startedAt,
        startChartTime: this._session.startChartTime,
        rate: this._session.rate,
        anchor: this._session.anchor,
        plannedEvents: this._session.schedule.events.length,
        seed: this._session.schedule.stats.seed,
        distribution: this._session.schedule.stats.distribution,
        warnings: this._session.schedule.warnings,
      } : null,
      lastRun: this.lastRun,
      lastError: this.lastError ? { message: this.lastError.message, code: this.lastError.code } : null,
      gate: this.adapter.localGate(),
    };
  }

  dispose() {
    this.removeGuards();
    clearTimeout(this._completionTimer);
    this.registry.releaseAll().catch(() => {});
    this._session = null;
    this.held.clear();
    this.state = InputState.IDLE;
    this.removeAll();
  }
}
