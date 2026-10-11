/**
 * bridgeClient — the ManiaFlow side of the local WebSocket.
 *
 * The UI and the in-page bridge cannot talk to each other directly: they are on different
 * origins, and that is a boundary browsers enforce. Both connect to the ManiaFlow server,
 * which relays. This module owns that connection for the UI and nothing else — it does not
 * know what a chart is, which is the adapter's job.
 *
 * Responsibilities: connect and authenticate with the bridge token, reconnect with
 * backoff, correlate requests to replies by id, time out a reply that never comes, and
 * report connection state so the UI never has to guess.
 */

import { Emitter } from '../utils/emitter.js';
import { IntegrationError, ErrorCode } from '../utils/errors.js';
import { num } from '../utils/validation.js';

export const ConnectionState = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',          // socket open, not yet acknowledged
  READY: 'ready',                  // acknowledged by the server
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  ERROR: 'error',
});

let requestSeq = 0;

export class BridgeClient extends Emitter {
  /**
   * @param {object} config
   * @param {string} config.url absolute ws:// or wss:// address
   * @param {string} config.token bridge token from /api/config
   * @param {number} [config.requestTimeoutMs]
   * @param {typeof WebSocket} [config.WebSocket] injectable, for tests
   * @param {(ms:number)=>number} [config.now] injectable clock
   */
  constructor(config = {}) {
    super();
    if (!config.url) throw new IntegrationError('A bridge client needs a WebSocket URL');
    this.url = config.url;
    this.token = config.token || '';
    this.requestTimeoutMs = Math.max(500, num(config.requestTimeoutMs, 8000));
    // `WebSocket: null` has to mean "there is none" rather than falling back to the global,
    // which is why this is an `in` check and not a `||`. Node has a global WebSocket, so a
    // fallback here would silently substitute a real one in tests that ask for none.
    this.WebSocketImpl = 'WebSocket' in config
      ? config.WebSocket
      : (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.now = config.now || (() => Date.now());

    this.state = ConnectionState.IDLE;
    this.clientId = null;
    this.hub = { bridgeConnected: false, bridge: null, appClients: 0 };
    this.lastError = null;

    this._socket = null;
    this._pending = new Map();
    this._attempt = 0;
    this._reconnectTimer = 0;
    this._stopped = false;
    this._latency = null;
    this._lastPingAt = 0;
  }

  get isConnected() { return this.state === ConnectionState.READY && !!this._socket; }
  get bridgeConnected() { return !!this.hub.bridgeConnected; }
  get latencyMs() { return this._latency; }

  /** Open the connection. Calling it again while open is a no-op. */
  connect() {
    if (this._stopped) this._stopped = false;
    if (this._socket && (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.READY)) return this;
    if (!this.WebSocketImpl) {
      this._setState(ConnectionState.ERROR);
      this.lastError = new IntegrationError('This browser has no WebSocket support, so the bridge cannot be reached', {
        code: ErrorCode.BRIDGE_UNAVAILABLE,
      });
      this.emit('error', this.lastError);
      return this;
    }
    this._setState(ConnectionState.CONNECTING);
    this._open();
    return this;
  }

  _open() {
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.lastError = new IntegrationError(`The bridge endpoint could not be opened: ${err.message}`, {
        code: ErrorCode.BRIDGE_UNAVAILABLE, cause: err,
      });
      this._setState(ConnectionState.ERROR);
      this.emit('error', this.lastError);
      this._scheduleReconnect();
      return;
    }
    this._socket = socket;

    socket.addEventListener('open', () => {
      // Guarded: an `open` that arrives after the handshake has completed must not demote
      // the connection back to CONNECTED and re-authenticate.
      if (this.state === ConnectionState.READY || this.state === ConnectionState.CONNECTED) return;
      this._attempt = 0;
      this._setState(ConnectionState.CONNECTED);
      this._send({ type: 'hello', role: 'app', token: this.token });
    });

    socket.addEventListener('message', (event) => this._receive(event.data));

    socket.addEventListener('close', (event) => {
      this._socket = null;
      this._rejectAll(new IntegrationError(
        `The connection to ManiaFlow closed (${event.code || 'no code'})${event.reason ? `: ${event.reason}` : ''}`,
        { code: ErrorCode.BRIDGE_UNAVAILABLE },
      ));
      if (this._stopped) { this._setState(ConnectionState.CLOSED); return; }
      this._setState(ConnectionState.RECONNECTING);
      this._scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` follows every error and does the reporting; handling both would double up.
      this.lastError = new IntegrationError('The connection to the ManiaFlow server failed', { code: ErrorCode.BRIDGE_UNAVAILABLE });
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = Math.min(15000, 400 * 2 ** Math.min(this._attempt++, 5));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = 0;
      if (!this._stopped) this._open();
    }, delay);
    this.emit('reconnect', { delay, attempt: this._attempt });
  }

  _receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // a non-JSON frame is not ours
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'hello:ok':
        this.clientId = message.clientId ?? null;
        this.hub = message.hub || this.hub;
        this._setState(ConnectionState.READY);
        this.emit('ready', { clientId: this.clientId, hub: this.hub });
        this._startPing();
        break;

      case 'hello:error':
        this.lastError = new IntegrationError(message.message || 'The server refused this connection', {
          code: ErrorCode.BRIDGE_REFUSED,
        });
        this.emit('error', this.lastError);
        break;

      case 'bridge:status':
        this.hub = message.payload || this.hub;
        this.emit('hub', this.hub);
        this.emit(this.hub.bridgeConnected ? 'bridge:connected' : 'bridge:disconnected', this.hub);
        break;

      case 'relay':
        if (message.from === 'bridge') this.emit('bridge-message', message.message);
        this._resolvePending(message.message);
        break;

      case 'relay:error':
        this._failPending(message.replyTo, new IntegrationError(message.message || 'The bridge is not connected', {
          code: ErrorCode.BRIDGE_UNAVAILABLE,
        }));
        break;

      case 'bridge:pong':
        if (this._lastPingAt) {
          this._latency = Math.max(0, this.now() - this._lastPingAt);
          this.emit('latency', this._latency);
        }
        break;

      case 'os-input:detect:result':
      case 'os-input:arm:result':
      case 'os-input:disarm:result':
      case 'os-input:key:result':
      case 'os-input:run:accepted':
      case 'os-input:run:result':
      case 'os-input:stop:result':
      case 'os-input:error':
      case 'os-input:armed':
      case 'os-input:disarmed':
      case 'os-input:stopped':
      case 'os-input:run:start':
      case 'os-input:run:end':
      case 'os-input:key':
        this.emit('os-input', message);
        this._resolvePending(message);
        break;

      case 'error':
        this._failPending(message.id, new IntegrationError(message.message || 'The server reported an error', { code: ErrorCode.UNKNOWN }));
        break;

      default:
        this.emit('message', message);
        this._resolvePending(message);
    }
  }

  _resolvePending(message) {
    const id = message?.id;
    if (id == null || !this._pending.has(id)) return;
    const entry = this._pending.get(id);
    clearTimeout(entry.timer);
    this._pending.delete(id);
    // A reply that says the request failed is still a successful round trip.
    if (message.ok === false && message.error) {
      entry.reject(new IntegrationError(String(message.error), {
        code: message.code === 'gate-refused' ? ErrorCode.INPUT_GATE_REFUSED : ErrorCode.GAME_UNSUPPORTED,
        detail: { kind: message.kind, id },
      }));
      return;
    }
    entry.resolve(message);
  }

  _failPending(id, error) {
    if (id == null) return;
    const entry = this._pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this._pending.delete(id);
    entry.reject(error);
  }

  _rejectAll(error) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  _send(message) {
    if (!this._socket || this._socket.readyState !== 1) return false;
    this._socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Send a message and wait for the reply carrying the same id.
   * @param {object} message
   * @param {{ timeoutMs?: number }} [options]
   */
  request(message, options = {}) {
    if (!this.isConnected) {
      return Promise.reject(new IntegrationError('Not connected to the ManiaFlow server', { code: ErrorCode.BRIDGE_UNAVAILABLE }));
    }
    const id = `r${++requestSeq}`;
    const timeoutMs = Math.max(250, num(options.timeoutMs, this.requestTimeoutMs));
    // A relayed request carries its kind one level down, inside the bridge envelope. Naming
    // it in the error is what makes a timeout diagnosable when several are in flight.
    const label = message.kind || message.message?.kind || message.type || 'request';
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        rejectRequest(new IntegrationError(
          `No reply within ${Math.round(timeoutMs)} ms for "${label}"`,
          { code: ErrorCode.BRIDGE_TIMEOUT, detail: { id, label } },
        ));
      }, timeoutMs);
      this._pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      if (!this._send({ ...message, id })) {
        clearTimeout(timer);
        this._pending.delete(id);
        rejectRequest(new IntegrationError('The connection dropped while sending', { code: ErrorCode.BRIDGE_UNAVAILABLE }));
      }
    });
  }

  /** Send to the in-page bridge and await its reply. */
  requestBridge(kind, args = {}, options = {}) {
    return this.request({ type: 'relay', to: 'bridge', message: { type: 'mf:request', kind, args } }, options);
  }

  /** Fire-and-forget to the bridge. Returns false when there is no bridge to send to. */
  postBridge(message) {
    return this._send({ type: 'relay', to: 'bridge', message });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (!this.isConnected) return;
      this._lastPingAt = this.now();
      this._send({ type: 'bridge:ping' });
    }, 5000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = 0; }
  }

  _setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.emit('state', { state, previous });
  }

  /** A snapshot for the integration panel and for diagnostics. */
  describe() {
    return {
      state: this.state,
      connected: this.isConnected,
      bridgeConnected: this.hub.bridgeConnected,
      bridge: this.hub.bridge || null,
      appClients: this.hub.appClients || 0,
      clientId: this.clientId,
      latencyMs: this._latency,
      pendingRequests: this._pending.size,
      attempt: this._attempt,
      lastError: this.lastError ? this.lastError.message : null,
      url: this.url,
    };
  }

  /** Close for good: no reconnect, all pending requests rejected. */
  dispose() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = 0;
    this._stopPing();
    this._rejectAll(new IntegrationError('The bridge client was disposed', { code: ErrorCode.BRIDGE_UNAVAILABLE }));
    if (this._socket) {
      try { this._socket.close(1000, 'client disposed'); } catch { /* already closed */ }
      this._socket = null;
    }
    this._setState(ConnectionState.CLOSED);
    this.removeAll();
  }
}
