/**
 * SessionRecorder — the only thing in ManiaFlow that writes a session record.
 *
 * Pages do not construct session objects and the store does not know what a session means.
 * A recorder is opened when real work starts, fed as that work happens, and closed when it
 * stops. Nothing is recorded that did not occur: if a page never analyses a chart, the
 * `analysis` field stays null and the Statistics page shows no analysis figure for it.
 */

import { Emitter } from '../utils/emitter.js';
import { SessionKind, SessionStatus, newId, normaliseSession } from '../storage/SessionStore.js';
import { isPlainObject, num } from '../utils/validation.js';

export class SessionRecorder extends Emitter {
  /** @param {import('../storage/SessionStore.js').SessionStore} store */
  constructor(store) {
    super();
    if (!store || typeof store.put !== 'function') throw new TypeError('SessionRecorder needs a SessionStore');
    this.store = store;
    /** @type {object|null} */
    this.current = null;
    this._marks = [];
    this._startedAt = 0;
  }

  get isActive() { return !!this.current; }

  /**
   * Open a session. Any session still open is closed as `aborted` first, so there is never
   * more than one in flight and never a record left in `running` forever.
   */
  async begin({ kind = SessionKind.ANALYSIS, chart = null, seed = null } = {}) {
    if (this.current) await this.end(SessionStatus.ABORTED, { reason: 'another session started' });

    const now = Date.now();
    this._startedAt = now;
    this._marks = [{ name: 'begin', at: 0 }];
    this.current = normaliseSession({
      id: newId(),
      kind,
      status: SessionStatus.RUNNING,
      startedAt: now,
      endedAt: null,
      chart,
      seed,
      appVersion: '1.0.0',
    });
    this.emit('begin', this.current);
    return this.current;
  }

  /** A named point in the session, in milliseconds since it began. */
  mark(name) {
    if (!this.current || typeof name !== 'string' || !name) return null;
    const at = Math.max(0, Math.round(performance.now() - this._perfOrigin()));
    const mark = { name, at, wallAt: Date.now() };
    this._marks.push(mark);
    this.current.marks = this._marks.slice(-200);
    return mark;
  }

  _perfOrigin() {
    if (this._origin == null) {
      this._origin = performance.now() - (Date.now() - this._startedAt);
    }
    return this._origin;
  }

  /**
   * Merge facts into the open session. Only the sections named are touched, so recording a
   * playback figure cannot erase an analysis already made.
   */
  record(patch) {
    if (!this.current) return null;
    if (!isPlainObject(patch)) return null;
    for (const section of ['analysis', 'playback', 'input', 'simulation', 'integration', 'chart']) {
      if (!isPlainObject(patch[section])) continue;
      this.current[section] = { ...(this.current[section] || {}), ...patch[section] };
    }
    if (patch.seed != null) this.current.seed = patch.seed;
    this.emit('record', this.current);
    return this.current;
  }

  /** Attach an error without ending the session. */
  recordError(err) {
    if (!this.current) return null;
    const entry = {
      at: Date.now(),
      message: String(err?.message ?? err ?? 'unknown error').slice(0, 500),
      code: typeof err?.code === 'string' ? err.code : null,
    };
    this.current.errors = [...(this.current.errors || []), entry].slice(-50);
    this.emit('error', entry);
    return entry;
  }

  /**
   * Close the session and store it. `endedAt` is taken from the clock, so the duration is
   * measured rather than estimated.
   */
  async end(status = SessionStatus.COMPLETED, extra = null) {
    if (!this.current) return null;
    const endedAt = Date.now();
    this._marks.push({ name: 'end', at: Math.max(0, endedAt - this._startedAt), wallAt: endedAt });
    const finalStatus = Object.values(SessionStatus).includes(status) ? status : SessionStatus.COMPLETED;

    const record = normaliseSession({
      ...this.current,
      ...(isPlainObject(extra) ? extra : {}),
      id: this.current.id,
      status: finalStatus === SessionStatus.RUNNING ? SessionStatus.COMPLETED : finalStatus,
      endedAt,
      durationMs: Math.max(0, endedAt - this._startedAt),
      marks: this._marks.slice(-200),
    }, this.current);

    this.current = null;
    this._marks = [];
    this._origin = null;

    let saved = record;
    try {
      saved = await this.store.put(record);
    } catch (err) {
      // A store that cannot write must not take the session down with it.
      this.emit('store-error', err);
    }
    this.emit('end', saved);
    return saved;
  }

  /**
   * Convenience: run a function inside a session that always closes, even when it throws.
   * The session ends in `error` if the function did.
   */
  async wrap(options, fn) {
    await this.begin(options);
    try {
      const result = await fn(this);
      await this.end(SessionStatus.COMPLETED);
      return result;
    } catch (err) {
      this.recordError(err);
      await this.end(SessionStatus.ERROR);
      throw err;
    }
  }

  /** How long the open session has been running, in milliseconds. */
  get elapsedMs() {
    return this.current ? Math.max(0, Date.now() - this._startedAt) : 0;
  }

  /** Count of notes actually processed, when a session recorded one. */
  static notesProcessed(session) {
    if (!isPlainObject(session)) return 0;
    const fromAnalysis = num(session.analysis?.objectCount, 0);
    const fromInput = num(session.input?.scheduledNotes, 0);
    return Math.max(fromAnalysis, fromInput);
  }
}
