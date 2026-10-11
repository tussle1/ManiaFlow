/**
 * KeyboardAdapter — the "how" of sending a key, behind one interface.
 *
 * The timing engine decides *when* a note happens, the chart parser decides *which* lane,
 * and this module decides *how* the key goes down. Nothing here knows what a note is: every
 * backend receives a schedule of `[delayMs, code, down]` and nothing else, which is why a
 * third backend could be added without touching the timing engine, the UI or the parser.
 *
 * Two backends are implemented, and they differ in a way that is stated rather than hidden:
 *
 *   synthetic   KeyboardEvents dispatched inside the game page by the bridge. The game
 *               resolves them by `event.code` and never checks `isTrusted`, so they work —
 *               but they are `isTrusted === false` and are NOT hardware key events.
 *   os          Real key events injected into the operating system's input queue by a
 *               native helper (xdotool / ydotool / cliclick / SendInput), driven by the
 *               ManiaFlow server. These are genuine OS-level input; they need the browser
 *               window focused and a helper installed.
 *
 * Neither backend can reach the game's own autoplay, and neither tries: there is no code
 * path here that sets the `AT` mod, calls `generateAutoInputs`, or writes to a session's
 * `feed`.
 */

import { Emitter } from '../utils/emitter.js';
import { InputError, ErrorCode } from '../utils/errors.js';
import { num, str, isValidKeyCode } from '../utils/validation.js';
import { validateSchedule } from '../playback/Simulation.js';

export const BackendId = Object.freeze({ SYNTHETIC: 'synthetic', OS: 'os' });

/**
 * The contract every backend satisfies. `trusted` is a fact about the backend, not a
 * preference: it says whether the events it produces are indistinguishable from hardware.
 */
export class KeyboardBackend {
  constructor(id, label, { trusted = false } = {}) {
    this.id = id;
    this.label = label;
    this.trusted = trusted;
  }

  get available() { return false; }
  /* eslint-disable no-unused-vars */
  async arm() { throw new InputError(`${this.id} is not implemented`, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE }); }
  async disarm() { throw new InputError(`${this.id} is not implemented`, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE }); }
  async run(_events, _options) { throw new InputError(`${this.id} is not implemented`, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE }); }
  async stop() { throw new InputError(`${this.id} is not implemented`, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE }); }
  async releaseAll() { throw new InputError(`${this.id} is not implemented`, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE }); }
  /* eslint-enable no-unused-vars */
  describe() { return { id: this.id, label: this.label, available: this.available, trusted: this.trusted }; }
}

/**
 * Synthetic events, dispatched by the in-page bridge.
 * The schedule runs *inside the game page*, where the audio clock lives, so timing is not
 * at the mercy of a second round trip per key.
 */
export class SyntheticBridgeBackend extends KeyboardBackend {
  /** @param {import('../game/AshtonKmaniaAdapter.js').AshtonKmaniaAdapter} adapter */
  constructor(adapter) {
    super(BackendId.SYNTHETIC, 'Synthetic DOM events (in-page bridge)', { trusted: false });
    this.adapter = adapter;
    this._armed = false;
    this._running = false;
  }

  get available() {
    return !!this.adapter?.client?.bridgeConnected && !!this.adapter.gameState?.available;
  }

  /**
   * Arming checks the gate rather than assuming it. A refusal names the reason, which the
   * UI shows verbatim.
   */
  async arm() {
    if (!this.available) {
      throw new InputError(
        this.adapter?.client?.bridgeConnected
          ? 'The bridge is connected but the game has not reported its state yet'
          : 'No bridge is connected inside the game',
        { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE },
      );
    }
    const verdict = await this.adapter.checkGate();
    if (!verdict.ok) throw new InputError(verdict.reason, { code: ErrorCode.INPUT_GATE_REFUSED, detail: verdict });
    this._armed = true;
    return { backendId: this.id, trusted: false, gate: verdict };
  }

  async disarm() {
    this._armed = false;
    await this.releaseAll().catch(() => {});
    return { backendId: this.id };
  }

  async run(events, options = {}) {
    this._assertArmed();
    this._running = true;
    try {
      return await this.adapter.input.run(events, options);
    } finally {
      this._running = false;
    }
  }

  async stop() {
    this._running = false;
    if (!this.adapter?.client?.isConnected) return { released: [] };
    return this.adapter.input.stop();
  }

  async releaseAll() {
    if (!this.adapter?.client?.isConnected) return { released: [] };
    return this.adapter.input.releaseAll();
  }

  async testKey(code, holdMs = 30) {
    this._assertArmed();
    if (!isValidKeyCode(code)) {
      throw new InputError(`"${str(code, '')}" is not a recognised key code`, { code: ErrorCode.INPUT_KEY_UNSUPPORTED });
    }
    return this.adapter.input.testKey(code, holdMs);
  }

  _assertArmed() {
    if (!this._armed) throw new InputError('This backend is not armed — check the gate first', { code: ErrorCode.INPUT_GATE_REFUSED });
  }

  describe() {
    return {
      ...super.describe(),
      available: this.available,
      armed: this._armed,
      running: this._running,
      note: 'Events are dispatched inside the game page. They are isTrusted === false: the game accepts them, but they are not hardware key presses.',
    };
  }
}

/**
 * Operating-system key input, driven by the ManiaFlow server.
 * The schedule runs server-side against `process.hrtime.bigint()`, because that is the only
 * monotonic clock that can reach a native helper.
 */
export class OsInputBackend extends KeyboardBackend {
  constructor(adapter) {
    super(BackendId.OS, 'Operating-system key input', { trusted: true });
    this.adapter = adapter;
    this.helperId = null;
    this.detection = null;
    this.armed = false;
    this.running = false;
  }

  get available() {
    return this.armed || !!this.detection?.recommended;
  }

  /** Find out what this machine actually offers. Never guesses from the platform name. */
  async detect() {
    const reply = await this.adapter.os.detect();
    this.detection = reply?.payload || null;
    return this.detection;
  }

  async arm(helperId) {
    const wanted = str(helperId, '') || this.detection?.recommended;
    if (!wanted) {
      const detection = this.detection || await this.detect().catch(() => null);
      const reason = detection?.recommended
        ? null
        : detection
          ? `No OS keyboard helper is available on this ${detection.platform} machine${detection.warnings?.length ? `: ${detection.warnings[0]}` : ''}`
          : 'The ManiaFlow server could not be asked about OS input';
      if (reason) throw new InputError(reason, { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE, detail: { detection } });
      return this.arm(detection.recommended);
    }
    const reply = await this.adapter.os.arm(wanted);
    this.helperId = wanted;
    this.armed = true;
    return { backendId: this.id, helperId: wanted, trusted: true, ...(reply?.payload || {}) };
  }

  async disarm() {
    this.armed = false;
    this.running = false;
    this.helperId = null;
    await this.adapter.os.disarm().catch(() => {});
    return { backendId: this.id };
  }

  async run(events, options = {}) {
    if (!this.armed) throw new InputError('No OS keyboard helper is armed', { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE });
    this.running = true;
    try {
      return await this.adapter.os.run(events, options);
    } finally {
      this.running = false;
    }
  }

  async stop() {
    this.running = false;
    return this.adapter.os.stop();
  }

  async releaseAll() {
    if (!this.armed) return { released: [] };
    return this.adapter.os.stop();
  }

  async testKey(code, holdMs = 40) {
    if (!this.armed) throw new InputError('No OS keyboard helper is armed', { code: ErrorCode.INPUT_BACKEND_UNAVAILABLE });
    if (!isValidKeyCode(code)) {
      throw new InputError(`"${str(code, '')}" is not a recognised key code`, { code: ErrorCode.INPUT_KEY_UNSUPPORTED });
    }
    const supported = this.detection?.backends?.find((b) => b.id === this.helperId);
    if (Array.isArray(supported?.supports) && !supported.supports.includes(code)) {
      throw new InputError(`${this.helperId} cannot send "${code}"`, { code: ErrorCode.INPUT_KEY_UNSUPPORTED });
    }
    await this.adapter.os.press(code);
    const wait = Math.max(8, num(holdMs, 40));
    await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    await this.adapter.os.release(code);
    return { code, trusted: true, holdMs: wait };
  }

  describe() {
    return {
      ...super.describe(),
      available: this.available,
      armed: this.armed,
      running: this.running,
      helperId: this.helperId,
      recommended: this.detection?.recommended ?? null,
      backends: this.detection?.backends ?? null,
      warnings: this.detection?.warnings ?? [],
      note: 'Real key events in the operating system input queue. The browser window must be focused, and a native helper must be installed.',
    };
  }
}

/**
 * Holds both backends and exposes the selected one.
 * There is exactly one of these, owned by the application state, so "which backend is
 * active" has one answer.
 */
export class KeyboardAdapterRegistry extends Emitter {
  constructor(adapter) {
    super();
    this.synthetic = new SyntheticBridgeBackend(adapter);
    this.os = new OsInputBackend(adapter);
    this._byId = new Map([[this.synthetic.id, this.synthetic], [this.os.id, this.os]]);
    this._selected = BackendId.SYNTHETIC;
  }

  get selected() { return this._byId.get(this._selected) || this.synthetic; }
  get selectedId() { return this._selected; }
  get all() { return [...this._byId.values()]; }

  select(id) {
    const next = this._byId.get(id);
    if (!next) {
      throw new InputError(`Unknown input backend "${str(id, '')}" — expected one of ${[...this._byId.keys()].join(', ')}`, {
        code: ErrorCode.INPUT_BACKEND_UNAVAILABLE,
      });
    }
    if (next.id === this._selected) return next;
    this._selected = next.id;
    this.emit('select', { backendId: next.id, backend: next.describe() });
    return next;
  }

  /** Every backend's description, for the input lab's backend picker. */
  describeAll() {
    return this.all.map((backend) => backend.describe());
  }

  /** Release everything on every backend. Runs on shutdown and on any error path. */
  async releaseAll() {
    const released = [];
    for (const backend of this.all) {
      try {
        const result = await backend.releaseAll();
        if (Array.isArray(result?.released)) released.push(...result.released);
      } catch { /* a backend that cannot release is reported by its own describe() */ }
    }
    return released;
  }

  async disarmAll() {
    for (const backend of this.all) {
      try { await backend.disarm(); } catch { /* best effort */ }
    }
  }
}

/**
 * Check a lane→key mapping before it is used, so an unmappable key is reported before the
 * first note rather than halfway through a run.
 */
export function validateKeyMapForBackend(bindings, keys, backend) {
  const problems = [];
  const count = Math.max(1, Math.min(18, Math.round(num(keys, 0))));
  if (!Array.isArray(bindings) || bindings.length !== count) {
    return { ok: false, problems: [`The mapping has ${Array.isArray(bindings) ? bindings.length : 0} lanes but the chart has ${count}`] };
  }
  const seen = new Map();
  const supported = backend?.id === BackendId.OS
    ? backend.detection?.backends?.find((b) => b.id === backend.helperId)?.supports
    : null;

  bindings.forEach((codes, lane) => {
    if (!Array.isArray(codes) || !codes.length) { problems.push(`Lane ${lane + 1} has no key bound`); return; }
    for (const code of codes) {
      if (!isValidKeyCode(code)) { problems.push(`Lane ${lane + 1}: "${code}" is not a valid key code`); continue; }
      if (Array.isArray(supported) && !supported.includes(code)) {
        problems.push(`Lane ${lane + 1}: ${backend.helperId} cannot send "${code}"`);
      }
      if (seen.has(code)) problems.push(`"${code}" is bound to both lane ${seen.get(code) + 1} and lane ${lane + 1}`);
      else seen.set(code, lane);
    }
  });
  return { ok: problems.length === 0, problems, primary: bindings.map((codes) => (Array.isArray(codes) && codes.length ? codes[0] : null)) };
}

export { validateSchedule };
