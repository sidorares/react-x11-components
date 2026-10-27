import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  INVALID,
  cacheControl,
  cachedResponse,
  conditionalHeaders,
  currentAge,
  freshened,
  freshnessLifetime,
  isFresh,
  varyMatches,
} from '../../src/html/http-cache.js';
import type {
  HtmlCachedHead,
  HtmlCachedResponse,
  HtmlHttpCacheStore,
} from '../../src/html/http-cache.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { HtmlProfile } from '../../src/html/profile.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const httpDate = (ms: number) => new Date(ms).toUTCString();

/** A head that came at `NOW` with these fields. */
function head(
  headers: [string, string][],
  times: { requestTime?: number; responseTime?: number } = {},
): HtmlCachedHead {
  return {
    requestTime: times.requestTime ?? NOW,
    responseTime: times.responseTime ?? NOW,
    status: 200,
    headers,
    vary: [],
  };
}

test('Cache-Control is read as RFC 9111 has it: names lowercased, values unquoted, a directive twice invalid', () => {
  const cc = cacheControl(
    'Max-Age=60, no-cache="Set-Cookie, X-A",, public , stale-if-error = 5',
  );
  assert.equal(cc.get('max-age'), '60');
  assert.equal(cc.get('no-cache'), 'Set-Cookie, X-A');
  assert.equal(cc.get('public'), null);
  assert.equal(cc.get('stale-if-error'), '5');
  assert.equal(cacheControl('max-age=60, max-age=120').get('max-age'), INVALID);
  assert.equal(cacheControl(null).size, 0);
});

test('a response is fresh for its max-age, else its Expires less its Date, else a tenth of its age since modified', () => {
  const date: [string, string] = ['date', httpDate(NOW)];
  assert.equal(
    freshnessLifetime(head([['cache-control', 'max-age=60']])),
    60e3,
  );
  assert.equal(
    freshnessLifetime(
      head([
        ['cache-control', 'max-age=60'],
        ['expires', httpDate(NOW + DAY)],
        date,
      ]),
    ),
    60e3,
    'max-age wins over Expires',
  );
  assert.equal(
    freshnessLifetime(head([['cache-control', 's-maxage=600']])),
    0,
    'a private cache reads no s-maxage',
  );
  assert.equal(
    freshnessLifetime(head([['expires', httpDate(NOW + 3600e3)], date])),
    3600e3,
  );
  assert.equal(
    freshnessLifetime(head([['expires', '0'], date])),
    0,
    'an Expires that is no date is stale',
  );
  assert.equal(
    freshnessLifetime(
      head([['last-modified', httpDate(NOW - 10 * DAY)], date]),
    ),
    DAY,
  );
  assert.equal(
    freshnessLifetime(
      head([['last-modified', httpDate(NOW - 1000 * DAY)], date]),
    ),
    7 * DAY,
    'and the heuristic is at most a week',
  );
  for (const fields of [
    [['cache-control', 'no-cache, max-age=600']],
    [['pragma', 'no-cache']],
    [['cache-control', 'max-age=60, max-age=60']],
    [['cache-control', 'max-age=soon']],
    [],
  ] as [string, string][][]) {
    assert.equal(freshnessLifetime(head(fields)), 0, JSON.stringify(fields));
  }
  assert.equal(
    freshnessLifetime(
      head([
        ['pragma', 'no-cache'],
        ['cache-control', 'max-age=60'],
      ]),
    ),
    60e3,
    'a Pragma is read only where there is no Cache-Control',
  );
});

test('a response ages by the Age it came with, the time it took to come, and the time since', () => {
  const kept = head(
    [
      ['date', httpDate(NOW - 5000)],
      ['age', '30'],
      ['cache-control', 'max-age=100'],
    ],
    { requestTime: NOW - 2000, responseTime: NOW },
  );
  // corrected age 30 + 2 s beats the apparent 5 s; then 10 s resident
  assert.equal(currentAge(kept, NOW + 10_000), 42_000);
  assert.ok(isFresh(kept, NOW + 50_000));
  assert.ok(!isFresh(kept, NOW + 70_000));
});

test('what is kept of a response: not one that says no-store, varies by everything or by a cookie, or has nothing to be used again by', () => {
  const answer = (headers: [string, string][], status = 200) => ({
    status,
    headers,
    bytes: new Uint8Array([1, 2, 3]),
    requestTime: NOW,
    responseTime: NOW,
  });
  const request = { accept: 'text/css,*/*;q=0.1', 'user-agent': 'x' };
  const kept = cachedResponse(
    answer([
      ['Cache-Control', 'max-age=60'],
      ['Content-Type', 'text/css'],
      ['Set-Cookie', 'a=1'],
      ['Content-Encoding', 'gzip'],
      ['Vary', 'Accept, Accept-Encoding, Origin'],
    ]),
    request,
  );
  assert.ok(kept);
  assert.deepEqual(kept.headers, [
    ['cache-control', 'max-age=60'],
    ['content-type', 'text/css'],
    ['vary', 'Accept, Accept-Encoding, Origin'],
  ]);
  assert.deepEqual(kept.vary, [
    ['accept', 'text/css,*/*;q=0.1'],
    ['origin', null],
  ]);
  assert.ok(varyMatches(kept, request));
  assert.ok(!varyMatches(kept, { ...request, accept: 'image/*' }));
  assert.ok(!varyMatches(kept, { ...request, origin: 'https://a.example' }));

  assert.ok(cachedResponse(answer([['etag', '"a"']]), request), 'a validator');
  for (const fields of [
    [['cache-control', 'no-store, max-age=60']],
    [
      ['cache-control', 'max-age=60'],
      ['vary', '*'],
    ],
    [
      ['cache-control', 'max-age=60'],
      ['vary', 'Cookie'],
    ],
    [['content-type', 'text/css']],
  ] as [string, string][][]) {
    assert.equal(cachedResponse(answer(fields), request), null);
  }
  assert.equal(
    cachedResponse(answer([['cache-control', 'max-age=60']], 204), request),
    null,
  );
});

test('a stale response is asked about by its validators, and a 304 takes its fields and drops a Date and an Age it does not have', () => {
  const kept = head([
    ['date', httpDate(NOW - DAY)],
    ['age', '100'],
    ['etag', 'W/"v1"'],
    ['last-modified', httpDate(NOW - 2 * DAY)],
    ['cache-control', 'max-age=60'],
    ['content-type', 'text/css'],
  ]);
  assert.deepEqual(conditionalHeaders(kept), {
    'if-none-match': 'W/"v1"',
    'if-modified-since': httpDate(NOW - 2 * DAY),
  });
  assert.equal(
    conditionalHeaders(head([['cache-control', 'max-age=1']])),
    null,
  );
  const after = freshened(
    kept,
    [
      ['Cache-Control', 'max-age=600'],
      ['Content-Length', '0'],
    ],
    NOW + 1000,
    NOW + 2000,
  );
  assert.equal(after.requestTime, NOW + 1000);
  assert.equal(after.responseTime, NOW + 2000);
  assert.deepEqual(after.headers, [
    ['etag', 'W/"v1"'],
    ['last-modified', httpDate(NOW - 2 * DAY)],
    ['content-type', 'text/css'],
    ['cache-control', 'max-age=600'],
  ]);
  assert.ok(isFresh(after, NOW + 100_000));
});

// --- the network ------------------------------------------------------------

/** A store in memory: what a store is asked to do, and nothing else. */
class MemoryStore implements HtmlHttpCacheStore {
  kept = new Map<string, HtmlCachedResponse>();
  get(key: string) {
    return this.kept.get(key) ?? null;
  }
  put(key: string, response: HtmlCachedResponse) {
    this.kept.set(key, response);
  }
  refresh(key: string, head: HtmlCachedHead) {
    const was = this.kept.get(key);
    if (was) this.kept.set(key, { ...head, bytes: was.bytes });
  }
  delete(key: string) {
    this.kept.delete(key);
  }
}

/** A server whose paths say how their responses may be cached, which
 *  counts what it is asked and keeps each request's header fields. */
async function cacheSite(t: { after(fn: () => void): void }) {
  const asked: { path: string; headers: IncomingHttpHeaders }[] = [];
  const versions = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    asked.push({ path, headers: req.headers });
    const version = versions.get(path) ?? 1;
    const etag = `"${path}-${version}"`;
    const body = `${path} v${version}`;
    const send = (headers: Record<string, string>) => {
      res.writeHead(200, { 'content-type': 'text/css', ...headers });
      res.end(body);
    };
    if (path === '/fresh.css') return send({ 'cache-control': 'max-age=3600' });
    if (path === '/validated.css') {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        res.end();
        return;
      }
      return send({ etag, 'cache-control': 'no-cache' });
    }
    if (path === '/old.css') {
      return send({ 'last-modified': httpDate(Date.now() - 10 * DAY) });
    }
    if (path === '/new.css') {
      const modified = httpDate(Date.now() - 1000);
      if (req.headers['if-modified-since']) {
        res.writeHead(304);
        res.end();
        return;
      }
      return send({ 'last-modified': modified, 'cache-control': 'max-age=0' });
    }
    if (path === '/nostore.css') {
      return send({ 'cache-control': 'no-store', etag });
    }
    if (path === '/plain.css') return send({});
    if (path === '/vary.css') {
      return send({ 'cache-control': 'max-age=3600', vary: 'Accept' });
    }
    if (path === '/moved.css') {
      res.writeHead(302, { location: '/fresh.css' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    page: `${origin}/page`,
    /** The same server as another site's. */
    otherPage: `http://localhost:${port}/page`,
    asked,
    count: (path: string) => asked.filter((a) => a.path === path).length,
    change: (path: string) => versions.set(path, (versions.get(path) ?? 1) + 1),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function css(
  network: HtmlNetwork,
  url: string,
  page: string,
  kind: 'stylesheet' | 'image' = 'stylesheet',
): Promise<string | null> {
  const fetched = await network.resource(url, kind, page);
  return fetched && text(fetched.bytes);
}

test('a fresh response answers again with no request, from the memory and from a store the next network opens', async (t) => {
  const site = await cacheSite(t);
  const store = new MemoryStore();
  const url = `${site.origin}/fresh.css`;
  const first = new HtmlNetwork({ httpCache: store });
  const both = await Promise.all([
    css(first, url, site.page),
    css(first, url, site.page),
  ]);
  assert.deepEqual(both, ['/fresh.css v1', '/fresh.css v1']);
  assert.equal(
    site.count('/fresh.css'),
    1,
    'one request while it is on its way',
  );
  assert.equal(await css(first, url, site.page), '/fresh.css v1');
  assert.equal(site.count('/fresh.css'), 1, 'and none from the memory');
  const next = new HtmlNetwork({ httpCache: store });
  assert.equal(await css(next, url, site.page), '/fresh.css v1');
  assert.equal(site.count('/fresh.css'), 1, 'nor from the store');

  // one with only a Last-Modified long ago is fresh for a tenth of that
  const old = `${site.origin}/old.css`;
  await css(first, old, site.page);
  await css(next, old, site.page);
  assert.equal(site.count('/old.css'), 1);
});

test('a stale response is asked about by its validators, a 304 answers with the body kept, and a 200 replaces it', async (t) => {
  const site = await cacheSite(t);
  const store = new MemoryStore();
  const network = new HtmlNetwork({ httpCache: store });
  const url = `${site.origin}/validated.css`;
  assert.equal(await css(network, url, site.page), '/validated.css v1');
  assert.equal(await css(network, url, site.page), '/validated.css v1');
  assert.equal(
    site.count('/validated.css'),
    2,
    'no-cache is asked about at each use',
  );
  const [, again] = site.asked.filter((a) => a.path === '/validated.css');
  assert.equal(again.headers['if-none-match'], '"/validated.css-1"');

  // and a network with nothing in memory asks about the store's
  const next = new HtmlNetwork({ httpCache: store });
  assert.equal(await css(next, url, site.page), '/validated.css v1');
  assert.equal(
    site.asked.at(-1)!.headers['if-none-match'],
    '"/validated.css-1"',
  );

  site.change('/validated.css');
  assert.equal(await css(next, url, site.page), '/validated.css v2');
  const third = new HtmlNetwork({ httpCache: store });
  assert.equal(await css(third, url, site.page), '/validated.css v2');
  assert.equal(
    site.asked.at(-1)!.headers['if-none-match'],
    '"/validated.css-2"',
  );

  // a Last-Modified alone asks with If-Modified-Since
  const modified = `${site.origin}/new.css`;
  assert.equal(await css(network, modified, site.page), '/new.css v1');
  assert.equal(await css(network, modified, site.page), '/new.css v1');
  const asked = site.asked.filter((a) => a.path === '/new.css');
  assert.equal(asked.length, 2);
  assert.ok(asked[1].headers['if-modified-since']);
});

test('what may not be used again is asked for each time: no-store, and a response with nothing to be fresh or asked about by', async (t) => {
  const site = await cacheSite(t);
  const store = new MemoryStore();
  const network = new HtmlNetwork({ httpCache: store });
  for (const path of ['/nostore.css', '/plain.css']) {
    await css(network, `${site.origin}${path}`, site.page);
    await css(network, `${site.origin}${path}`, site.page);
    assert.equal(site.count(path), 2, path);
    assert.equal(site.asked.at(-1)!.headers['if-none-match'], undefined);
  }
  assert.equal(store.kept.size, 0);
});

test('a response that varies by Accept answers only a request that accepts the same', async (t) => {
  const site = await cacheSite(t);
  const network = new HtmlNetwork({ httpCache: new MemoryStore() });
  const url = `${site.origin}/vary.css`;
  await css(network, url, site.page);
  await css(network, url, site.page);
  assert.equal(site.count('/vary.css'), 1);
  await css(network, url, site.page, 'image');
  assert.equal(site.count('/vary.css'), 2, 'an image asks with another Accept');
});

test('the cache is kept by the site that asked: another site asks for itself', async (t) => {
  const site = await cacheSite(t);
  const store = new MemoryStore();
  const network = new HtmlNetwork({ httpCache: store });
  const url = `${site.origin}/fresh.css`;
  await css(network, url, site.page);
  await css(network, url, `${site.origin}/another/page`);
  assert.equal(site.count('/fresh.css'), 1, 'a second page of the same site');
  await css(network, url, site.otherPage);
  assert.equal(site.count('/fresh.css'), 2, 'a page of another site');
  assert.equal(store.kept.size, 2);
});

test('a redirect is asked for each time, and where it led is kept under its own URL', async (t) => {
  const site = await cacheSite(t);
  const network = new HtmlNetwork({ httpCache: new MemoryStore() });
  assert.equal(
    await css(network, `${site.origin}/moved.css`, site.page),
    '/fresh.css v1',
  );
  await css(network, `${site.origin}/moved.css`, site.page);
  assert.equal(site.count('/moved.css'), 2);
  await css(network, `${site.origin}/fresh.css`, site.page);
  assert.equal(site.count('/fresh.css'), 2, 'the redirect followed twice');
});

test('a hard reload goes past every cache, and keeps what comes back', async (t) => {
  const site = await cacheSite(t);
  const store = new MemoryStore();
  const network = new HtmlNetwork({ httpCache: store });
  const url = `${site.origin}/fresh.css`;
  await css(network, url, site.page);
  site.change('/fresh.css');
  // what was asked for before the reload is told from what is asked for
  // after by the clock's milliseconds
  await new Promise((resolve) => setTimeout(resolve, 5));
  network.clear();
  assert.equal(await css(network, url, site.page), '/fresh.css v2');
  const reloaded = site.asked.at(-1)!;
  assert.equal(reloaded.headers['cache-control'], 'no-cache');
  assert.equal(reloaded.headers.pragma, 'no-cache');
  // what came back is used again, here and by the next network
  assert.equal(await css(network, url, site.page), '/fresh.css v2');
  assert.equal(
    await css(new HtmlNetwork({ httpCache: store }), url, site.page),
    '/fresh.css v2',
  );
  assert.equal(site.count('/fresh.css'), 2);
});

test('a network with no store keeps to the same rules in its memory', async (t) => {
  const site = await cacheSite(t);
  const network = new HtmlNetwork();
  await css(network, `${site.origin}/fresh.css`, site.page);
  await css(network, `${site.origin}/fresh.css`, site.page);
  assert.equal(site.count('/fresh.css'), 1);
  await css(network, `${site.origin}/validated.css`, site.page);
  await css(network, `${site.origin}/validated.css`, site.page);
  assert.equal(site.count('/validated.css'), 2);
  assert.equal(
    site.asked.at(-1)!.headers['if-none-match'],
    '"/validated.css-1"',
  );
});

test('a store that fails is a store that kept nothing: the page has its resource', async (t) => {
  const site = await cacheSite(t);
  const broken: HtmlHttpCacheStore = {
    get: () => Promise.reject(new Error('disk on fire')),
    put: () => {
      throw new Error('disk full');
    },
    refresh: () => {},
    delete: () => {},
  };
  const network = new HtmlNetwork({ httpCache: broken });
  assert.equal(
    await css(network, `${site.origin}/fresh.css`, site.page),
    '/fresh.css v1',
  );
});

// --- the profile's store --------------------------------------------------------

/** Whether this runtime has SQLite: Node 22.13 and later, and Bun. */
const SQLITE = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-probe-'));
  try {
    const profile = await HtmlProfile.open(dir);
    profile?.close();
    return !!profile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

test(
  'the profile keeps the cache on disk: the next run, and another process at once, find it',
  { skip: !SQLITE },
  async (t) => {
    const site = await cacheSite(t);
    const dir = mkdtempSync(join(tmpdir(), 'cache-profile-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const url = `${site.origin}/fresh.css`;
    const validated = `${site.origin}/validated.css`;

    const first = (await HtmlProfile.open(dir))!;
    const beside = (await HtmlProfile.open(dir))!;
    assert.ok(first.httpCache && beside.httpCache);
    const network = new HtmlNetwork({ httpCache: first.httpCache });
    await css(network, url, site.page);
    await css(network, validated, site.page);
    // a second process's network, with the file open at the same time
    const tab = new HtmlNetwork({ httpCache: beside.httpCache });
    assert.equal(await css(tab, url, site.page), '/fresh.css v1');
    assert.equal(site.count('/fresh.css'), 1);
    // a 304 there refreshes the row the first one reads
    assert.equal(await css(tab, validated, site.page), '/validated.css v1');
    assert.equal(site.count('/validated.css'), 2);
    first.close();
    beside.close();

    const again = (await HtmlProfile.open(dir))!;
    t.after(() => again.close());
    const next = new HtmlNetwork({ httpCache: again.httpCache! });
    assert.equal(await css(next, url, site.page), '/fresh.css v1');
    assert.equal(
      site.count('/fresh.css'),
      1,
      'a restart asks for nothing fresh',
    );
    assert.equal(await css(next, validated, site.page), '/validated.css v1');
    assert.equal(
      site.asked.at(-1)!.headers['if-none-match'],
      '"/validated.css-1"',
    );

    again.httpCache!.clear();
    await css(new HtmlNetwork({ httpCache: again.httpCache! }), url, site.page);
    assert.equal(site.count('/fresh.css'), 2, 'a cleared cache asks again');
  },
);

test(
  'the profile forgets the responses used longest ago past its bytes, and keeps none past them',
  { skip: !SQLITE },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-evict-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const profile = (await HtmlProfile.open(dir, { cacheBytes: 3000 }))!;
    t.after(() => profile.close());
    const cache = profile.httpCache!;
    const response = (size: number): HtmlCachedResponse => ({
      ...head([['cache-control', 'max-age=60']]),
      bytes: new Uint8Array(size),
    });
    cache.put('a', response(1000));
    cache.put('b', response(1000));
    cache.put('c', response(1000));
    assert.equal(cache.get('a'), null, 'the oldest goes');
    assert.ok(cache.get('b') && cache.get('c'));
    assert.equal(cache.get('c')!.bytes.length, 1000);
    assert.deepEqual(cache.get('c')!.headers, [
      ['cache-control', 'max-age=60'],
    ]);
    cache.put('huge', response(5000));
    assert.equal(
      cache.get('huge'),
      null,
      'one larger than the cache is not kept',
    );
    assert.ok(cache.get('c'), 'and takes nothing with it');

    const none = (await HtmlProfile.open(dir, { cacheBytes: 0 }))!;
    t.after(() => none.close());
    assert.equal(none.httpCache, null);
  },
);
