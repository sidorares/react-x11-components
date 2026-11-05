import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { HtmlNetwork } from '../../src/html/network.js';

/** A server that answers each path with what `routes` says, and notes each
 *  request it heard. */
async function serving(
  t: { after(fn: () => void): void },
  routes: Record<
    string,
    (res: ServerResponse, heard: IncomingHttpHeaders, n: number) => void
  >,
): Promise<{
  base: string;
  heard: { path: string; method: string; headers: IncomingHttpHeaders }[];
}> {
  const heard: {
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
  }[] = [];
  const server = createServer((req, res) => {
    const path = req.url!;
    heard.push({ path, method: req.method!, headers: req.headers });
    const n = heard.filter((h) => h.path === path).length;
    const route = routes[path];
    if (route) route(res, req.headers, n);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    heard,
  };
}

function ask(
  network: HtmlNetwork,
  page: string,
  url: string,
  more: { method?: string; headers?: [string, string][]; cache?: string } = {},
) {
  return network.request(
    {
      url,
      method: more.method ?? 'GET',
      headers: more.headers ?? [],
      body: null,
      redirect: 'manual',
      ...(more.cache ? { cache: more.cache } : {}),
    },
    page,
    new AbortController().signal,
  );
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("a page's fresh response answers its next request, and a cache mode says what may", async (t) => {
  const { base, heard } = await serving(t, {
    '/fresh': (res, _, n) =>
      res.writeHead(200, { 'cache-control': 'max-age=600' }).end(`fresh ${n}`),
    '/gone': (res, _, n) =>
      res.writeHead(404, { 'cache-control': 'max-age=600' }).end(`gone ${n}`),
  });
  const network = new HtmlNetwork();
  const page = `${base}/`;
  assert.equal(
    text((await ask(network, page, `${base}/fresh`)).bytes),
    'fresh 1',
  );
  assert.equal(
    text((await ask(network, page, `${base}/fresh`)).bytes),
    'fresh 1',
  );
  // any status a server says is fresh is kept
  await ask(network, page, `${base}/gone`);
  const gone = await ask(network, page, `${base}/gone`);
  assert.deepEqual([gone.status, text(gone.bytes)], [404, 'gone 1']);

  // `no-store` asks past it and keeps nothing, and says so to the server
  const past = await ask(network, page, `${base}/fresh`, { cache: 'no-store' });
  assert.equal(text(past.bytes), 'fresh 2');
  const sent = heard.at(-1)!.headers;
  assert.deepEqual(
    [sent.pragma, sent['cache-control']],
    ['no-cache', 'no-cache'],
  );
  assert.equal(
    text((await ask(network, page, `${base}/fresh`)).bytes),
    'fresh 1',
  );
  // `reload` asks past it and keeps what comes
  await ask(network, page, `${base}/fresh`, { cache: 'reload' });
  assert.equal(
    text((await ask(network, page, `${base}/fresh`)).bytes),
    'fresh 3',
  );
  // a request's own `Cache-Control: no-cache` takes nothing kept
  const own = await ask(network, page, `${base}/fresh`, {
    headers: [['cache-control', 'no-cache']],
  });
  assert.equal(text(own.bytes), 'fresh 4');
});

test('a stale response is asked about by its validators, and a 304 says what it is now', async (t) => {
  const { base, heard } = await serving(t, {
    '/stale': (res, headers, n) => {
      if (headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"', 'x-seen': String(n) }).end();
      } else {
        res
          .writeHead(200, { etag: '"v1"', 'cache-control': 'max-age=0' })
          .end('body');
      }
    },
  });
  const network = new HtmlNetwork();
  const page = `${base}/`;
  await ask(network, page, `${base}/stale`);
  const again = await ask(network, page, `${base}/stale`);
  assert.equal(heard.at(-1)!.headers['if-none-match'], '"v1"');
  // what the cache asked is no request of the page's for no cached answer:
  // the runtime's `fetch` adds nothing to it
  assert.equal(heard.at(-1)!.headers.pragma, undefined);
  assert.equal(heard.at(-1)!.headers['cache-control'], undefined);
  assert.deepEqual(
    [again.status, again.statusText, text(again.bytes)],
    [200, 'OK', 'body'],
  );
  assert.equal(new Map(again.headers).get('x-seen'), '2');
  // `force-cache` takes it stale as it is, and asks nothing
  const forced = await ask(network, page, `${base}/stale`, {
    cache: 'force-cache',
  });
  assert.equal(text(forced.bytes), 'body');
  assert.equal(heard.length, 2);
  // a page that asks a server itself is answered by the server, untouched
  await ask(network, page, `${base}/stale`, {
    headers: [['if-none-match', '"other"']],
  });
  assert.equal(heard.at(-1)!.headers['if-none-match'], '"other"');
});

test('only-if-cached is answered from what is kept or fails, and an unsafe method makes its URL stale', async (t) => {
  const { base, heard } = await serving(t, {
    '/r': (res, _, n) =>
      res.writeHead(200, { 'cache-control': 'max-age=600' }).end(`r ${n}`),
  });
  const network = new HtmlNetwork();
  const page = `${base}/`;
  await assert.rejects(
    ask(network, page, `${base}/r`, { cache: 'only-if-cached' }),
    TypeError,
  );
  assert.equal(heard.length, 0, 'nothing went to the server');
  await ask(network, page, `${base}/r`);
  const kept = await ask(network, page, `${base}/r`, {
    cache: 'only-if-cached',
  });
  assert.equal(text(kept.bytes), 'r 1');
  await ask(network, page, `${base}/r`, { method: 'POST' });
  assert.equal(text((await ask(network, page, `${base}/r`)).bytes), 'r 3');
});
