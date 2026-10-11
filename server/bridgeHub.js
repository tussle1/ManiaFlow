/**
 * The relay between the ManiaFlow UI and the in-page bridge script.
 *
 * Both sides are ordinary WebSocket clients of the ManiaFlow server. Neither can reach the
 * other directly: the UI is on `127.0.0.1` and the game is on `ashtonkmania.vercel.app`,
 * which is a cross-origin boundary browsers enforce. This hub is the documented meeting
 * point, and it owns exactly one source of truth about who is connected.
 *
 * Roles
 *   app     a ManiaFlow UI tab. Several may connect; all of them see the same state.
 *   bridge  the script running inside the game page. Only one is ever active: a second
 *           connection takes over and the first is closed, so two tabs of the game can
 *           never both drive input.
 *
 * Security: every client must present the bridge token in its `hello`. A random web page
 * can open a WebSocket to localhost, so the token is what stops it from posing as a bridge
 * or from reading chart data. It is not a secret from anyone who can load the ManiaFlow UI.
 */
import { EventEmitter } from 'node:events';

export class BridgeHub extends EventEmitter {
  constructor({ token, timingSafeEqual }) {
    super();
    this.token = token;
    this.timingSafeEqual = timingSafeEqual;
    /** @type {Set<import('./websocket.js').Socket>} */
    this.apps = new Set();
    /** @type {import('./websocket.js').Socket|null} */
    this.bridge = null;
    this.bridgeInfo = null;
    this._clientSeq = 0;
  }

  /** Attach to a WebSocket server produced by ./websocket.js. */
  attach(wss) {
    this.wss = wss;
    wss.on('connection', (socket) => this._onConnection(socket));
    return this;
  }

  _onConnection(socket) {
    socket.clientId = `c${++this._clientSeq}`;
    socket.role = null;
    let greeted = false;

    // A client that never identifies itself is dropped: it can neither relay nor be relayed to.
    const helloTimer = setTimeout(() => {
      if (!greeted) socket.close(4001, 'no hello received');
    }, 5000);

    socket.on('message', (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'hello') {
        if (greeted) return;
        greeted = true;
        clearTimeout(helloTimer);
        this._handleHello(socket, message);
        return;
      }
      if (!socket.role) {
        socket.send(JSON.stringify({ type: 'error', message: 'send hello first' }));
        return;
      }
      this._handleMessage(socket, message);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      this._detach(socket);
    });
    socket.on('error', () => {
      clearTimeout(helloTimer);
      this._detach(socket);
    });
  }

  _handleHello(socket, message) {
    if (!this._tokenMatches(message.token)) {
      socket.send(JSON.stringify({ type: 'hello:error', message: 'Bridge token mismatch. Copy the current token from ManiaFlow → Settings → Integration.' }));
      socket.close(4003, 'bad token');
      return;
    }
    const role = message.role === 'bridge' ? 'bridge' : message.role === 'app' ? 'app' : null;
    if (!role) {
      socket.send(JSON.stringify({ type: 'hello:error', message: 'role must be "app" or "bridge"' }));
      socket.close(4002, 'bad role');
      return;
    }
    socket.role = role;

    if (role === 'bridge') {
      // Only one bridge drives the game at a time. The newest wins; the older is told why.
      if (this.bridge && this.bridge !== socket) {
        const previous = this.bridge;
        this.bridge = null;
        try { previous.close(4009, 'replaced by a newer bridge'); } catch { /* already gone */ }
        previous.send?.(JSON.stringify({ type: 'relay', from: 'app', message: { type: 'mf:superseded' } }));
      }
      this.bridge = socket;
      this.bridgeInfo = normaliseBridgeInfo(message);
      socket.send(JSON.stringify({ type: 'hello:ok', role, clientId: socket.clientId, hub: this.snapshot() }));
      this._broadcastToApps({ type: 'bridge:status', payload: this.snapshot() });
      this.emit('bridge:connected', this.bridgeInfo);
      return;
    }

    this.apps.add(socket);
    socket.send(JSON.stringify({ type: 'hello:ok', role, clientId: socket.clientId, hub: this.snapshot() }));
  }

  _tokenMatches(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return this.timingSafeEqual(a, b);
  }

  _handleMessage(socket, message) {
    switch (message.type) {
      case 'relay': {
        const payload = message.message;
        if (!payload || typeof payload.type !== 'string') return;
        if (socket.role === 'app') {
          if (!this.bridge) {
            socket.send(JSON.stringify({ type: 'relay:error', message: 'no bridge is connected', replyTo: payload.id ?? null }));
            return;
          }
          this.bridge.send(JSON.stringify({ type: 'relay', from: 'app', message: payload }));
        } else {
          this._broadcastToApps({ type: 'relay', from: 'bridge', message: payload });
        }
        return;
      }
      case 'bridge:ping':
        socket.send(JSON.stringify({ type: 'bridge:pong', at: Date.now() }));
        return;
      default:
        // Anything else is the server's own concern (OS input), handled in server/index.js.
        this.emit('message', { socket, message });
    }
  }

  _detach(socket) {
    if (socket.role === 'app') this.apps.delete(socket);
    if (this.bridge === socket) {
      this.bridge = null;
      this.bridgeInfo = null;
      this._broadcastToApps({ type: 'bridge:status', payload: this.snapshot() });
      this.emit('bridge:disconnected', {});
    }
  }

  /** Send to the bridge if one is connected. Returns false when there is nobody to send to. */
  sendToBridge(message) {
    if (!this.bridge) return false;
    this.bridge.send(JSON.stringify({ type: 'relay', from: 'app', message }));
    return true;
  }

  _broadcastToApps(message) {
    const text = JSON.stringify(message);
    for (const socket of this.apps) socket.send(text);
  }

  /** The one authoritative description of hub state. */
  snapshot() {
    return {
      bridgeConnected: !!this.bridge,
      bridge: this.bridgeInfo,
      appClients: this.apps.size,
    };
  }

  close() {
    for (const socket of [...this.apps]) {
      try { socket.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    if (this.bridge) {
      try { this.bridge.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    this.apps.clear();
    this.bridge = null;
    this.bridgeInfo = null;
  }
}

/** Keep only the fields the UI actually shows, so a malformed hello cannot inject anything. */
function normaliseBridgeInfo(message) {
  const info = message.info && typeof message.info === 'object' ? message.info : {};
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    bridgeVersion: text(info.bridgeVersion, 32) || 'unknown',
    gameVersion: text(info.gameVersion, 64),
    url: text(info.url, 512),
    origin: text(info.origin, 256),
    userAgent: text(info.userAgent, 256),
    capabilities: Array.isArray(info.capabilities) ? info.capabilities.slice(0, 32).map((c) => text(c, 48)).filter(Boolean) : [],
    connectedAt: Date.now(),
    latencyMs: num(info.latencyMs),
  };
}
