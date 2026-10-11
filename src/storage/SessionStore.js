/**
 * SessionStore — the record of what ManiaFlow itself did.
 *
 * Every number the Statistics page shows comes out of here, and nothing gets in except what
 * a session actually produced. There is no seeded demo data and no synthetic history: an
 * empty store means the UI shows an empty state.
 *
 * Storage is IndexedDB, with two fallbacks that are chosen at `init()` and never switched
 * mid-session: `localStorage` when IndexedDB is unavailable (private browsing, a blocked
 * quota), and memory when neither is. Which one is in use is part of `health`, so the UI can
 * tell the user that their history will not survive a reload instead of letting them find
 * out later.
 */

import { Emitter } from '../utils/emitter.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { isPlainObject, num } from '../utils/validation.js';

const DB_NAME = 'maniaflow';
const DB_VERSION = 1;
const STORE = 'sessions';
const LS_KEY = 'maniaflow.sessions.v1';
const LS_LIMIT = 60; // localStorage is small; keep the most recent sessions only

export const SessionKind = Object.freeze({
  PRACTICE: 'practice',
  ANALYSIS: 'analysis',
  SIMULATION: 'simulation',
  INPUT: 'input',
});

export const SessionStatus = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
});

const KINDS = Object.values(SessionKind);
const STATUSES = Object.values(SessionStatus);

/** Validate a session before it is stored. A partial record is repaired, not rejected. */
export function normaliseSession(input, existing = null) {
  const source = isPlainObject(input) ? input : {};
  const previous = isPlainObject(existing) ? existing : {};
  const id = typeof source.id === 'string' && source.id ? source.id : previous.id || newId();
  const startedAt = num(source.startedAt ?? previous.startedAt, Date.now());
  const endedAt = source.endedAt != null ? num(source.endedAt, null) : previous.endedAt ?? null;

  return {
    id,
    kind: KINDS.includes(source.kind ?? previous.kind) ? (source.kind ?? previous.kind) : SessionKind.ANALYSIS,
    status: STATUSES.includes(source.status ?? previous.status) ? (source.status ?? previous.status) : SessionStatus.COMPLETED,
    startedAt,
    endedAt,
    durationMs: endedAt != null ? Math.max(0, endedAt - startedAt) : Math.max(0, num(source.durationMs ?? previous.durationMs, 0)),

    chart: normaliseChart(source.chart ?? previous.chart),
    analysis: isPlainObject(source.analysis ?? previous.analysis) ? { ...(previous.analysis || {}), ...(source.analysis || {}) } : null,
    playback: isPlainObject(source.playback ?? previous.playback) ? { ...(previous.playback || {}), ...(source.playback || {}) } : null,
    input: isPlainObject(source.input ?? previous.input) ? { ...(previous.input || {}), ...(source.input || {}) } : null,
    simulation: isPlainObject(source.simulation ?? previous.simulation) ? { ...(previous.simulation || {}), ...(source.simulation || {}) } : null,
    integration: isPlainObject(source.integration ?? previous.integration) ? { ...(previous.integration || {}), ...(source.integration || {}) } : null,

    errors: Array.isArray(source.errors) ? source.errors.slice(-50).map(normaliseError)
      : Array.isArray(previous.errors) ? previous.errors : [],
    marks: Array.isArray(source.marks) ? source.marks.slice(-200) : Array.isArray(previous.marks) ? previous.marks : [],
    seed: source.seed ?? previous.seed ?? null,
    appVersion: source.appVersion ?? previous.appVersion ?? null,
  };
}

function normaliseChart(chart) {
  if (!isPlainObject(chart)) return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  return {
    id: text(chart.id, 128),
    hash: text(chart.hash, 128),
    title: text(chart.title, 256),
    artist: text(chart.artist, 256),
    version: text(chart.version, 128),
    creator: text(chart.creator, 128),
    keys: num(chart.keys, 0),
    source: chart.source === 'bridge' ? 'bridge' : 'local',
    stars: Number.isFinite(num(chart.stars, Number.NaN)) ? num(chart.stars) : null,
  };
}

function normaliseError(err) {
  if (!isPlainObject(err)) return { at: Date.now(), message: String(err).slice(0, 500), code: null };
  return {
    at: num(err.at, Date.now()),
    message: String(err.message ?? '').slice(0, 500),
    code: typeof err.code === 'string' ? err.code.slice(0, 64) : null,
  };
}

export function newId() {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `s-${Date.now().toString(36)}-${random}`;
}

export class SessionStore extends Emitter {
  constructor(options = {}) {
    super();
    this.limit = Math.max(1, Math.round(num(options.limit, 200)));
    this.health = { backend: 'none', available: false, reason: null, count: 0 };
    this._db = null;
    this._memory = [];
    this._ready = null;
  }

  /** Open storage. Safe to call more than once; the first call decides the backend. */
  init() {
    if (this._ready) return this._ready;
    this._ready = this._open().then(() => this.count()).then((count) => {
      this.health = { ...this.health, count };
      this.emit('health', this.health);
      return this.health;
    }).catch((err) => {
      this.health = { backend: 'memory', available: true, reason: `Session history is in memory only: ${err.message}`, count: 0 };
      this.emit('health', this.health);
      return this.health;
    });
    return this._ready;
  }

  async _open() {
    if (typeof indexedDB === 'undefined') {
      return this._openLocalStorage('IndexedDB is not available in this browser');
    }
    try {
      this._db = await new Promise((resolveOpen, rejectOpen) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        const timer = setTimeout(() => rejectOpen(new Error('IndexedDB did not respond within 5 s')), 5000);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' });
            store.createIndex('startedAt', 'startedAt');
            store.createIndex('kind', 'kind');
          }
        };
        request.onsuccess = () => { clearTimeout(timer); resolveOpen(request.result); };
        request.onerror = () => { clearTimeout(timer); rejectOpen(request.error || new Error('IndexedDB refused to open')); };
        request.onblocked = () => { clearTimeout(timer); rejectOpen(new Error('IndexedDB is blocked by another tab')); };
      });
      this._db.onversionchange = () => { this._db.close(); this._db = null; };
      this.health = { backend: 'indexeddb', available: true, reason: null, count: 0 };
      return this.health;
    } catch (err) {
      this._db = null;
      return this._openLocalStorage(err.message);
    }
  }

  _openLocalStorage(reason) {
    if (typeof localStorage === 'undefined') {
      this.health = { backend: 'memory', available: true, reason: `${reason}; localStorage is unavailable too, so history lasts for this session only`, count: 0 };
      return this.health;
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      this._memory = raw ? (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []) : [];
    } catch {
      this._memory = [];
    }
    this.health = { backend: 'localstorage', available: true, reason: `${reason}; history is kept in localStorage (the most recent ${LS_LIMIT} sessions)`, count: this._memory.length };
    return this.health;
  }

  /* ── writes ───────────────────────────────────────────────────────── */

  /** Store a new session, or replace one with the same id. */
  async put(session) {
    const record = normaliseSession(session);
    await this._write(record);
    this.emit('change', { type: 'put', record });
    return record;
  }

  /** Merge fields into a stored session. Missing sessions are created, not invented. */
  async update(id, patch) {
    const existing = await this.get(id);
    const record = normaliseSession({ ...(patch || {}), id }, existing);
    await this._write(record);
    this.emit('change', { type: 'update', record });
    return record;
  }

  async _write(record) {
    if (this._db) {
      await this._tx('readwrite', (store) => store.put(record));
      await this._prune();
      return record;
    }
    if (this.health.backend === 'localstorage') {
      const index = this._memory.findIndex((s) => s.id === record.id);
      if (index >= 0) this._memory[index] = record;
      else this._memory.push(record);
      this._memory.sort((a, b) => b.startedAt - a.startedAt);
      if (this._memory.length > LS_LIMIT) this._memory.length = LS_LIMIT;
      this._persistLocalStorage();
      return record;
    }
    const index = this._memory.findIndex((s) => s.id === record.id);
    if (index >= 0) this._memory[index] = record;
    else this._memory.push(record);
    this._memory.sort((a, b) => b.startedAt - a.startedAt);
    if (this._memory.length > this.limit) this._memory.length = this.limit;
    return record;
  }

  _persistLocalStorage() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this._memory));
    } catch (err) {
      // Running out of room must not lose the session in hand.
      this.health = { ...this.health, reason: `Session history could not be saved: ${err.message}` };
      this.emit('health', this.health);
    }
  }

  /** Drop the oldest sessions beyond the configured limit. */
  async _prune() {
    if (!this._db) return;
    const all = await this.list({ limit: Number.MAX_SAFE_INTEGER });
    if (all.length <= this.limit) return;
    const doomed = all.slice(this.limit);
    await this._tx('readwrite', (store) => { for (const record of doomed) store.delete(record.id); });
  }

  /* ── reads ────────────────────────────────────────────────────────── */

  async get(id) {
    if (!id) return null;
    if (this._db) {
      const found = await this._tx('readonly', (store) => store.get(id));
      return found ?? null;
    }
    return this._memory.find((s) => s.id === id) || null;
  }

  /** Newest first. `kind` filters; `limit` and `offset` page. */
  async list({ limit = 50, offset = 0, kind = null, status = null } = {}) {
    const take = Math.max(1, Math.min(5000, Math.round(num(limit, 50))));
    const skip = Math.max(0, Math.round(num(offset, 0)));
    let all;
    if (this._db) {
      all = await this._tx('readonly', (store) => store.index('startedAt').getAll());
      all.reverse();
    } else {
      all = [...this._memory].sort((a, b) => b.startedAt - a.startedAt);
    }
    if (kind) all = all.filter((s) => s.kind === kind);
    if (status) all = all.filter((s) => s.status === status);
    return all.slice(skip, skip + take);
  }

  async count() {
    if (this._db) return this._tx('readonly', (store) => store.count());
    return this._memory.length;
  }

  /** Sessions for one chart, newest first — the "recently opened" list. */
  async forChart(chartId, limit = 8) {
    if (!chartId) return [];
    const all = await this.list({ limit: 1000 });
    return all.filter((s) => s.chart?.id === chartId).slice(0, Math.max(1, limit));
  }

  /**
   * Distinct charts that have a session, most recent first.
   * One pass: the list is already newest-first, so the first sighting of a chart id is its
   * most recent session and every sighting adds to the count.
   */
  async recentCharts(limit = 8) {
    const all = await this.list({ limit: 1000 });
    const seen = new Map();
    for (const session of all) {
      const chart = session.chart;
      if (!chart?.id) continue;   // a session with no chart does not invent one
      let entry = seen.get(chart.id);
      if (!entry) {
        entry = { chart, at: session.startedAt, kind: session.kind, sessions: 0, lastSession: session };
        seen.set(chart.id, entry);
      }
      entry.sessions++;
    }
    return [...seen.values()].slice(0, Math.max(1, limit));
  }

  /* ── destructive ──────────────────────────────────────────────────── */

  async remove(id) {
    if (!id) return false;
    if (this._db) await this._tx('readwrite', (store) => store.delete(id));
    else {
      const index = this._memory.findIndex((s) => s.id === id);
      if (index < 0) return false;
      this._memory.splice(index, 1);
      if (this.health.backend === 'localstorage') this._persistLocalStorage();
    }
    this.emit('change', { type: 'remove', id });
    return true;
  }

  async clear() {
    if (this._db) await this._tx('readwrite', (store) => store.clear());
    else {
      this._memory = [];
      if (this.health.backend === 'localstorage') this._persistLocalStorage();
    }
    this.emit('change', { type: 'clear' });
    return true;
  }

  /** Every session, oldest first, for export. */
  async exportAll() {
    const all = await this.list({ limit: Number.MAX_SAFE_INTEGER });
    return {
      exportedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      backend: this.health.backend,
      count: all.length,
      sessions: all.slice().reverse(),
    };
  }

  /**
   * Import a previously exported file. Sessions that cannot be read are skipped and
   * counted, so a partly corrupt export still brings in what it can.
   */
  async importAll(data) {
    const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.sessions) ? data.sessions : null;
    if (!list) throw new AppError('That is not a ManiaFlow session export', { code: ErrorCode.STORAGE_READ });
    let imported = 0;
    const skipped = [];
    for (const [index, entry] of list.entries()) {
      if (!isPlainObject(entry) || !Number.isFinite(num(entry.startedAt, Number.NaN))) {
        skipped.push({ index, reason: 'not a session record' });
        continue;
      }
      await this.put(entry);
      imported++;
    }
    this.emit('change', { type: 'import', imported, skipped: skipped.length });
    return { imported, skipped };
  }

  /* ── IndexedDB plumbing ───────────────────────────────────────────── */

  /**
   * Run one transaction and resolve with the request's result.
   * IndexedDB reports failures on three different objects; this collapses them into one
   * promise so callers never have to think about `onupgradeneeded` racing `onerror`.
   */
  _tx(mode, operation) {
    return new Promise((resolveTx, rejectTx) => {
      let transaction;
      try {
        transaction = this._db.transaction(STORE, mode);
      } catch (err) {
        rejectTx(new AppError(`Session storage is unavailable: ${err.message}`, { code: ErrorCode.STORAGE_UNAVAILABLE, cause: err }));
        return;
      }
      let result;
      const request = operation(transaction.objectStore(STORE));
      if (request) request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolveTx(result);
      transaction.onabort = () => rejectTx(new AppError(
        `Session storage aborted the write: ${transaction.error?.message || 'unknown reason'}`,
        { code: ErrorCode.STORAGE_WRITE, cause: transaction.error },
      ));
      transaction.onerror = () => rejectTx(new AppError(
        `Session storage error: ${transaction.error?.message || 'unknown reason'}`,
        { code: ErrorCode.STORAGE_WRITE, cause: transaction.error },
      ));
    });
  }

  setLimit(limit) {
    this.limit = Math.max(1, Math.round(num(limit, 200)));
    this._prune().catch(() => {});
    return this.limit;
  }

  dispose() {
    if (this._db) { try { this._db.close(); } catch { /* already closed */ } }
    this._db = null;
    this._memory = [];
    this.removeAll();
  }
}
