// `<Html scripts>`' WebSocket (`src/html/scripts/websocket.ts`, the host's
// half in `sockets.ts`): a page's sockets over the `webSocket` seam, which a
// fake answers by hand here (`../fake-socket.ts`), and `HtmlNetwork`'s seam
// over the runtime's own `WebSocket` against a server of RFC 6455's on this
// machine (`../ws-server.ts`).
import assert from 'node:assert/strict';
import channels from 'node:diagnostics_channel';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { CookieJar } from '../../src/html/cookies.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { NO_WEBSOCKET } from '../../src/html/socket.js';
import type { HtmlWebSocket } from '../../src/html/socket.js';
import { FakeSockets } from '../fake-socket.js';
import type { FakeConnection } from '../fake-socket.js';
import { wsServer } from '../ws-server.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
/** The runtime's own `WebSocket`, which Node has from 22 and Bun has. */
const runtimeTest =
  SCRIPTS_CONTAINED && typeof globalThis.WebSocket === 'function'
    ? nodeTest
    : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

/** A page whose scripts run, over `webSocket`: what it logs, and a wait
 *  for a log line that starts with a prefix. */
async function page(
  script: string,
  options: {
    webSocket?: HtmlWebSocket;
    url?: string;
    head?: string;
    cookies?: CookieJar;
  } = {},
): Promise<{ logs: string[]; until(prefix: string): Promise<string> }> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source: `<!doctype html><html><head>${options.head ?? ''}</head><body><script>${script}</script></body></html>`,
      partial: false,
      baseUrl: options.url ?? PAGE,
      scripts: {
        ...(options.webSocket ? { webSocket: options.webSocket } : {}),
        ...(options.cookies ? { cookies: options.cookies } : {}),
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  return {
    logs,
    async until(prefix) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
  };
}

/** A wait, under `act`, for something a test drives to have happened. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.ok(check(), what);
}

const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }' +
  // what every socket's events were, in order, for a test to read back
  'function trace(ws, name) { ["open", "error", "close"].forEach(function (t) {' +
  '  ws.addEventListener(t, function (e) { log(name, t, ws.readyState, t === "close" ? [e.code, JSON.stringify(e.reason), e.wasClean, e instanceof CloseEvent].join(",") : ""); }); }); }';

test('with no network, a socket fails as a browser’s does: error, then a close of 1006, and what the page is handed is its own', async () => {
  const p = await page(
    LOG +
      'var reach = "return typeof process + typeof require";' +
      'var ws = new WebSocket("wss://ws.test/feed");' +
      'log("made", ws.readyState, ws.url, ws.protocol, ws.extensions, ws.bufferedAmount, ws.binaryType);' +
      'ws.onerror = function (e) { log("error", ws.readyState, e.type, e.isTrusted, e.constructor.constructor(reach)()); };' +
      'ws.onclose = function (e) { log("close", e.code, e.wasClean, JSON.stringify(e.reason), e instanceof CloseEvent, e instanceof Event, e.constructor.constructor(reach)()); };',
  );
  assert.equal(await p.until('made|'), '0|wss://ws.test/feed|||0|blob');
  assert.equal(await p.until('error|'), '3|error|true|undefinedundefined');
  assert.equal(
    await p.until('close|'),
    '1006|false|""|true|true|undefinedundefined',
  );
  assert.ok(
    p.logs.some((l) =>
      l.startsWith(
        "error: WebSocket connection to 'wss://ws.test/feed' failed",
      ),
    ),
    p.logs.join('\n'),
  );
  assert.ok(NO_WEBSOCKET, 'the default seam is exported');
});

test('the constructor makes a URL of what it is given, and refuses what is no WebSocket URL and protocols a header cannot carry', async () => {
  const p = await page(
    LOG +
      'var out = [];' +
      'function tryIt(url, protocols) { try { var ws = arguments.length > 1 ? new WebSocket(url, protocols) : new WebSocket(url); out.push(ws.url); } catch (e) { out.push(e.name + (e instanceof DOMException ? "" : "!")); } }' +
      'tryIt("ws://foo bar.com/"); tryIt("ftp://ws.test/"); tryIt("mailto:a@b.c"); tryIt("about:blank");' +
      'tryIt("wss://ws.test/#"); tryIt("wss://ws.test/#x"); tryIt("#x");' +
      'tryIt("http://ws.test/a"); tryIt("https://ws.test/a"); tryIt("rel?q"); tryIt("");' +
      'tryIt("wss://ws.test/", ""); tryIt("wss://ws.test/", "a b"); tryIt("wss://ws.test/", "a,b"); tryIt("wss://ws.test/", "\\u00e9");' +
      'tryIt("wss://ws.test/", ["echo", "eCho"]); tryIt("wss://ws.test/", ["echo", "echo"]);' +
      'tryIt("wss://ws.test/", ["a", "b"]); tryIt("wss://ws.test/", { protocols: ["a"] }); tryIt("wss://ws.test/", {});' +
      'try { new WebSocket(); } catch (e) { out.push(e.name); }' +
      'log("done", out.join(","));' +
      'log("idl", WebSocket.length, WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED, WebSocket.prototype.CLOSED,' +
      '  Object.prototype.toString.call(new WebSocket("wss://ws.test/")), typeof Object.getOwnPropertyDescriptor(WebSocket.prototype, "readyState").get,' +
      '  "readyState" in new WebSocket("wss://ws.test/") && !Object.prototype.hasOwnProperty.call(new WebSocket("wss://ws.test/"), "readyState"),' +
      '  WebSocket.prototype.close.length, WebSocket.prototype.send.length);',
    { webSocket: new FakeSockets() },
  );
  assert.equal(
    await p.until('done|'),
    [
      'SyntaxError,SyntaxError,SyntaxError,SyntaxError',
      'SyntaxError,SyntaxError,SyntaxError',
      'ws://ws.test/a,wss://ws.test/a,wss://example.test/rel?q,wss://example.test/page.html',
      'SyntaxError,SyntaxError,SyntaxError,SyntaxError',
      'SyntaxError,SyntaxError',
      'wss://ws.test/,wss://ws.test/,wss://ws.test/',
      'TypeError',
    ].join(','),
  );
  assert.equal(
    await p.until('idl|'),
    '1|0|1|2|3|3|[object WebSocket]|function|true|0|1',
  );
});

test('an open socket sends and hears text and binary, as a Blob or an ArrayBuffer, and its bufferedAmount comes down as the network takes what was sent', async (t) => {
  let c: FakeConnection | null = null;
  const sockets = new FakeSockets((made) => {
    c = made;
    made.echo = true;
  });
  const p = await page(
    LOG +
      'var ws = new WebSocket("wss://ws.test/echo", ["v1", "v2"]);' +
      'try { ws.send("early"); } catch (e) { log("early", e.name); }' +
      'var heard = [];' +
      'ws.onopen = function (e) { log("open", ws.readyState, ws.protocol, ws.extensions, e.isTrusted);' +
      '  ws.send("héllo"); ws.send(new Uint8Array([1, 2, 3]).buffer); ws.send(new Uint16Array([0x0201, 0x0403]).subarray(1)); ws.send(new Blob(["blob"]));' +
      '  log("buffered", ws.bufferedAmount); check(); };' +
      'ws.onmessage = function (e) { heard.push(e);' +
      '  if (heard.length === 2) ws.binaryType = "arraybuffer";' +
      '  if (heard.length < 4) return;' +
      '  Promise.all(heard.map(function (m) { return typeof m.data === "string" ? m.data : m.data instanceof Blob ? m.data.arrayBuffer().then(function (b) { return "blob:" + new Uint8Array(b).join("."); }) : "ab:" + new Uint8Array(m.data).join("."); }))' +
      '  .then(function (all) { log("heard", all.join(","), heard[0].origin, heard[0].isTrusted); }); };' +
      // from the sends on: before them nothing waits, so a look at a socket
      // that is yet to open would find it drained
      'var looks = 0;' +
      'function check() { if (!ws.bufferedAmount) return log("drained", ws.bufferedAmount); log("waiting", ++looks, ws.bufferedAmount); setTimeout(check, 5); }',
    { webSocket: sockets },
  );
  assert.equal(await p.until('early|'), 'InvalidStateError');
  await waitFor(() => c !== null, 'a connection was asked for');
  const conn = c!;
  const asked = t.mock.method(conn, 'bufferedAmount');
  assert.deepEqual(conn.request, {
    url: 'wss://ws.test/echo',
    origin: 'https://example.test',
    protocols: ['v1', 'v2'],
  });
  await act(async () => conn.open('v2', 'permessage-deflate'));
  assert.equal(await p.until('open|'), '1|v2|permessage-deflate|true');
  // 6 for "héllo", 3, 2 and 4
  assert.equal(await p.until('buffered|'), '15');
  assert.deepEqual(
    conn.sent.map((d) => (typeof d === 'string' ? d : [...d].join('.'))),
    ['héllo', '1.2.3', '3.4', '98.108.111.98'],
  );
  assert.equal(
    await p.until('heard|'),
    'héllo,blob:1.2.3,ab:3.4,ab:98.108.111.98|wss://ws.test|true',
  );
  // nothing has left the seam yet: the host asks it, and the page, looking
  // after that, reads all of it still waiting; once it has left, the page
  // hears it
  const asks = asked.mock.callCount();
  await waitFor(() => asked.mock.callCount() > asks, 'the host asked the seam');
  const looks = p.logs.filter((l) => l.startsWith('log: waiting|')).length;
  assert.equal(await p.until(`waiting|${looks + 1}|`), '15');
  conn.drain();
  assert.equal(await p.until('drained|'), '0');
});

test('close() checks its code and reason, and starts the closing handshake, whose answer is a clean close', async () => {
  const sockets = new FakeSockets((c) => setTimeout(() => c.open(), 0));
  const p = await page(
    LOG +
      'var out = [];' +
      'var ws = new WebSocket("wss://ws.test/");' +
      'trace(ws, "a");' +
      'ws.onopen = function () {' +
      '  [0, 500, NaN, "string", null, 0x10000 + 1000, 1001, 2999, 5000].forEach(function (code) { try { ws.close(code); out.push("ok"); } catch (e) { out.push(e.name); } });' +
      '  try { ws.close(1000, "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123"); } catch (e) { out.push(e.name); }' +
      '  try { ws.close(1000, "\\u00e9".repeat(62)); } catch (e) { out.push(e.name); }' +
      '  log("checks", out.join(","), ws.readyState);' +
      '  ws.close(3001.5, "bye \\ud800"); log("closing", ws.readyState); ws.close(4000); ws.send("after"); log("after", ws.bufferedAmount); };',
    { webSocket: sockets },
  );
  assert.equal(
    await p.until('checks|'),
    'InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,InvalidAccessError,SyntaxError,SyntaxError|1',
  );
  assert.equal(await p.until('closing|'), '2');
  // what is sent once the socket is closing is only counted
  assert.equal(await p.until('after|'), '5');
  assert.equal(await p.until('a|close|'), '3|3002,"bye �",true,true');
  const conn = sockets.connections[0];
  assert.deepEqual(conn.closes, [[3002, 'bye �']]);
  assert.deepEqual(conn.sent, []);
  assert.ok(!p.logs.some((l) => l.startsWith('log: a|error')));
});

test('a close with no code is 1005, a reason alone is 1000’s, and a server’s own close is heard with its code', async () => {
  const sockets = new FakeSockets((c) => setTimeout(() => c.open(), 0));
  const p = await page(
    LOG +
      'var a = new WebSocket("wss://ws.test/a"); trace(a, "a"); a.onopen = function () { a.close(); };' +
      'var b = new WebSocket("wss://ws.test/b"); trace(b, "b"); b.onopen = function () { b.close(undefined, "why"); };' +
      'var c = new WebSocket("wss://ws.test/c"); trace(c, "c");',
    { webSocket: sockets },
  );
  assert.equal(await p.until('a|close|'), '3|1005,"",true,true');
  assert.equal(await p.until('b|close|'), '3|1000,"why",true,true');
  const [a, b, c] = sockets.connections;
  assert.deepEqual(a.closes, [[null, '']]);
  assert.deepEqual(b.closes, [[1000, 'why']]);
  await p.until('c|open|');
  await act(async () => c.events.closed(4000, 'server says', true));
  assert.equal(await p.until('c|close|'), '3|4000,"server says",true,true');
  // a connection lost with no close frame is unclean, and no error
  const d = await page(
    LOG + 'var d = new WebSocket("wss://ws.test/d"); trace(d, "d");',
    { webSocket: sockets },
  );
  await d.until('d|open|');
  await act(async () => sockets.connections[3].events.closed(1006, '', false));
  assert.equal(await d.until('d|close|'), '3|1006,"",false,true');
  assert.ok(!d.logs.some((l) => l.startsWith('log: d|error')));
});

test('a socket closed before it is established, one the seam fails, and one whose server chose a protocol it was not offered are failed: error, then 1006', async () => {
  const sockets = new FakeSockets();
  const p = await page(
    LOG +
      'var a = new WebSocket("wss://ws.test/a"); trace(a, "a"); a.close(); log("closed early", a.readyState);' +
      'var b = new WebSocket("wss://ws.test/b"); trace(b, "b");' +
      'var c = new WebSocket("wss://ws.test/c", "x"); trace(c, "c");' +
      'var d = new WebSocket("wss://ws.test/d"); trace(d, "d");',
    { webSocket: sockets },
  );
  assert.equal(await p.until('closed early|'), '2');
  assert.equal(await p.until('a|error|'), '3|');
  assert.equal(await p.until('a|close|'), '3|1006,"",false,true');
  // the seam was asked to abandon it, and its open is heard by nobody
  await waitFor(() => sockets.connections.length === 4, 'four connections');
  const [a, b, c, d] = sockets.connections;
  assert.deepEqual(a.closes, [[null, '']]);
  await act(async () => {
    a.open();
    b.events.failed('refused');
    c.open('y');
    d.open('z');
  });
  assert.equal(await p.until('b|error|'), '3|');
  assert.equal(await p.until('b|close|'), '3|1006,"",false,true');
  assert.equal(await p.until('c|close|'), '3|1006,"",false,true');
  assert.equal(await p.until('d|close|'), '3|1006,"",false,true');
  assert.ok(
    !p.logs.some((l) => /^log: [a-d]\|open/.test(l)),
    p.logs.join('\n'),
  );
  assert.ok(
    p.logs.some((l) => l.includes("'wss://ws.test/b' failed: refused")),
  );
});

test('a socket is held to the document’s connect-src, a secure page’s ws: endpoint is mixed content, and a blocked port is refused, none of them asked of the seam', async () => {
  const sockets = new FakeSockets((c) => c.open());
  const p = await page(
    LOG +
      'trace(new WebSocket("wss://allowed.test/"), "allowed");' +
      'trace(new WebSocket("wss://other.test/"), "other");' +
      'trace(new WebSocket("ws://insecure.test/"), "mixed");' +
      'trace(new WebSocket("ws://127.0.0.1:9/"), "port");' +
      'trace(new WebSocket("ws://localhost:8080/"), "local");',
    {
      webSocket: sockets,
      head: `<meta http-equiv="Content-Security-Policy" content="connect-src wss://allowed.test ws://insecure.test ws://127.0.0.1:9 ws://localhost:*">`,
    },
  );
  await p.until('allowed|open|');
  await p.until('local|open|');
  assert.equal(await p.until('other|close|'), '3|1006,"",false,true');
  assert.equal(await p.until('mixed|close|'), '3|1006,"",false,true');
  assert.equal(await p.until('port|close|'), '3|1006,"",false,true');
  assert.ok(p.logs.some((l) => l.startsWith('log: other|error')));
  assert.deepEqual(
    sockets.connections.map((c) => c.request.url),
    ['wss://allowed.test/', 'ws://localhost:8080/'],
  );
  assert.ok(p.logs.some((l) => l.includes('Content Security Policy')));
  assert.ok(p.logs.some((l) => l.startsWith('error: Mixed Content')));
  // an insecure page's ws: endpoint is no mixed content
  const plain = new FakeSockets((c) => c.open());
  const q = await page(
    LOG + 'trace(new WebSocket("ws://insecure.test/"), "plain");',
    {
      webSocket: plain,
      url: 'http://example.test/',
    },
  );
  await q.until('plain|open|');
});

test('a message comes only to an open socket, and a CloseEvent is made as the standard has it', async () => {
  const sockets = new FakeSockets((c) => c.open());
  const p = await page(
    LOG +
      'var ws = new WebSocket("wss://ws.test/"); var heard = [];' +
      'ws.onmessage = function (e) { heard.push(e.data); };' +
      'ws.onopen = function () { log("open"); };' +
      'ws.onclose = function () { log("heard", heard.join(",")); };' +
      'ws.addEventListener("message", function (e) { heard.push(e.data); });' +
      'ws.addEventListener("close", function (e) { log("closed", heard.join(","), e.code); });' +
      'var e = new CloseEvent("close"); var f = new CloseEvent("x", { code: 65537, reason: "\\udc00", wasClean: 1, bubbles: true });' +
      'var handlers = ["open", "error", "close", "message"].map(function (t) { var before = ws["on" + t]; ws["on" + t] = 2; var after = ws["on" + t]; return before === null ? "null" : typeof before + ":" + after; });' +
      'log("events", e.code, JSON.stringify(e.reason), e.wasClean, f.code, f.reason === "\\ufffd", f.wasClean, f.bubbles, CloseEvent.length, Object.prototype.toString.call(f), handlers.join(","));' +
      'try { CloseEvent(); } catch (err) { log("call", err.name); }' +
      'try { Object.getOwnPropertyDescriptor(WebSocket.prototype, "url").get.call({}); } catch (err) { log("brand", err.name); }',
    { webSocket: sockets },
  );
  assert.equal(
    await p.until('events|'),
    '0|""|false|1|true|true|true|1|[object CloseEvent]|function:null,null,function:null,function:null',
  );
  assert.equal(await p.until('call|'), 'TypeError');
  assert.equal(await p.until('brand|'), 'TypeError');
  // the handlers were set to 2, and are null: the listeners hear it, and
  // what comes after the close is heard by nobody
  const conn = sockets.connections[0];
  await act(async () => {
    conn.events.message('one');
    conn.events.closed(1000, '', true);
    conn.events.message('after');
  });
  assert.equal(await p.until('closed|'), 'one|1000');
  assert.ok(!p.logs.some((l) => l.startsWith('log: heard')));
  assert.ok(!p.logs.some((l) => l === 'log: open'));
});

test('a worker’s sockets are carried across its thread over the page’s seam: text and binary both ways, bufferedAmount, close', async () => {
  const sockets = new FakeSockets((c) => {
    c.echo = true;
    setTimeout(() => c.open('w'), 0);
  });
  const worker =
    'var ws = new WebSocket("wss://ws.test/w", ["w"]); ws.binaryType = "arraybuffer"; var heard = []; var drained = false;' +
    'function done() { if (drained && heard.length === 2) ws.close(3000, "done"); }' +
    'function check() { if (ws.bufferedAmount) return setTimeout(check, 5); drained = true; postMessage("drained|" + ws.bufferedAmount); done(); }' +
    'ws.onopen = function () { ws.send("from worker"); ws.send(new Uint8Array([7, 8]));' +
    '  postMessage(["open", ws.protocol, ws.bufferedAmount, typeof WorkerGlobalScope].join("|")); check(); };' +
    'ws.onmessage = function (e) { heard.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data).join("."));' +
    '  if (heard.length === 2) { postMessage("heard|" + heard.join(",")); done(); } };' +
    'ws.onclose = function (e) { postMessage(["close", e.code, e.reason, e.wasClean].join("|")); };';
  const p = await page(
    LOG +
      `var source = ${JSON.stringify(worker)};` +
      'var w = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));' +
      'w.onmessage = function (e) { log(e.data); };',
    { webSocket: sockets },
  );
  assert.equal(await p.until('open|'), 'w|13|function');
  const conn = sockets.connections[0];
  assert.equal(conn.request.url, 'wss://ws.test/w');
  assert.equal(conn.request.origin, 'https://example.test');
  conn.drain();
  assert.equal(await p.until('drained|'), '0');
  assert.equal(await p.until('heard|'), 'from worker,7.8');
  assert.equal(await p.until('close|'), '3000|done|true');
  assert.deepEqual(conn.closes, [[3000, 'done']]);
});

runtimeTest(
  'HtmlNetwork opens a socket over the runtime’s WebSocket: its Origin, User-Agent and cookies on the handshake, text and binary both ways, close codes, a refusal',
  async () => {
    const server = await wsServer({
      handshake: (path) =>
        path === '/refused'
          ? false
          : {
              protocol: path === '/chat' ? 'chat' : undefined,
              headers: [['Set-Cookie', 'fromws=1; Path=/']],
            },
      open(socket) {
        if (socket.path === '/server-closes') socket.close(4001, 'enough');
      },
      text: (socket, text) => socket.sendText(`echo:${text}`),
      binary: (socket, bytes) =>
        socket.sendBinary(new Uint8Array([...bytes].reverse())),
    });
    let told = false;
    const heard = (message: unknown): void => {
      if ((message as { handshakeResponse?: unknown })?.handshakeResponse) {
        told = true;
      }
    };
    channels.subscribe('undici:websocket:open', heard);
    // a port nothing listens on, where a connection is refused
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const jar = new CookieJar();
      jar.store(`${origin}/`, ['sid=abc; Path=/'], {
        http: true,
        sameSite: true,
      });
      const network = new HtmlNetwork({
        cookies: jar,
        userAgent: 'TestAgent/1',
      });
      const ws = `ws://127.0.0.1:${server.port}`;
      const p = await page(
        LOG +
          `var a = new WebSocket("${ws}/chat", ["chat", "other"]); a.binaryType = "arraybuffer"; var heard = [];` +
          'a.onopen = function () { log("open", a.protocol, a.extensions, document.cookie.indexOf("fromws=1") >= 0); a.send("hi"); a.send(new Uint8Array([1, 2, 3])); };' +
          'a.onmessage = function (e) { heard.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data).join(".")); if (heard.length === 2) { log("heard", heard.join(",")); a.close(3001, "bye"); } };' +
          'a.onclose = function (e) { log("a closed", e.code, e.reason, e.wasClean); };' +
          `var b = new WebSocket("${ws}/server-closes"); b.onclose = function (e) { log("b closed", e.code, e.reason, e.wasClean); };` +
          `var c = new WebSocket("${ws}/refused"); var cErr = false; c.onerror = function () { cErr = true; }; c.onclose = function (e) { log("c closed", cErr, e.code, e.wasClean); };` +
          `var d = new WebSocket("ws://127.0.0.1:${closedPort}/"); d.onclose = function (e) { log("d closed", e.code, e.wasClean); };`,
        {
          url: `${origin}/page.html`,
          cookies: jar,
          webSocket: network.webSockets(`${origin}/page.html`),
        },
      );
      // where undici says what the handshake was answered with — Node from
      // 24 — its cookie is kept before the page hears `open`; Bun, and Node
      // before, say nothing of it
      assert.equal(await p.until('open|'), `chat||${told}`);
      assert.equal(await p.until('heard|'), 'echo:hi,3.2.1');
      assert.equal(await p.until('a closed|'), '3001|bye|true');
      assert.equal(await p.until('b closed|'), '4001|enough|true');
      assert.equal(await p.until('c closed|'), 'true|1006|false');
      assert.equal(await p.until('d closed|'), '1006|false');
      const chat = server.handshakes.find((s) => s.path === '/chat')!;
      assert.equal(chat.headers.origin, origin);
      assert.equal(chat.headers['user-agent'], 'TestAgent/1');
      assert.equal(chat.headers.cookie, 'sid=abc');
      assert.equal(chat.headers['sec-websocket-protocol'], 'chat, other');
    } finally {
      channels.unsubscribe('undici:websocket:open', heard);
      await server.stop();
    }
  },
);
