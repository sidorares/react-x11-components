// Run with: npm run examples:terminal-ssh   (needs an X server / DISPLAY,
// `npm i --save-dev ssh2`, and a host to log into:
//
//     SSH_HOST=example.com SSH_USER=me npm run examples:terminal-ssh
//
// Authentication goes through your **ssh agent** (`$SSH_AUTH_SOCK`), or a key
// file named by `SSH_KEY`. This example deliberately takes no password: a
// passphrase in an environment variable is a passphrase in `ps` output and in
// your shell history.
//
// ---
//
// **The point of this file is that there is no pty on this machine.** No
// node-pty, no local shell, nothing native — the bytes come off an SSH
// channel. `<Terminal pty={…}>` takes a `PtyHost`, and that is the whole of
// the integration: whatever can carry bytes both ways and report a size can
// be the other end of this terminal — ssh2, a WebSocket, `docker exec`, a
// serial port, a device over TCP.
//
// Three things the adapter below has to get right, and each one is a bug
// somewhere else if you get it wrong:
//
//  1. **Hand over bytes, not a string.** `stream.on('data')` gives Buffers
//     chunked wherever the network chose, and `.toString()` on a chunk
//     boundary cuts multi-byte UTF-8 in half. `PtySession.onData` accepts a
//     `Uint8Array` (a Buffer is one) and the emulator's decoder carries the
//     partial character across chunks.
//  2. **`setWindow` takes rows first.** ssh2's signature is
//     `(rows, cols, height, width)` while every terminal API in sight —
//     including `PtySession.resize` — is (cols, rows). Swap them and the
//     remote `vim` lays out sideways.
//  3. **Wire `pause`/`resume`.** They are optional on the seam, and an SSH
//     channel is an ordinary node stream that has them, so flow control costs
//     two lines and keeps `yes(1)` from filling memory.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Terminal } from '../src/index.js';
import type { TerminalHandle } from '../src/index.js';
import type { ExitInfo } from '../src/embed/index.js';
import type {
  PtyHost,
  PtyOptions,
  PtySession,
} from '../src/terminal/vt/index.js';

// --- the slice of ssh2 this uses, structurally ------------------------------
//
// Written out rather than imported, the same rule `src/` follows for every
// optional dependency: this file type-checks with ssh2 absent, and the module
// is reached through a dynamic `import()` whose specifier is built at run
// time.

interface Ssh2Stream {
  write(data: string): void;
  end(): void;
  pause(): void;
  resume(): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  signal(name: string): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'close', listener: () => void): void;
  on(
    event: 'exit',
    listener: (code: number | null, signal?: string) => void,
  ): void;
  stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };
}

interface Ssh2Client {
  on(event: 'ready' | 'end', listener: () => void): Ssh2Client;
  on(event: 'error', listener: (err: Error) => void): Ssh2Client;
  connect(config: Record<string, unknown>): void;
  shell(
    options: { term?: string; cols?: number; rows?: number },
    callback: (err: Error | undefined, stream: Ssh2Stream) => void,
  ): void;
  exec(
    command: string,
    options: { pty?: { term?: string; cols?: number; rows?: number } },
    callback: (err: Error | undefined, stream: Ssh2Stream) => void,
  ): void;
  end(): void;
}

interface Ssh2Module {
  Client: new () => Ssh2Client;
}

async function loadSsh2(): Promise<Ssh2Module | null> {
  try {
    const specifier = 'ssh2';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      Client?: Ssh2Module['Client'];
      default?: { Client?: Ssh2Module['Client'] };
    };
    const Client = mod.Client ?? mod.default?.Client;
    return Client ? { Client } : null;
  } catch {
    return null;
  }
}

// --- the adapter ------------------------------------------------------------

interface SshConfig {
  host: string;
  port?: number;
  username: string;
  /** Path to a private key. Falls back to the agent when absent. */
  keyPath?: string;
}

/** One SSH channel, as a `PtySession`. */
class SshSession implements PtySession {
  #client: Ssh2Client;
  #stream: Ssh2Stream;
  #alive = true;

  constructor(client: Ssh2Client, stream: Ssh2Stream) {
    this.#client = client;
    this.#stream = stream;
  }

  /** No such thing on the far side of an SSH channel. */
  readonly pid = null;

  write(data: string): void {
    if (this.#alive) this.#stream.write(data);
  }

  resize(cols: number, rows: number): void {
    // (2) rows first — ssh2's order, not this seam's.
    if (this.#alive) this.#stream.setWindow(rows, cols, 0, 0);
  }

  kill(signal = 'SIGTERM'): boolean {
    if (!this.#alive) return false;
    try {
      // The protocol spells signals without the SIG prefix.
      this.#stream.signal(signal.replace(/^SIG/, ''));
      return true;
    } catch {
      // Not every server implements the signal request; closing the channel
      // is the fallback every server does implement.
      this.#stream.end();
      return true;
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    // (1) straight through, still bytes.
    this.#stream.on('data', listener);
    this.#stream.stderr.on('data', listener);
  }

  onExit(listener: (info: ExitInfo) => void): void {
    let reported = false;
    const done = (code: number | null, signal?: string): void => {
      if (reported) return;
      reported = true;
      this.#alive = false;
      listener({ code: signal ? null : (code ?? 0), signal: signal ?? null });
      this.#client.end();
    };
    this.#stream.on('exit', (code, signal) => done(code, signal));
    this.#stream.on('close', () => done(0));
  }

  // (3) an SSH channel is a node stream, so flow control is free.
  pause(): void {
    this.#stream.pause();
  }

  resume(): void {
    this.#stream.resume();
  }
}

/** A `PtyHost` that opens its terminals on another machine. */
function sshPtyHost(config: SshConfig): PtyHost {
  return {
    async available() {
      return (await loadSsh2()) !== null;
    },

    async openPty(argv: readonly string[], options: PtyOptions) {
      const ssh2 = await loadSsh2();
      if (!ssh2) throw new Error('ssh2 is not installed — npm i ssh2');

      const auth: Record<string, unknown> = {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
      };
      if (config.keyPath) {
        const fs = await import('node:fs/promises');
        auth.privateKey = await fs.readFile(config.keyPath);
      } else {
        // The agent holds the key and does the signing; nothing secret is
        // read, held or logged by this process.
        auth.agent = process.env.SSH_AUTH_SOCK;
      }

      const client = new ssh2.Client();
      return new Promise<PtySession>((resolve, reject) => {
        client.on('error', reject);
        client.on('ready', () => {
          const want = {
            term: options.env?.TERM ?? 'xterm-256color',
            cols: options.cols,
            rows: options.rows,
          };
          const settle = (err: Error | undefined, stream: Ssh2Stream): void => {
            if (err) reject(err);
            else resolve(new SshSession(client, stream));
          };
          // Empty argv is "the login shell over there" — which is why the
          // component hands the host an empty array rather than substituting
          // this machine's `$SHELL`.
          if (argv.length) {
            client.exec(argv.join(' '), { pty: want }, settle);
          } else {
            client.shell(want, settle);
          }
        });
        client.connect(auth);
      });
    },
  };
}

// --- the app ----------------------------------------------------------------

const HOST = process.env.SSH_HOST;
const USER = process.env.SSH_USER ?? process.env.USER;

function App(): ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  const [title, setTitle] = useState(HOST ? `${USER}@${HOST}` : 'ssh');
  const [status, setStatus] = useState('connecting…');

  const pty = useRef(
    HOST && USER
      ? sshPtyHost({
          host: HOST,
          username: USER,
          port: process.env.SSH_PORT ? Number(process.env.SSH_PORT) : undefined,
          keyPath: process.env.SSH_KEY,
        })
      : null,
  ).current;

  return (
    <window width={860} height={540} title="@react-x11/components — ssh">
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 8,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 13, color: '$text', flexGrow: 1 }}>
            {title}
          </text>
          <text style={{ fontSize: 11, color: '$dim' }}>{status}</text>
        </box>

        {pty ? (
          <Terminal
            backend="vt"
            pty={pty}
            ref={terminal}
            fontFamily="monospace"
            fontSize={14}
            scrollback={5000}
            style={{ flexGrow: 1, padding: 6 }}
            onTitleChange={setTitle}
            onExit={({ code, signal }) =>
              setStatus(signal ? `signalled (${signal})` : `closed (${code})`)
            }
            onError={(err) => setStatus(err.message)}
            fallback={
              <box style={{ flexGrow: 1, padding: 24 }}>
                <text style={{ fontSize: 13, color: '$dim' }}>{status}</text>
              </box>
            }
          />
        ) : (
          <box style={{ flexGrow: 1, padding: 24, gap: 8 }}>
            <text style={{ fontSize: 13, color: '$text' }}>
              Set SSH_HOST and SSH_USER to connect.
            </text>
            <text style={{ fontSize: 12, color: '$dim' }}>
              SSH_HOST=example.com SSH_USER=me npm run examples:terminal-ssh
            </text>
          </box>
        )}
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
