// `<Html scripts>`' WebTransport (`src/html/scripts/webtransport.ts`, the
// host's half in `transports.ts`): a page's sessions, datagrams and streams,
// carried over the `webTransport` seam, which a fake server answers here
// (`../fake-transport.ts`), as CI runs no QUIC server. WPT's own tests run
// against a real one through `scripts/conformance/interop.ts`.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { NO_WEBTRANSPORT, badPort } from '../../src/html/transport.js';
import type { HtmlWebTransport } from '../../src/html/transport.js';
import { FakeTransport } from '../fake-transport.js';
import type { FakeServer } from '../fake-transport.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

/** A page whose scripts run, over `webTransport`: what it logs, and a wait
 *  for a log line that starts with `done`. */
async function page(
  script: string,
  webTransport?: HtmlWebTransport,
  url = PAGE,
): Promise<{ logs: string[]; until(prefix: string): Promise<string> }> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source: `<p id="out"></p><script>${script}</script>`,
      partial: false,
      baseUrl: url,
      scripts: {
        ...(webTransport ? { webTransport } : {}),
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

/** What a page's helpers are: `log(...)` to the console, joined by `|`. */
const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }';

test('with no network, a session fails as a browser’s does, and what the page is handed is its own', async () => {
  const p = await page(
    LOG +
      'var reach = "return typeof process + typeof require";' +
      'var wt = new WebTransport("https://wt.test:4433/echo");' +
      'var first;' +
      'wt.ready.catch(function (e) { first = e;' +
      '  log("ready", e.name, e instanceof WebTransportError, e instanceof DOMException, e.source, e.streamErrorCode, e.constructor.constructor(reach)());' +
      '  return wt.closed; }).catch(function (e) { log("closed", e === first, wt.reliability);' +
      '  return wt.createBidirectionalStream(); }).catch(function (e) { log("stream", e.name, e.constructor.constructor(reach)());' +
      '  return wt.getStats(); }).catch(function (e) { log("stats", e.name); });',
  );
  assert.equal(
    await p.until('ready|'),
    'WebTransportError|true|true|session||undefinedundefined',
  );
  assert.equal(await p.until('closed|'), 'true|pending');
  assert.equal(
    await p.until('stream|'),
    'InvalidStateError|undefinedundefined',
  );
  assert.equal(await p.until('stats|'), 'InvalidStateError');
  assert.ok(NO_WEBTRANSPORT, 'the default seam is exported');
});

test('the constructor refuses what is no WebTransport URL, and protocols a header cannot carry', async () => {
  const p = await page(
    LOG +
      'var out = [];' +
      'function tryIt(url, options) { try { new WebTransport(url, options); out.push("ok"); } catch (e) { out.push(e.name); } }' +
      'tryIt(""); tryIt("no-scheme"); tryIt("http://wt.test/"); tryIt("https:///");' +
      'tryIt("https://wt.test/#frag"); tryIt("https://wt.test:999999/");' +
      'tryIt("https://wt.test/", { protocols: [""] }); tryIt("https://wt.test/", { protocols: ["a", "a"] });' +
      'tryIt("https://wt.test/", { protocols: ["\\u8aa4"] }); tryIt("https://wt.test/", { protocols: ["a\\nb"] });' +
      'tryIt("https://wt.test/", { protocols: ["a\\"b", "c"] });' +
      'tryIt("https://wt.test/", { congestionControl: "fast" });' +
      'tryIt("https://wt.test/", { anticipatedConcurrentIncomingBidirectionalStreams: 70000 });' +
      'tryIt("https://wt.test/", { allowPooling: true, serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(32) }] });' +
      'log("done", out.join(","), WebTransport.length, typeof WebTransport.supportsReliableOnly);',
  );
  assert.equal(
    await p.until('done|'),
    [
      'SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError',
      'SyntaxError,SyntaxError,SyntaxError,SyntaxError,ok,TypeError,TypeError',
      'NotSupportedError|1|boolean',
    ].join(','),
  );
});

/** A server that establishes every session and echoes what it is sent. */
function echoing(choose = ''): FakeTransport {
  return new FakeTransport((server) => {
    server.echoDatagrams = true;
    server.echoStreams = true;
    server.accept(choose);
  });
}

test('a session is established with what the page asked for, its origin and headers on the CONNECT', async () => {
  const transport = echoing('b');
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test:4433/echo?x=1", { protocols: ["a", "b"], headers: { "x-trace": "7", cookie: "no" }, congestionControl: "low-latency" });' +
      'log("before", wt.reliability, wt.protocol, wt.congestionControl);' +
      'wt.ready.then(function () { log("ready", wt.reliability, wt.protocol, wt.congestionControl); });',
    transport,
  );
  assert.equal(await p.until('before|'), 'pending||low-latency');
  assert.equal(await p.until('ready|'), 'supports-unreliable|b|low-latency');
  const request = transport.servers[0].request;
  assert.equal(request.url, 'https://wt.test:4433/echo?x=1');
  assert.equal(request.origin, 'https://example.test');
  assert.deepEqual(request.protocols, ['a', 'b']);
  // a cookie is the browser's to send, never the page's
  assert.deepEqual(request.headers, [['x-trace', '7']]);
});

test('a port no browser connects to is refused before anything is asked of the seam', async () => {
  const transport = echoing();
  const p = await page(
    LOG +
      'new WebTransport("https://wt.test:0/").ready.catch(function (e) { log("refused", e.name, e.source); });',
    transport,
  );
  assert.equal(await p.until('refused|'), 'WebTransportError|session');
  assert.equal(transport.servers.length, 0);
  assert.equal(badPort('https://wt.test/'), false);
  assert.equal(badPort('https://wt.test:25/'), true);
});

test('datagrams are written and read, into the reader’s own buffer where it brings one, and a writer is held back while the queue is full', async () => {
  const transport = echoing();
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test/echo", { datagramsReadableType: "bytes" });' +
      'var dg = wt.datagrams;' +
      'log("sizes", dg.maxDatagramSize, dg.incomingMaxAge, dg.outgoingMaxBufferedDatagrams >= 1);' +
      'dg.incomingMaxBufferedDatagrams = -1; var wrapped = dg.incomingMaxBufferedDatagrams; dg.incomingMaxBufferedDatagrams = NaN;' +
      'var refused = []; try { dg.incomingMaxAge = -1; } catch (e) { refused.push(e.name); }' +
      'dg.outgoingMaxAge = 0; log("setters", wrapped, dg.incomingMaxBufferedDatagrams, refused, dg.outgoingMaxAge);' +
      'wt.ready.then(async function () {' +
      '  log("max", dg.maxDatagramSize);' +
      '  var writer = dg.createWritable().getWriter();' +
      '  await writer.write(new Uint8Array([1, 2, 3]));' +
      '  var reader = dg.readable.getReader({ mode: "byob" });' +
      '  var got = await reader.read(new Uint8Array(8));' +
      '  log("byob", Array.from(got.value).join(","), got.value.buffer.byteLength);' +
      '  await writer.write(new Uint8Array(5000));' +
      '  dg.outgoingMaxBufferedDatagrams = 2;' +
      '  writer.write(new Uint8Array([9])); var held = false; writer.write(new Uint8Array([10]));' +
      '  writer.ready.then(function () { held = true; });' +
      '  for (var i = 0; i < 10; i++) await Promise.resolve();' +
      '  log("held", held); await writer.ready; log("released");' +
      '  try { await writer.write("text"); } catch (e) { log("bad", e.name); }' +
      '});',
    transport,
  );
  assert.equal(await p.until('sizes|'), '1024||true');
  assert.equal(await p.until('setters|'), '4294967295|1|RangeError|');
  assert.equal(await p.until('max|'), '1200');
  assert.equal(await p.until('byob|'), '1,2,3|8');
  assert.equal(await p.until('held|'), 'false');
  await p.until('released');
  assert.equal(await p.until('bad|'), 'TypeError');
  const server = transport.servers[0];
  // sent a task after they were written, as a browser's are
  for (let i = 0; server.datagrams.length < 3 && i < 100; i++) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  // the 5000 bytes were larger than the session takes: dropped, not sent
  assert.deepEqual(
    server.datagrams.map((d) => Array.from(d).join(',')),
    ['1,2,3', '9', '10'],
  );
});

test('a datagram larger than a reader’s buffer errors its stream with a RangeError', async () => {
  const transport = new FakeTransport((server) => {
    server.accept();
    setTimeout(() => server.datagram(new Uint8Array(10)), 20);
  });
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test/", { datagramsReadableType: "bytes" });' +
      'var reader = wt.datagrams.readable.getReader({ mode: "byob" });' +
      'reader.read(new Uint8Array(1)).catch(function (e) { log("read", e.name); });' +
      'try { new WebTransport("https://wt.test/").datagrams.readable.getReader({ mode: "byob" }); } catch (e) { log("default", e.name); }',
    transport,
  );
  assert.equal(await p.until('default|'), 'TypeError');
  assert.equal(await p.until('read|'), 'RangeError');
});

test('streams carry bytes both ways, the server’s arrive as incoming streams, and what each side ends is ended', async () => {
  let incoming: FakeServer | null = null;
  const transport = new FakeTransport((server) => {
    server.echoStreams = true;
    server.accept();
    incoming = server;
  });
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test/");' +
      'async function text(readable) { var t = ""; var d = new TextDecoder();' +
      '  for await (var chunk of readable) t += d.decode(chunk, { stream: true }); return t; }' +
      'wt.createBidirectionalStream({ sendOrder: 3 }).then(async function (bidi) {' +
      '  log("kinds", bidi instanceof WebTransportBidirectionalStream, bidi.readable instanceof WebTransportReceiveStream, bidi.writable instanceof WebTransportSendStream, bidi.writable.sendOrder);' +
      '  var writer = bidi.writable.getWriter();' +
      '  log("writer", writer instanceof WebTransportWriter, writer instanceof WritableStreamDefaultWriter);' +
      '  await writer.write(new TextEncoder().encode("hello "));' +
      '  await writer.write(new TextEncoder().encode("world"));' +
      '  bidi.writable.sendOrder = null;' +
      '  await writer.close();' +
      '  log("echo", await text(bidi.readable));' +
      '  var uni = await wt.createUnidirectionalStream();' +
      '  var w = uni.getWriter(); await w.write(new Uint8Array([7])); await w.close(); log("uni sent");' +
      '  var r = wt.incomingUnidirectionalStreams.getReader(); var s = (await r.read()).value;' +
      '  var buffer = new ArrayBuffer(4); var byob = s.getReader({ mode: "byob" });' +
      '  var got = await byob.read(new Uint8Array(buffer, 0, 4));' +
      '  log("incoming", Array.from(got.value).join(","), (await byob.read(new Uint8Array(4))).done);' +
      '}).catch(function (e) { log("failed", e); });',
    transport,
  );
  assert.equal(await p.until('kinds|'), 'true|true|true|3');
  assert.equal(await p.until('writer|'), 'true|true');
  assert.equal(await p.until('echo|'), 'hello world');
  await p.until('uni sent');
  const server = incoming as unknown as FakeServer;
  assert.equal(server.streams.length, 2);
  assert.equal(server.streams[0].priority.sendOrder, 0);
  assert.deepEqual(Array.from(server.streams[1].received[0]), [7]);
  assert.equal(server.streams[1].finished, true);
  const fromServer = server.open(false);
  fromServer.send(new Uint8Array([4, 5, 6]));
  fromServer.end();
  assert.equal(await p.until('incoming|'), '4,5,6|true');
});

test('a reset and a stop carry the page’s codes, and the server’s reach the page as its own errors', async () => {
  let server: FakeServer | null = null;
  const transport = new FakeTransport((s) => {
    s.accept();
    server = s;
  });
  const p = await page(
    LOG +
      'var reach = "return typeof process";' +
      'var wt = new WebTransport("https://wt.test/");' +
      'var kept = {};' +
      'wt.ready.then(async function () {' +
      '  var a = await wt.createBidirectionalStream();' +
      '  await a.writable.abort(new WebTransportError({ streamErrorCode: 139 }));' +
      '  await a.readable.cancel(new WebTransportError("", { streamErrorCode: 52 }));' +
      '  var b = await wt.createBidirectionalStream(); kept.b = b;' +
      '  var w = b.writable.getWriter(); await w.write(new Uint8Array([1]));' +
      '  var c = await wt.createUnidirectionalStream(); var cw = c.getWriter(); await cw.write(new Uint8Array(64)); var closing = cw.close();' +
      '  var e = new WebTransportError({ streamErrorCode: 134 }); var aborting = cw.abort(e);' +
      '  closing.catch(function (x) { log("close aborted", x === e); }); aborting.catch(function (x) { log("abort", x === e); });' +
      '  log("opened");' +
      '  b.readable.getReader().closed.catch(function (x) { log("reset", x.name, x.source, x.streamErrorCode, x.constructor.constructor(reach)()); });' +
      '  w.closed.catch(function (x) { log("stopped", x.name, x.source, x.streamErrorCode); });' +
      '});',
    transport,
  );
  await p.until('opened');
  const s = server as unknown as FakeServer;
  assert.equal(s.streams[0].resetCode, 139);
  assert.equal(s.streams[0].stopCode, 52);
  assert.equal(await p.until('close aborted|'), 'true');
  assert.equal(await p.until('abort|'), 'true');
  assert.equal(s.streams[2].resetCode, 134);
  s.streams[1].serverReset(4294967295);
  s.streams[1].serverStop(0);
  assert.equal(
    await p.until('reset|'),
    'WebTransportError|stream|4294967295|undefined',
  );
  assert.equal(await p.until('stopped|'), 'WebTransportError|stream|0');
});

test('close() sends its code and a reason cut to 1024 bytes, and `closed` has the whole of it', async () => {
  const transport = echoing();
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test/");' +
      'var reason = "\\u3042".repeat(400);' +
      'wt.ready.then(async function () {' +
      '  var bidi = await wt.createBidirectionalStream();' +
      '  var reader = bidi.readable.getReader();' +
      '  wt.close({ closeCode: 11, reason: reason });' +
      '  var info = await wt.closed;' +
      '  log("closed", info.closeCode, info.reason === reason);' +
      '  reader.closed.catch(function (e) { log("stream", e.name); });' +
      '  wt.createUnidirectionalStream().catch(function (e) { log("after", e.name); });' +
      '  log("stats", typeof (await wt.getStats()).datagrams);' +
      '});',
    transport,
  );
  assert.equal(await p.until('closed|'), '11|true');
  assert.equal(await p.until('stream|'), 'AbortError');
  assert.equal(await p.until('after|'), 'InvalidStateError');
  assert.equal(await p.until('stats|'), 'object');
  const sent = transport.servers[0].closedWith!;
  assert.equal(sent.closeCode, 11);
  assert.equal(new TextEncoder().encode(sent.reason).length, 1023);
});

test('a session the server closes resolves `closed` with its code, one it loses rejects it, and draining is told', async () => {
  const transport = new FakeTransport((server) => {
    server.accept();
    const path = new URL(server.request.url).pathname;
    setTimeout(() => {
      if (path === '/close') server.close(32, 'abc');
      else if (path === '/drain') server.drain();
      else server.fail('The connection was lost.');
    }, 20);
  });
  const p = await page(
    LOG +
      'var a = new WebTransport("https://wt.test/close");' +
      'a.closed.then(function (i) { log("closed", i.closeCode, i.reason); });' +
      'var b = new WebTransport("https://wt.test/lost");' +
      'b.ready.then(function () { return b.closed; }).catch(function (e) { log("lost", e.name, e.source, e.message); });' +
      'b.incomingBidirectionalStreams.getReader().closed.catch(function (e) { log("incoming", e.name); });' +
      'var c = new WebTransport("https://wt.test/drain");' +
      'c.draining.then(function () { log("draining"); });',
    transport,
  );
  assert.equal(await p.until('closed|'), '32|abc');
  assert.equal(
    await p.until('lost|'),
    'WebTransportError|session|The connection was lost.',
  );
  assert.equal(await p.until('incoming|'), 'WebTransportError');
  await p.until('draining');
});

test('stats come from the connection, with the datagrams’ own beside them, and a send group reaches the seam as a number', async () => {
  const transport = echoing();
  const p = await page(
    LOG +
      'var wt = new WebTransport("https://wt.test/");' +
      'wt.getStats().then(function (s) {' +
      '  log("stats", s.smoothedRtt, s.minRtt, String(s.estimatedSendRate), s.atSendCapacity, JSON.stringify(s.datagrams), "lostOutgoing" in s.datagrams);' +
      '  var g = wt.createSendGroup(); log("group", g instanceof WebTransportSendGroup);' +
      '  return wt.createBidirectionalStream({ sendGroup: g, sendOrder: 2 }).then(function (b) {' +
      '    log("in group", b.writable.sendGroup === g); return g.getStats(); });' +
      '}).then(function (gs) { log("group stats", gs.bytesWritten); });' +
      'try { new WebTransport("https://wt.test/").createBidirectionalStream({ sendGroup: {} }).catch(function (e) { log("not a group", e.name); }); } catch (e) {}',
    transport,
  );
  assert.equal(
    await p.until('stats|'),
    '1.5|1|null|false|{"droppedIncoming":0,"expiredIncoming":0,"expiredOutgoing":0}|false',
  );
  assert.equal(await p.until('group|'), 'true');
  assert.equal(await p.until('in group|'), 'true');
  assert.equal(await p.until('group stats|'), '0');
  assert.equal(await p.until('not a group|'), 'TypeError');
  assert.equal(transport.servers[0].streams[0].priority.sendGroup, 1);
  assert.equal(transport.servers[0].streams[0].priority.sendOrder, 2);
});

test('a page served over plain http from elsewhere has no WebTransport, as Web IDL’s [SecureContext] has it', async () => {
  const p = await page(
    LOG + 'log("has", typeof WebTransport, typeof WebTransportError);',
    undefined,
    'http://example.test/page.html',
  );
  assert.equal(await p.until('has|'), 'undefined|undefined');
});
