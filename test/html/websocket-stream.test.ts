// `<Html scripts>`' WebSocketStream and WebSocketError (the WebSocketStream
// explainer, `src/html/scripts/websocket.ts`): a socket whose messages are a
// readable stream and whose sends a writable one, over the same `webSocket`
// seam as `WebSocket`, which a fake answers by hand here
// (`../fake-socket.ts`). WPT's `websockets/stream/tentative/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { HtmlWebSocket } from '../../src/html/socket.js';
import { FakeSockets } from '../fake-socket.js';
import type { FakeConnection } from '../fake-socket.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A page whose scripts run over `webSocket`, and the line it logs that
 *  starts with `out `. */
async function outOf(
  script: string,
  webSocket: HtmlWebSocket,
): Promise<unknown> {
  const logs: string[] = [];
  const result = await renderX11(
    h(Html, {
      source: `<!doctype html><html><body><script>${script}</script></body></html>`,
      partial: false,
      baseUrl: 'https://example.test/page.html',
      scripts: {
        webSocket,
        log: (level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  const line = () => logs.find((l) => l.startsWith('out '));
  while (!line() && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  result.unmount();
  assert.ok(line(), `no answer in:\n${logs.join('\n')}`);
  return JSON.parse(line()!.slice(4));
}

/** Connections that open, echo what they are sent and let it go. */
function echoing(): FakeSockets {
  return new FakeSockets((c: FakeConnection) => {
    c.echo = true;
    const drain = setInterval(() => c.drain(), 5);
    setTimeout(() => clearInterval(drain), 3000);
    setTimeout(() => c.open('v1', ''), 0);
  });
}

test('WebSocketError is a DOMException whose code and reason a close takes, checked as close() checks them', async () => {
  const out = await outOf(
    `var e = new WebSocketError();
     var f = new WebSocketError('m', { reason: 'why' });
     var errors = [];
     try { new WebSocketError('', { closeCode: 1001 }); } catch (x) { errors.push(x.name); }
     try { new WebSocketError('', { reason: 'x'.repeat(124) }); } catch (x) { errors.push(x.name); }
     console.log('out ' + JSON.stringify([e.name, e.code, e.message, e.closeCode, e.reason,
       e instanceof DOMException, f.closeCode, f.reason, f.message, errors]));`,
    new FakeSockets(),
  );
  assert.deepEqual(out, [
    'WebSocketError',
    0,
    '',
    null,
    '',
    true,
    1000,
    'why',
    'm',
    ['InvalidAccessError', 'SyntaxError'],
  ]);
});

test('a stream opens, reads what it is sent back as text and as bytes, and a writer that closes it closes it clean', async () => {
  const sockets = echoing();
  const out = await outOf(
    `(async function () {
       var wss = new WebSocketStream('wss://ws.test/echo', { protocols: ['v1'] });
       var info = await wss.opened;
       var writer = info.writable.getWriter();
       var reader = info.readable.getReader();
       await writer.write('hello');
       await writer.write(new Uint8Array([1, 2, 3]));
       var a = await reader.read();
       var b = await reader.read();
       await writer.close();
       var closed = await wss.closed;
       console.log('out ' + JSON.stringify([info.protocol, typeof info.extensions,
         a.value, b.value instanceof Uint8Array, Array.from(b.value),
         closed.closeCode, closed.reason, wss.url]));
     })();`,
    sockets,
  );
  assert.deepEqual(out, [
    'v1',
    'string',
    'hello',
    true,
    [1, 2, 3],
    1005,
    '',
    'wss://ws.test/echo',
  ]);
  assert.deepEqual(sockets.connections[0].closes, [[null, '']]);
});

test("a stream aborted before it is made makes no connection, and one closed uncleanly errors both its streams with closed's error", async () => {
  const sockets = new FakeSockets((c) => {
    setTimeout(() => c.open(), 0);
    setTimeout(() => c.events.closed(1006, '', false), 20);
  });
  const out = await outOf(
    `(async function () {
       var aborted = new WebSocketStream('wss://ws.test/a', { signal: AbortSignal.abort() });
       var why = await aborted.opened.then(function () { return 'opened'; }, function (e) { return e.name; });
       var wss = new WebSocketStream('wss://ws.test/b');
       var info = await wss.opened;
       var e = await wss.closed.then(function () { return null; }, function (x) { return x; });
       var read = await info.readable.getReader().read().then(function () { return null; }, function (x) { return x; });
       var ready = await info.writable.getWriter().ready.then(function () { return null; }, function (x) { return x; });
       console.log('out ' + JSON.stringify([why, e.constructor === WebSocketError, e.closeCode,
         read === e, ready === e]));
     })();`,
    sockets,
  );
  assert.deepEqual(out, ['AbortError', true, 1006, true, true]);
  // the aborted one asked for nothing
  assert.equal(sockets.connections.length, 1);
  assert.equal(sockets.connections[0].request.url, 'wss://ws.test/b');
});
