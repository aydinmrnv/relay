import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The server side of a WebSocket, and only as much of RFC 6455 as the hub
 * needs: text messages, fragmentation, ping, pong and close.
 *
 * Node has a WebSocket client built in (the runner uses it) but no server,
 * and Relay keeps its dependencies to what it cannot do without. The only
 * peer is Relay's own runner, but the endpoint faces the internet, so
 * everything a stranger could send is bounded: a frame larger than
 * `maxPayload` closes the connection before it is buffered, an unmasked
 * client frame is a protocol error, and a connection that stops answering
 * pings is cut.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsOptions {
  /** The largest message accepted, whole. Default 4 MiB. */
  maxPayload?: number;
  /** How often to ping; a peer silent for two intervals is cut. Default 20 s. */
  pingIntervalMs?: number;
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** Whether an HTTP request is asking to become a WebSocket this server can speak. */
export function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const upgrade = (request.headers.upgrade ?? '').toLowerCase();
  return upgrade === 'websocket' && request.headers['sec-websocket-version'] === '13' && typeof request.headers['sec-websocket-key'] === 'string';
}

/** Refuses an upgrade with a plain HTTP answer and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required', 503: 'Service Unavailable' }[status] ?? 'Error';
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** Completes the handshake and wraps the socket. Call only after `isWebSocketUpgrade`. */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, options: WsOptions = {}): WsConnection {
  const key = request.headers['sec-websocket-key'] as string;
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
  );
  return new WsConnection(socket, head, options);
}

export class WsConnection {
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;
  private closed = false;
  private closeSent = false;
  private alive = true;
  private readonly pinger: ReturnType<typeof setInterval>;
  private readonly messageListeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();

  constructor(socket: Duplex, head: Buffer, options: WsOptions) {
    this.socket = socket;
    this.maxPayload = options.maxPayload ?? 4 * 1024 * 1024;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', () => this.finish(1006, 'connection error'));
    // Anything already received counts as a sign of life, as does a pong.
    const interval = options.pingIntervalMs ?? 20_000;
    this.pinger = setInterval(() => {
      if (!this.alive) {
        this.terminate();
        return;
      }
      this.alive = false;
      this.frame(OP_PING, Buffer.alloc(0));
    }, interval);
    this.pinger.unref();
    if (head.length > 0) this.receive(head);
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  onMessage(listener: (text: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Sends a text message. False once the connection is closing. */
  send(text: string): boolean {
    if (!this.isOpen) return false;
    this.frame(OP_TEXT, Buffer.from(text, 'utf8'));
    return true;
  }

  /** Bytes written but not yet flushed to the network. */
  get buffered(): number {
    return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeSent) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      this.frame(OP_CLOSE, payload);
      this.closeSent = true;
    }
    // A peer that never answers the close is not waited on forever.
    setTimeout(() => this.terminate(), 2_000).unref();
  }

  terminate(): void {
    this.socket.destroy();
    this.finish(1006, 'terminated');
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const listener of this.closeListeners) listener(code, reason);
    this.closeListeners.clear();
    this.messageListeners.clear();
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
    this.buffer = Buffer.alloc(0);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.alive = true;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0) return this.fail(1002, 'reserved bits set');
      if (!masked) return this.fail(1002, 'client frames must be masked');

      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.fail(1009, 'message too big');
        length = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (length > 125 || !fin)) return this.fail(1002, 'bad control frame');
      if (!control && this.fragmentBytes + length > this.maxPayload) return this.fail(1009, 'message too big');
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);

      switch (opcode) {
        case OP_PING:
          this.frame(OP_PONG, payload);
          break;
        case OP_PONG:
          break;
        case OP_CLOSE: {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          if (!this.closeSent) {
            this.frame(OP_CLOSE, payload.subarray(0, Math.min(payload.length, 2)));
            this.closeSent = true;
          }
          this.socket.end();
          this.finish(code, reason);
          return;
        }
        case OP_TEXT:
        case OP_BINARY:
        case OP_CONTINUATION: {
          if (opcode === OP_CONTINUATION ? this.fragmentOpcode === null : this.fragmentOpcode !== null) {
            return this.fail(1002, 'unexpected continuation');
          }
          if (opcode !== OP_CONTINUATION) this.fragmentOpcode = opcode;
          this.fragments.push(payload);
          this.fragmentBytes += payload.length;
          if (!fin) break;
          const whole = Buffer.concat(this.fragments);
          const kind = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = null;
          if (kind !== OP_TEXT) return this.fail(1003, 'text messages only');
          const text = whole.toString('utf8');
          for (const listener of this.messageListeners) listener(text);
          break;
        }
        default:
          return this.fail(1002, 'unknown opcode');
      }
    }
  }
}
