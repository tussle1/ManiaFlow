/**
 * A minimal RFC 6455 WebSocket server.
 *
 * ManiaFlow has zero runtime dependencies on purpose: it must install, start and run on a
 * plain Node install with nothing to download. Node has an HTTP server and a crypto module
 * but no WebSocket server, so the framing lives here — about 200 lines, and it is exercised
 * by tests/websocket.test.js.
 *
 * Implemented: the opening handshake, text and binary frames, continuation frames, client
 * masking (mandatory on the client side, rejected when absent), 7/16/64-bit payload lengths,
 * ping/pong, close handshake, and automatic fragmentation of large outbound messages.
 * Not implemented (deliberately): the permessage-deflate extension. It is negotiated away,
 * which every browser handles.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Compute the `Sec-WebSocket-Accept` value for a client key (RFC 6455 §1.3). */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

class Socket extends EventEmitter {
  constructor(stream, request) {
    super();
    this.stream = stream;
    this.request = request;
    this.readyState = Socket.OPEN;
    this._out = [];
    this._fragments = null;
    this._fragmentOp = 0;
    this._buffer = Buffer.alloc(0);
    this._closed = false;
    this.remoteAddress = stream.socket?.remoteAddress ?? '';

    stream.on('data', (chunk) => this._onData(chunk));
    stream.on('error', (err) => this._fail(err));
    stream.on('close', () => this._finish(1006, 'connection closed'));
    stream.on('end', () => this._finish(1006, 'connection ended'));
  }

  /** Send a text message. Large messages are split into continuation frames. */
  send(data) {
    if (this.readyState !== Socket.OPEN) return false;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    // Fragments above 512 KiB so a big chart upload does not sit in one giant frame.
    const CHUNK = 512 * 1024;
    if (payload.length <= CHUNK) {
      this._writeFrame(OP.TEXT, payload);
      return true;
    }
    let offset = 0;
    let first = true;
    while (offset < payload.length) {
      const slice = payload.subarray(offset, offset + CHUNK);
      this._writeFrame(first ? OP.TEXT : OP.CONT, slice, offset + CHUNK >= payload.length);
      first = false;
      offset += CHUNK;
    }
    return true;
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState === Socket.OPEN) this._writeFrame(OP.PING, payload);
  }

  /** Begin the close handshake. */
  close(code = 1000, reason = '') {
    if (this.readyState !== Socket.OPEN) return;
    this.readyState = Socket.CLOSING;
    this._writeFrame(OP.CLOSE, closePayload(code, reason));
    // If the peer never answers, drop the stream anyway.
    this._closeTimer = setTimeout(() => this._destroy(), 2000);
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    let frame;
    while ((frame = this._readFrame())) {
      if (frame === 'need-more') break;
    }
  }

  /**
   * Parse one frame from the buffer. Returns true when a frame was consumed,
   * 'need-more' when the buffer is incomplete, and null on a protocol error.
   */
  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return 'need-more';
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) return this._protocolError('RSV bits must be clear (no extensions negotiated)');
    // A client must mask every frame it sends (RFC 6455 §5.1).
    if (!masked) return this._protocolError('client frames must be masked');

    if (len === 126) {
      if (buf.length < offset + 2) return 'need-more';
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return 'need-more';
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      if (hi !== 0 || lo > MAX_MESSAGE_BYTES) return this._protocolError('frame too large');
      len = lo;
      offset += 8;
    }
    if (len > MAX_MESSAGE_BYTES) return this._protocolError('frame too large');
    if (buf.length < offset + 4 + len) return 'need-more';

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buffer = buf.subarray(offset + len);

    switch (opcode) {
      case OP.PING:
        this._writeFrame(OP.PONG, payload);
        return true;
      case OP.PONG:
        this.emit('pong', payload);
        return true;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.readyState === Socket.OPEN) {
          this.readyState = Socket.CLOSING;
          this._writeFrame(OP.CLOSE, closePayload(code, reason));
        }
        this._finish(code, reason);
        return true;
      }
      case OP.TEXT:
      case OP.BIN:
      case OP.CONT: {
        if (opcode === OP.CONT) {
          if (!this._fragments) return this._protocolError('unexpected continuation frame');
          this._fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(this._fragments);
            const type = this._fragmentOp;
            this._fragments = null;
            this._deliver(type, full);
          }
        } else {
          if (this._fragments) return this._protocolError('expected continuation frame');
          if (fin) this._deliver(opcode, payload);
          else {
            this._fragments = [payload];
            this._fragmentOp = opcode;
          }
        }
        return true;
      }
      default:
        return this._protocolError(`unknown opcode ${opcode}`);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      const text = payload.toString('utf8');
      this.emit('message', text);
      return;
    }
    this.emit('binary', payload);
  }

  _writeFrame(opcode, payload, fin = true) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = (fin ? 0x80 : 0) | opcode;
    // Server frames are never masked.
    try {
      this.stream.write(Buffer.concat([header, payload]));
    } catch (err) {
      this._fail(err);
    }
  }

  _protocolError(message) {
    this._finish(1002, message);
    return null;
  }

  _fail(err) {
    if (this._closed) return;
    this.emit('error', err);
    this._finish(1006, err.message);
  }

  _finish(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = Socket.CLOSED;
    clearTimeout(this._closeTimer);
    clearTimeout(this._pingTimer);
    this.emit('close', { code, reason });
    this._destroy();
    this.removeAllListeners('message');
  }

  _destroy() {
    try {
      this.stream.destroy();
    } catch {
      /* already gone */
    }
  }
}

Socket.CONNECTING = 0;
Socket.OPEN = 1;
Socket.CLOSING = 2;
Socket.CLOSED = 3;

function closePayload(code, reason) {
  const r = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
  const out = Buffer.alloc(2 + r.length);
  out.writeUInt16BE(code, 0);
  r.copy(out, 2);
  return out;
}

/**
 * Attach a WebSocket server to an existing `node:http` server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ path?: string, keepAliveMs?: number }} [options]
 */
export function createWebSocketServer(httpServer, options = {}) {
  const path = options.path || '/';
  const keepAliveMs = options.keepAliveMs ?? 25000;
  const server = new EventEmitter();
  server.clients = new Set();

  httpServer.on('upgrade', (request, stream, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path) {
      stream.write('HTTP/1.1 404 Not Found\r\n\r\n');
      stream.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      stream.write('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\n\r\n');
      stream.destroy();
      return;
    }
    stream.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const socket = new Socket(stream, request);
    if (head && head.length) socket._onData(head);
    server.clients.add(socket);
    socket._pingTimer = setInterval(() => socket.ping(), keepAliveMs);
    socket.on('close', () => {
      clearInterval(socket._pingTimer);
      server.clients.delete(socket);
    });
    server.emit('connection', socket, request);
  });

  server.close = () => {
    for (const client of [...server.clients]) client.close(1001, 'server shutting down');
    server.clients.clear();
  };
  server.broadcast = (data) => {
    for (const client of server.clients) client.send(data);
  };
  return server;
}

export { Socket, OP, randomBytes };
