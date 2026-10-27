// A WebSocket server of RFC 6455's for a test to talk to, over `node:http`'s
// upgrade on this machine: the opening handshake, unmasking, text, binary,
// ping and close frames, and enough knobs to refuse, choose a subprotocol
// or set a cookie. It accepts no extension, so nothing is compressed.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface ServerSocket {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Starts the closing handshake, with a code and a reason or none. */
  close(code?: number, reason?: string): void;
  /** Ends the connection with no close frame. */
  drop(): void;
}

export interface ServerHandlers {
  /** Answers the handshake: false refuses it with a 403, a string chooses
   *  a subprotocol, and `headers` go on the 101. */
  handshake?(
    path: string,
    headers: IncomingHttpHeaders,
  ): false | { protocol?: string; headers?: [string, string][] } | undefined;
  open?(socket: ServerSocket): void;
  text?(socket: ServerSocket, text: string): void;
  binary?(socket: ServerSocket, bytes: Uint8Array): void;
  /** The client's close frame: its code (null for none) and reason. */
  closed?(socket: ServerSocket, code: number | null, reason: string): void;
}

export interface WsServer {
  readonly port: number;
  /** Each handshake's request headers, in order. */
  readonly handshakes: { path: string; headers: IncomingHttpHeaders }[];
  stop(): Promise<void>;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.byteLength;
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 65536
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(n), 2);
            return b;
          })();
  return Buffer.concat([head, Buffer.from(payload)]);
}

function closePayload(code?: number, reason = ''): Buffer {
  if (code === undefined) return Buffer.alloc(0);
  const text = Buffer.from(reason, 'utf8');
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

export async function wsServer(handlers: ServerHandlers): Promise<WsServer> {
  const sockets = new Set<Duplex>();
  const handshakes: WsServer['handshakes'] = [];
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, raw: Duplex) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    const path = req.url ?? '/';
    handshakes.push({ path, headers: req.headers });
    const answer = handlers.handshake?.(path, req.headers);
    if (answer === false) {
      raw.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (answer?.protocol)
      lines.push(`Sec-WebSocket-Protocol: ${answer.protocol}`);
    for (const [k, v] of answer?.headers ?? []) lines.push(`${k}: ${v}`);
    raw.write(`${lines.join('\r\n')}\r\n\r\n`);

    let closing = false;
    const socket: ServerSocket = {
      path,
      headers: req.headers,
      sendText: (text) => raw.write(frame(1, Buffer.from(text, 'utf8'))),
      sendBinary: (bytes) => raw.write(frame(2, bytes)),
      close(code, reason) {
        if (closing) return;
        closing = true;
        raw.write(frame(8, closePayload(code, reason)));
      },
      drop: () => raw.destroy(),
    };
    let pending = Buffer.alloc(0);
    let message: Buffer[] = [];
    let messageOp = 0;
    raw.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const fin = (pending[0] & 0x80) !== 0;
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let length = pending[1] & 0x7f;
        let at = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          at = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          at = 10;
        }
        const mask = masked ? pending.subarray(at, at + 4) : null;
        if (masked) at += 4;
        if (pending.length < at + length) return;
        const payload = Buffer.from(pending.subarray(at, at + length));
        if (mask) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        pending = pending.subarray(at + length);
        if (opcode === 8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
          const reason = payload.subarray(2).toString('utf8');
          handlers.closed?.(socket, code, reason);
          // the client's close is answered with its own code and reason,
          // and the connection ended, as RFC 6455 5.5.1 has a server do
          if (!closing) {
            closing = true;
            raw.write(frame(8, payload));
          }
          raw.end();
          return;
        }
        if (opcode === 9) {
          raw.write(frame(10, payload));
          continue;
        }
        if (opcode === 10) continue;
        if (opcode !== 0) messageOp = opcode;
        message.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(message);
        message = [];
        if (messageOp === 1) handlers.text?.(socket, whole.toString('utf8'));
        else handlers.binary?.(socket, new Uint8Array(whole));
      }
    });
    handlers.open?.(socket);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  return {
    port: (server.address() as AddressInfo).port,
    handshakes,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
