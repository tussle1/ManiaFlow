/**
 * The application store.
 *
 * One object holds everything the UI renders, and every screen reads it through a selector
 * subscription. That is what stops the two failure modes a hand-rolled UI usually hits:
 * two components keeping their own copy of the same fact, and a change in one place
 * re-rendering the whole screen.
 *
 * `subscribe(selector, listener)` compares the selected value with the previous one and
 * only calls the listener when it differs, so a page that watches `state.selectedChartId`
 * is untouched when an unrelated counter moves. Comparison is shallow, which is enough
 * because updates always replace the objects they change.
 */

import { Emitter } from '../utils/emitter.js';

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}

export class Store extends Emitter {
  constructor(initial = {}) {
    super();
    this._state = Object.freeze({ ...initial });
    this._subscriptions = [];
    this._seq = 0;
    this._batchDepth = 0;
    this._batchDirty = false;
  }

  get state() { return this._state; }

  /** Read one value. */
  select(selector) { return selector(this._state); }

  /**
   * Replace part of the state. Accepts a patch object or a function of the previous state.
   * Nested objects must be replaced whole; the store does not deep-merge, because a
   * deep merge is how two writers end up fighting over one field.
   */
  update(patch) {
    const next = typeof patch === 'function' ? patch(this._state) : patch;
    if (!next || typeof next !== 'object') return this._state;
    let changed = false;
    const merged = { ...this._state };
    for (const [key, value] of Object.entries(next)) {
      if (!Object.is(merged[key], value)) { merged[key] = value; changed = true; }
    }
    if (!changed) return this._state;
    this._state = Object.freeze(merged);
    this._notify();
    return this._state;
  }

  /**
   * Group several updates so subscribers run once. Used when opening a chart, which touches
   * the selection, the loaded chart and the status bar together.
   */
  batch(fn) {
    this._batchDepth++;
    try {
      fn(this);
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0 && this._batchDirty) {
        this._batchDirty = false;
        this._notifyNow();
      }
    }
  }

  _notify() {
    if (this._batchDepth > 0) { this._batchDirty = true; return; }
    this._notifyNow();
  }

  _notifyNow() {
    for (const subscription of [...this._subscriptions]) {
      let next;
      try {
        next = subscription.selector(this._state);
      } catch (err) {
        console.error('[ManiaFlow] a selector threw', err);
        continue;
      }
      if (shallowEqual(next, subscription.last)) continue;
      subscription.last = next;
      try {
        subscription.listener(next, this._state);
      } catch (err) {
        console.error('[ManiaFlow] a store listener threw', err);
      }
    }
    this.emit('change', this._state);
  }

  /**
   * Watch one slice. The listener runs immediately with the current value so a page does
   * not have to render twice on mount.
   * @returns {() => void} unsubscribe
   */
  subscribe(selector, listener, { immediate = true } = {}) {
    if (typeof selector !== 'function' || typeof listener !== 'function') {
      throw new TypeError('subscribe needs a selector and a listener');
    }
    const subscription = { id: ++this._seq, selector, listener, last: undefined };
    try {
      subscription.last = selector(this._state);
    } catch (err) {
      // Guarded here as well as in _notifyNow: a selector that throws must not stop a page
      // from mounting, and the first evaluation is the one most likely to be wrong.
      console.error('[ManiaFlow] a selector threw on subscribe', err);
    }
    this._subscriptions.push(subscription);
    if (immediate) {
      try {
        listener(subscription.last, this._state);
      } catch (err) {
        console.error('[ManiaFlow] a store listener threw on subscribe', err);
      }
    }
    return () => {
      const index = this._subscriptions.indexOf(subscription);
      if (index >= 0) this._subscriptions.splice(index, 1);
    };
  }

  /** Watch the whole state. Costs a comparison per update, so pages should prefer a selector. */
  subscribeAll(listener) { return this.subscribe((state) => state, listener); }

  get subscriptionCount() { return this._subscriptions.length; }

  /** Drop every subscription — used on teardown so a disposed page cannot be called. */
  clearSubscriptions() { this._subscriptions = []; }
}

/** The route table. One entry per screen, in sidebar order. */
export const ROUTES = Object.freeze([
  { path: '/', id: 'dashboard', title: 'Dashboard', group: 'Overview' },
  { path: '/library', id: 'library', title: 'Chart Library', group: 'Overview' },
  { path: '/practice', id: 'practice', title: 'Practice Studio', group: 'Tools' },
  { path: '/timing', id: 'timing', title: 'Timing Lab', group: 'Tools' },
  { path: '/input', id: 'input', title: 'Input Lab', group: 'Tools' },
  { path: '/statistics', id: 'statistics', title: 'Statistics', group: 'Overview' },
  { path: '/settings', id: 'settings', title: 'Settings', group: 'System' },
]);

export function routeById(id) { return ROUTES.find((route) => route.id === id) || null; }
export function routeByPath(path) { return ROUTES.find((route) => route.path === path) || null; }

/** The initial store contents. Every value here is real; nothing is seeded for appearance. */
export function initialAppState() {
  return {
    route: 'dashboard',
    ready: false,
    bootError: null,

    // charts
    charts: [],              // ChartRecord[], local and bridge together
    chartsSource: 'none',    // 'none' | 'local' | 'bridge' | 'both'
    selectedChartId: null,
    loadedChart: null,       // the ChartRecord with parsed notes, or null
    loadError: null,
    libraryError: null,
    importing: false,
    recents: [],

    // integration
    integration: null,       // IntegrationStatus
    gameState: null,
    osDetect: null,
    bridgeScriptUrl: null,
    bridgeToken: null,

    // playback / input
    playback: null,          // engine.describe()
    input: null,             // scheduler.describe()

    // sessions
    sessions: [],
    sessionHealth: null,
    activeSession: null,
    preferenceHealth: null,

    // ui
    toasts: [],
    dialog: null,
    statusMessage: null,
    busy: false,
  };
}
