/**
 * Executes an input schedule against an operating-system keyboard backend.
 *
 * Timing lives here rather than in a `setTimeout` chain: every event is placed against a
 * monotonic clock (`process.hrtime.bigint()`), so a long schedule does not accumulate drift
 * the way `setTimeout(fn, 16)` repeated a thousand times would. Coarse waits use timers;
 * the last few milliseconds before an event use a bounded spin so the key lands on time.
 *
 * The runner never decides *which* key or *when* a note happens — the browser's timing
 * engine produced the schedule. It only plays it back, and it always lets keys go.
 */
import { EventEmitter } from 'node:events';

const SPIN_LEAD_NS = 3_000_000n;   // spin for the last 3 ms
const TIMER_MARGIN_NS = 8_000_000n; // wake 8 ms early from a coarse timer

const nowNs = () => process.hrtime.bigint();

export class OsInputRunner extends EventEmitter {
  constructor({ createBackend }) {
    super();
    this.createBackend = createBackend;
    this.backend = null;
    this.backendId = null;
    this.running = false;
    this.cancelled = false;
    this._lastRun = null;
    this._onExit = () => { this.emergencyStop().catch(() => {}); };
    process.once('SIGINT', this._onExit);
    process.once('SIGTERM', this._onExit);
    process.once('exit', () => {
      // Best effort: a synchronous backend cannot be awaited here, but the held set is
      // cleared so a restarted process never believes keys are still down.
      if (this.backend) this.backend.held.clear();
    });
  }

  get armed() { return !!this.backend && this.backend.opened; }

  status() {
    return {
      armed: this.armed,
      backendId: this.backendId,
      running: this.running,
      held: this.backend ? [...this.backend.held] : [],
      lastRun: this._lastRun,
    };
  }

  /** Open a backend so it is ready to receive events. */
  async arm(backendId) {
    await this.disarm();
    const backend = this.createBackend(backendId);
    if (!backend) throw new Error(`Unknown OS input backend: ${backendId}`);
    await backend.open();
    this.backend = backend;
    this.backendId = backendId;
    this.emit('armed', { backendId });
    return { backendId, supportsHolds: backend.supportsHolds };
  }

  async disarm() {
    const backend = this.backend;
    this.backend = null;
    this.backendId = null;
    this.cancelled = true;
    if (backend) {
      await backend.releaseAll().catch(() => {});
      await backend.close().catch(() => {});
    }
    this.emit('disarmed', {});
  }

  /** Single key, for the mapping-test screen. */
  async press(code) {
    this._requireArmed();
    await this.backend.press(code);
    this.emit('key', { code, down: true });
  }

  async release(code) {
    this._requireArmed();
    await this.backend.release(code);
    this.emit('key', { code, down: false });
  }

  /** Let every held key go and cancel any schedule in flight. */
  async emergencyStop() {
    this.cancelled = true;
    this.running = false;
    if (!this.backend) return { released: [] };
    const released = await this.backend.releaseAll().catch((err) => {
      this.emit('error', err);
      return [];
    });
    this.emit('stopped', { released, reason: 'emergency' });
    return { released };
  }

  _requireArmed() {
    if (!this.armed) throw new Error('No OS input backend is armed');
  }

  /**
   * Play a schedule.
   * @param {{ events: Array<[number, string, 0|1]>, leadMs?: number }} schedule
   *        `events` are `[milliseconds after start, KeyboardEvent.code, down]`.
   */
  async run(schedule) {
    this._requireArmed();
    const events = validateSchedule(schedule?.events);
    const leadMs = Number.isFinite(schedule.leadMs) ? Math.max(0, schedule.leadMs) : 250;
    if (this.running) throw new Error('A schedule is already running — stop it first');

    this.running = true;
    this.cancelled = false;
    const backend = this.backend;
    const startedAt = Date.now();
    const startNs = nowNs() + BigInt(Math.round(leadMs * 1e6));
    const drifts = [];
    let executed = 0;
    let failures = 0;

    this.emit('run:start', { count: events.length, leadMs });

    try {
      for (const [delayMs, code, down] of events) {
        if (this.cancelled || this.backend !== backend) break;
        const targetNs = startNs + BigInt(Math.round(delayMs * 1e6));
        await waitFor(targetNs);
        if (this.cancelled || this.backend !== backend) break;
        const actualNs = nowNs();
        drifts.push(Number(actualNs - targetNs) / 1e6);
        try {
          if (down) await backend.press(code);
          else await backend.release(code);
          executed++;
        } catch (err) {
          failures++;
          this.emit('error', err);
          // A key that cannot be sent must not leave a stale "held" belief behind.
          backend.held.delete(code);
        }
      }
    } finally {
      const released = this.cancelled ? await backend.releaseAll().catch(() => []) : [];
      const finishedAt = Date.now();
      this.running = false;
      this._lastRun = {
        startedAt, finishedAt,
        durationMs: finishedAt - startedAt,
        planned: events.length, executed, failures,
        cancelled: this.cancelled, releasedOnStop: released.length,
        timing: summariseDrift(drifts),
      };
      this.emit('run:end', this._lastRun);
    }
    return this._lastRun;
  }
}

/** Sleep until a monotonic target: timers for the long haul, a bounded spin at the end. */
async function waitFor(targetNs) {
  for (;;) {
    const remaining = targetNs - nowNs();
    if (remaining <= 0n) return;
    if (remaining <= SPIN_LEAD_NS) {
      // Bounded busy-wait: at most ~3 ms, and it is what keeps a key on the millisecond.
      while (nowNs() < targetNs) { /* spin */ }
      return;
    }
    const ms = Number((remaining - TIMER_MARGIN_NS) / 1_000_000n);
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
}

/** Reject malformed schedules instead of sending half-formed input to the OS. */
export function validateSchedule(events) {
  if (!Array.isArray(events)) throw new Error('Schedule must be an array of events');
  if (events.length > 400000) throw new Error('Schedule is too large (over 400 000 events)');
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!Array.isArray(e) || e.length !== 3) throw new Error(`Event ${i} must be [delayMs, code, down]`);
    const [delay, code, down] = e;
    if (!Number.isFinite(delay)) throw new Error(`Event ${i} has a non-numeric delay`);
    if (typeof code !== 'string' || !code) throw new Error(`Event ${i} has an invalid key code`);
    if (down !== 0 && down !== 1 && down !== true && down !== false) throw new Error(`Event ${i} has an invalid down flag`);
    if (delay < last - 0.001) throw new Error(`Event ${i} is out of order`);
    last = delay;
    out.push([delay, code, down ? 1 : 0]);
  }
  return out;
}

/** Mean / median / p95 / max of a set of millisecond drifts. */
export function summariseDrift(drifts) {
  if (!drifts.length) return { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...drifts].sort((a, b) => a - b);
  const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return {
    count: drifts.length,
    meanMs: round(mean, 3),
    medianMs: round(at(0.5), 3),
    p95Ms: round(at(0.95), 3),
    maxMs: round(sorted[sorted.length - 1], 3),
  };
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
