// What a page's `caches` keep: the semantics `askCaches` holds a store to, over
// memory and over the profile alike.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  askCaches,
  cacheMatches,
  cacheUrlKey,
  memoryCaches,
  varyNames,
} from '../../src/html/cache-storage.js';
import type {
  HtmlCacheAddition,
  HtmlCacheRequest,
  HtmlCacheResponse,
  HtmlCacheStore,
} from '../../src/html/cache-storage.js';
import { HtmlProfile } from '../../src/html/profile.js';

const ORIGIN = 'https://example.test';
const text = (s: string) => new TextEncoder().encode(s);
const request = (
  url: string,
  headers: [string, string][] = [],
  method = 'GET',
): HtmlCacheRequest => ({ url, method, headers });
const response = (headers: [string, string][] = []): HtmlCacheResponse => ({
  status: 200,
  statusText: 'OK',
  headers,
  type: 'basic',
  url: '',
  redirected: false,
});
const put = (
  url: string,
  body: string,
  head: [string, string][] = [],
  asked: [string, string][] = [],
) => ({
  type: 'put' as const,
  request: request(url, asked),
  response: response(head),
  bytes: text(body),
});

/** Each store a test runs over. */
const stores: [string, () => Promise<[HtmlCacheStore, () => void]>][] = [
  ['memory', async () => [memoryCaches(), () => {}]],
  [
    'the profile',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cache-storage-'));
      const profile = await HtmlProfile.open(dir);
      if (!profile?.storage.caches) return [memoryCaches(), () => {}];
      return [
        profile.storage.caches,
        () => {
          profile.close();
          rmSync(dir, { recursive: true, force: true });
        },
      ];
    },
  ],
];

for (const [name, make] of stores) {
  test(`${name}: a cache holds what was put, in order, and a put replaces`, async (t) => {
    const [store, done] = await make();
    t.after(done);
    askCaches(store, ORIGIN, { op: 'open', name: 'v1' });
    askCaches(store, ORIGIN, { op: 'open', name: 'v2' });
    assert.deepEqual(askCaches(store, ORIGIN, { op: 'names' }).names, [
      'v1',
      'v2',
    ]);
    askCaches(store, ORIGIN, {
      op: 'batch',
      name: 'v1',
      operations: [put('https://example.test/a', 'A')],
    });
    askCaches(store, ORIGIN, {
      op: 'batch',
      name: 'v1',
      operations: [
        put('https://example.test/b', 'B'),
        put('https://example.test/a?two', 'A2'),
      ],
    });
    askCaches(store, ORIGIN, {
      op: 'batch',
      name: 'v1',
      operations: [put('https://example.test/a', 'A again')],
    });
    const urls = askCaches(store, ORIGIN, {
      op: 'keys',
      name: 'v1',
      request: null,
      options: {},
    }).requests!.map((r) => r.url);
    assert.deepEqual(urls, [
      'https://example.test/b',
      'https://example.test/a?two',
      'https://example.test/a',
    ]);
    const found = askCaches(store, ORIGIN, {
      op: 'match',
      name: null,
      request: request('https://example.test/a#fragment'),
      options: {},
    });
    assert.equal(
      new TextDecoder().decode(found.responses![0].bytes),
      'A again',
    );
    assert.equal(
      askCaches(store, ORIGIN, {
        op: 'matchAll',
        name: 'v1',
        request: request('https://example.test/a'),
        options: { ignoreSearch: true },
      }).responses!.length,
      2,
    );
    assert.deepEqual(askCaches(store, ORIGIN, { op: 'delete', name: 'v1' }), {
      value: true,
    });
    assert.deepEqual(
      askCaches(store, ORIGIN, {
        op: 'matchAll',
        name: 'v1',
        request: null,
        options: {},
      }).responses,
      [],
    );
  });

  test(`${name}: a batch that puts one request twice keeps none of it, and another origin reads nothing`, async (t) => {
    const [store, done] = await make();
    t.after(done);
    askCaches(store, ORIGIN, { op: 'open', name: 'c' });
    assert.deepEqual(
      askCaches(store, ORIGIN, {
        op: 'batch',
        name: 'c',
        operations: [
          put('https://example.test/a', '1'),
          put('https://example.test/a', '2'),
        ],
      }),
      { error: 'InvalidStateError' },
    );
    assert.equal(store.entries(ORIGIN, 'c').length, 0);
    askCaches(store, ORIGIN, {
      op: 'batch',
      name: 'c',
      operations: [put('https://example.test/a', '1')],
    });
    assert.deepEqual(askCaches(store, 'https://other.test', { op: 'names' }), {
      names: [],
    });
    assert.deepEqual(
      askCaches(store, 'https://other.test', {
        op: 'match',
        name: null,
        request: request('https://example.test/a'),
        options: {},
      }),
      { responses: [] },
    );
  });
}

test('a query goes by what the response varies on', () => {
  const entry = {
    request: request('https://example.test/a', [['accept', 'text/html']]),
    response: response([['Vary', 'Accept, Cookie']]),
  };
  assert.deepEqual(varyNames(entry.response.headers), ['accept', 'cookie']);
  assert.equal(
    cacheMatches(
      request('https://example.test/a', [['accept', 'text/html']]),
      entry,
    ),
    true,
  );
  assert.equal(
    cacheMatches(
      request('https://example.test/a', [['accept', 'image/png']]),
      entry,
    ),
    false,
  );
  assert.equal(
    cacheMatches(
      request('https://example.test/a', [['accept', 'image/png']]),
      entry,
      { ignoreVary: true },
    ),
    true,
  );
  // what matches nothing matches nothing unless a query asks past it
  const every = {
    request: request('https://example.test/a'),
    response: response([['vary', '*']]),
  };
  assert.equal(cacheMatches(request('https://example.test/a'), every), false);
});

test('a cached item that is no GET is found only past its method', () => {
  const entry = {
    request: request('https://example.test/a', [], 'POST'),
    response: response(),
  };
  assert.equal(cacheMatches(request('https://example.test/a'), entry), false);
  assert.equal(
    cacheMatches(request('https://example.test/a'), entry, {
      ignoreMethod: true,
    }),
    true,
  );
});

test('what a URL is filed under has no query and no fragment', () => {
  assert.equal(cacheUrlKey('https://a.test/b?c#d'), 'https://a.test/b');
  assert.equal(cacheUrlKey('https://a.test/b#d?c'), 'https://a.test/b');
});

test('an origin past what it may keep is told so, and keeps what it had', async () => {
  const store = memoryCaches(4);
  store.create(ORIGIN, 'c');
  const item = (body: string): HtmlCacheAddition => ({
    request: request(`https://example.test/${body}`),
    response: response(),
    bytes: text(body),
  });
  assert.equal(store.commit(ORIGIN, 'c', [], [item('abcd')]), true);
  assert.equal(store.commit(ORIGIN, 'c', [], [item('e')]), false);
  assert.equal(store.entries(ORIGIN, 'c').length, 1);
});
