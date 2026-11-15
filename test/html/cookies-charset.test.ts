// A cookie's name and value are octets, which a page reads as their UTF-8
// decoding (RFC 6265bis, 5.6, and WPT's cookies/encoding/charset.html):
// fetch hands a Set-Cookie field over a byte a character, so the jar reads
// it as UTF-8, and sends the Cookie header back as the same bytes.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CookieJar } from '../../src/html/cookies.js';
import { HtmlNetwork } from '../../src/html/network.js';

test('a Set-Cookie field in UTF-8 is a cookie of those characters, and is sent back as the same bytes', async (t) => {
  const seen: string[] = [];
  const cookie = '春节回=4家路·春运; Path=/';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/set') {
      // the field as its UTF-8 bytes, which node writes a byte a character
      res.writeHead(200, {
        'set-cookie': Buffer.from(cookie, 'utf8').toString('latin1'),
      });
      res.end();
      return;
    }
    const raw = req.headers.cookie ?? '';
    seen.push(Buffer.from(raw, 'latin1').toString('utf8'));
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new CookieJar();
  const network = new HtmlNetwork({ connectTimeout: null, cookies: jar });
  const signal = new AbortController().signal;
  for await (const _ of (await network.document(`${origin}/set`, signal))
    .body) {
    // drained
  }
  assert.equal(
    jar.header(`${origin}/`, { http: false, sameSite: true }),
    '春节回=4家路·春运',
  );
  for await (const _ of (await network.document(`${origin}/read`, signal))
    .body) {
    // drained
  }
  assert.deepEqual(seen, ['春节回=4家路·春运']);
});
