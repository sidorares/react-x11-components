// threadTransport: the network's requests made on a worker thread, the
// response's head and body handed back, so a busy application thread holds
// no download back. What it answers has to be what the runtime's `fetch`
// answers the network: the bytes, the headers and each `Set-Cookie` apart,
// a redirect as it came, a stream body sent once, an abort, and a body
// nobody wants any more no longer read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { CookieJar } from '../../src/html/cookies.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { threadTransport } from '../../src/html/thread-transport.js';

async function serve(
  t: { after(fn: () => void): void },
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Bytes no two places in which are alike for long: a body cut, doubled
 *  or out of order is told from the one sent. */
function pattern(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + (i >> 9)) & 0xff;
  return bytes;
}

test('a resource comes whole through the thread, with its headers, its cookies and its redirects', async (t) => {
  const big = pattern(3 << 20);
  const seen: string[] = [];
  const origin = await serve(t, (req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.cookie ?? '-'}`);
    if (req.url === '/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // in pieces, as a server's write is
      for (let i = 0; i < big.length; i += 100_000) {
        res.write(big.subarray(i, i + 100_000));
      }
      res.end();
    } else if (req.url === '/login') {
      res.writeHead(303, {
        location: '/home',
        'set-cookie': [
          'session=abc; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT',
          'theme=dark; Path=/',
        ],
      });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-two': 'a' });
      res.end(`cookies: ${req.headers.cookie ?? ''}`);
    }
  });
  const network = new HtmlNetwork({
    fetch: threadTransport({ connectTimeout: null }),
    cookies: new CookieJar(),
  });
  const page = `${origin}/page`;
  const loaded = await network.load(`${origin}/big.bin`, 'image', page);
  assert.ok('fetched' in loaded, 'loaded');
  assert.equal(loaded.fetched.bytes.length, big.length);
  assert.ok(Buffer.from(loaded.fetched.bytes).equals(big), 'byte for byte');

  // a 303 that sets two cookies, followed by the network itself, which
  // reads each Set-Cookie apart — a date's own comma and all
  const fetch = network.fetcher(page);
  const signal = new AbortController().signal;
  const home = await fetch(
    { url: `${origin}/login`, method: 'POST', headers: [], body: 'u=me' },
    signal,
  );
  assert.equal(home.status, 200);
  assert.equal(home.body, 'cookies: session=abc; theme=dark');
  assert.deepEqual(seen.slice(-2), [
    'POST /login -',
    'GET /home session=abc; theme=dark',
  ]);
});

test("a redirect is answered as it came where it is not followed, and a page's stream is sent once", async (t) => {
  const seen: string[] = [];
  const origin = await serve(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(
        `${req.method} ${req.url} ${req.headers['content-length'] ?? '-'} ${Buffer.concat(chunks)}`,
      );
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/there' });
        res.end();
        return;
      }
      res.writeHead(421, { 'content-type': 'text/plain' });
      res.end('again');
    });
  });
  const transport = threadTransport({ connectTimeout: null });
  const signal = new AbortController().signal;
  const moved = await transport(`${origin}/moved`, {
    method: 'GET',
    headers: {},
    signal,
    redirect: 'manual',
  });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('Location'), '/there');
  await moved.body?.getReader().cancel();

  const streamed = await transport(`${origin}/stream`, {
    method: 'POST',
    headers: {},
    body: 'Test',
    streamedBody: true,
    signal,
    redirect: 'follow',
  });
  assert.equal(streamed.status, 421);
  const reader = streamed.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value!);
  }
  assert.equal(Buffer.concat(parts).toString(), 'again');
  assert.deepEqual(seen, ['GET /moved - ', 'POST /stream 4 Test']);
});

test('an abort fails the request, and a body nobody wants is no longer read', async (t) => {
  let closed: () => void = () => {};
  const gone = new Promise<void>((resolve) => (closed = resolve));
  let sent = 0;
  const origin = await serve(t, (req, res) => {
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const tick = setInterval(() => {
      res.write(Buffer.alloc(16_384));
      sent += 1;
    }, 5);
    res.on('close', () => {
      clearInterval(tick);
      closed();
    });
  });
  const transport = threadTransport({ connectTimeout: null });

  const controller = new AbortController();
  const slow = transport(`${origin}/slow`, {
    method: 'GET',
    headers: {},
    signal: controller.signal,
    redirect: 'follow',
  });
  controller.abort();
  await assert.rejects(slow, { name: 'AbortError' });

  const endless = await transport(`${origin}/endless`, {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
    redirect: 'follow',
  });
  const reader = endless.body!.getReader();
  const first = await reader.read();
  assert.ok(!first.done && first.value!.length > 0, 'its body comes');
  await reader.cancel();
  // the thread stops reading and lets the connection go
  await gone;
  const at = sent;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent, at, 'nothing more is sent');
});
