// A page's WebTransport over the network's own seam, `HtmlNetwork`'s
// (`src/html/quico.ts`), end to end on the loopback: quico's client in the
// host, quico's server on 127.0.0.1, a certificate made for the run. What
// `webtransport.test.ts` holds of the page's API over a fake server, this
// holds of the adapter: the CONNECT names the page's origin, streams and
// datagrams go both ways, and each way a server ends a session reaches the
// page as a browser has it.
//
// Skipped where the run cannot make a certificate (no `openssl`) or quico,
// the optional peer, is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { loadQuico } from '../../src/html/quico.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

/** A key and a certificate for localhost, good for ten days. */
function certificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'wt-cert-'));
  try {
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '10',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    if (made.status !== 0) return null;
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const quico = (await loadQuico()) as unknown as {
  createServer(
    options: { key: string; cert: string },
    handler: (req: Req, res: Res) => void,
  ): {
    listen(port: number, host: string, cb: () => void): void;
    close(): void;
  };
} | null;
const certs = quico ? certificate() : null;
const test = SCRIPTS_CONTAINED && quico && certs ? nodeTest : nodeTest.skip;

interface Duplex {
  on(event: string, fn: (...a: never[]) => void): void;
  write(data: unknown): void;
  end(): void;
}
interface Req {
  headers: Record<string, string>;
  on(event: string, fn: (...a: never[]) => void): void;
}
interface Res {
  writeHead(status: number): void;
  end(): void;
  sendDatagram(data: Uint8Array): boolean;
  closeSession(code: number, reason: string): void;
}

/** A free UDP port on the loopback, for the server to take. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

test('a page’s session over quico names its origin, echoes, and is closed by the server with and without a capsule', async () => {
  const seen: Record<string, string>[] = [];
  const server = quico!.createServer(certs!, (req, res) => {
    if (req.headers[':protocol'] !== 'webtransport') {
      res.writeHead(404);
      res.end();
      return;
    }
    seen.push(req.headers);
    const path = req.headers[':path'];
    res.writeHead(200);
    if (path === '/close') {
      setTimeout(() => res.closeSession(7, 'bye'), 50);
      return;
    }
    if (path === '/fin') {
      setTimeout(() => res.end(), 50);
      return;
    }
    req.on('stream', ((s: Duplex) => {
      s.on('data', ((d: Uint8Array) => s.write(d)) as never);
      s.on('end', () => s.end());
    }) as never);
    req.on('datagram', ((d: Uint8Array) => res.sendDatagram(d)) as never);
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    const network = new HtmlNetwork({ webTransport: { ca: [certs!.cert] } });
    const logs: string[] = [];
    const base = `https://localhost:${port}`;
    await renderX11(
      h(Html, {
        source:
          '<script>' +
          'function log() { console.log([].slice.call(arguments).join("|")); }' +
          `var wt = new WebTransport("${base}/echo");` +
          'wt.ready.then(async function () {' +
          '  var bidi = await wt.createBidirectionalStream();' +
          '  var w = bidi.writable.getWriter(); await w.write(new TextEncoder().encode("ping")); await w.close();' +
          '  var t = ""; for await (var c of bidi.readable) t += new TextDecoder().decode(c);' +
          '  log("echo", t);' +
          '  var dw = wt.datagrams.createWritable().getWriter(); var dr = wt.datagrams.readable.getReader();' +
          '  await dw.write(new Uint8Array([1, 2, 3])); var got = await dr.read();' +
          '  log("datagram", Array.from(got.value).join(","));' +
          '  var s = await wt.getStats(); log("stats", s.smoothedRtt > 0);' +
          '  wt.close({ closeCode: 3, reason: "done" }); log("closed", JSON.stringify(await wt.closed));' +
          `  var a = new WebTransport("${base}/close"); log("capsule", JSON.stringify(await a.closed));` +
          `  var b = new WebTransport("${base}/fin"); log("fin", JSON.stringify(await b.closed));` +
          '}).catch(function (e) { log("failed", e.name, e.message); });' +
          '</script>',
        partial: false,
        baseUrl: 'https://page.test/',
        scripts: {
          webTransport: network.webTransport,
          log: (_level: string, text: string) => void logs.push(text),
        },
      }),
      FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
    );
    const end = Date.now() + 15000;
    while (!logs.some((l) => /^(fin|failed)\|/.test(l)) && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 20)));
    }
    assert.deepEqual(
      logs.filter((l) => !l.startsWith('[')),
      [
        'echo|ping',
        'datagram|1,2,3',
        'stats|true',
        'closed|{"closeCode":3,"reason":"done"}',
        'capsule|{"closeCode":7,"reason":"bye"}',
        'fin|{"closeCode":0,"reason":""}',
      ],
      logs.join('\n'),
    );
    assert.equal(seen[0].origin, 'https://page.test');
    assert.equal(seen[0][':path'], '/echo');
  } finally {
    server.close();
  }
});

test('a session to a server whose certificate the network does not trust fails, and the page hears it as its own error', async () => {
  const server = quico!.createServer(certs!, (_req, res) => {
    res.writeHead(200);
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    // trusting none of the runtime's roots, nor this certificate
    const network = new HtmlNetwork({ webTransport: { ca: [] } });
    const logs: string[] = [];
    await renderX11(
      h(Html, {
        source:
          '<script>' +
          `new WebTransport("https://localhost:${port}/").ready.catch(function (e) {` +
          '  console.log("refused|" + e.name + "|" + e.source + "|" + e.constructor.constructor("return typeof process")()); });' +
          '</script>',
        partial: false,
        baseUrl: 'https://page.test/',
        scripts: {
          webTransport: network.webTransport,
          log: (_level: string, text: string) => void logs.push(text),
        },
      }),
      FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
    );
    const end = Date.now() + 15000;
    while (!logs.some((l) => l.startsWith('refused|')) && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 20)));
    }
    assert.equal(
      logs.find((l) => l.startsWith('refused|')),
      'refused|WebTransportError|session|undefined',
      logs.join('\n'),
    );
  } finally {
    server.close();
  }
});
