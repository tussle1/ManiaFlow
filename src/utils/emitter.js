/**
 * A tiny event emitter.
 *
 * Shared by the playback engine, the state store, the bridge client and the session
 * recorder, so all four have identical semantics: `on` returns an unsubscribe function,
 * listeners are called in registration order, and a listener that throws is reported
 * without stopping the others.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} type
   * @param {Function} listener
   * @returns {() => void} unsubscribe
   */
  on(type, listener) {
    if (typeof listener !== 'function') throw new TypeError('A listener must be a function');
    let set = this._listeners.get(type);
    if (!set) { set = new Set(); this._listeners.set(type, set); }
    set.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      set.delete(listener);
      if (!set.size) this._listeners.delete(type);
    };
  }

  /** Listen once. */
  once(type, listener) {
    const off = this.on(type, (...args) => { off(); listener(...args); });
    return off;
  }

  off(type, listener) {
    const set = this._listeners.get(type);
    if (!set) return false;
    const removed = set.delete(listener);
    if (!set.size) this._listeners.delete(type);
    return removed;
  }

  /** @returns {boolean} whether anything received the event */
  emit(type, ...args) {
    const set = this._listeners.get(type);
    if (!set || !set.size) return false;
    // Copied so a listener that unsubscribes during the emit cannot skip the next one.
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[ManiaFlow] listener for "${type}" threw`, err);
      }
    }
    return true;
  }

  listenerCount(type) {
    return this._listeners.get(type)?.size ?? 0;
  }

  removeAll(type) {
    if (type) this._listeners.delete(type);
    else this._listeners.clear();
  }
}
