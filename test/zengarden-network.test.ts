// The Zen Garden bench's cache on disk (scripts/zengarden/ours.tsx), over
// the browser's network: what it keeps is what a server said, and a request
// that never got an answer is not kept at all.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { backoff, CachedNetwork } from '../scripts/zengarden/ours.js';

const PAGE = 'https://nextjs.org/blog';
const SHEET =
  'https://nextjs.org/_next/static/immutable/chunks/0kk8ai38a75w7.css';
const CSS = 'body{margin:0}';

/** A cache directory of the test's own, gone when it ends. */
function cacheDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'zengarden-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The waits between attempts, taken at once and noted. */
function holdBackoff(t: TestContext): number[] {
  const waits: number[] = [];
  t.mock.method(backoff, 'wait', async (ms: number) => {
    waits.push(ms);
  });
  return waits;
}

/** A 200 whose body stops partway, as one does when the fetch's timeout
 *  runs out while it is still arriving. */
function cutShort(): Response {
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    // the first chunk, and the timeout at the read after it: a head asked
    // for and let go of is a 200 like any other
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(new TextEncoder().encode(CSS.slice(0, 5)));
        return;
      }
      controller.error(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/css' },
  });
}

function whole(): Response {
  return new Response(CSS, {
    status: 200,
    headers: { 'content-type': 'text/css' },
  });
}

const text = (fetched: { bytes: Uint8Array } | null) =>
  fetched && new TextDecoder().decode(fetched.bytes);

test('a stylesheet whose body never came is not kept as missing: the run is told, and the next one asks again', async (t) => {
  const dir = cacheDir(t);
  const waits = holdBackoff(t);
  let arrives = false;
  t.mock.method(globalThis, 'fetch', async () =>
    arrives ? whole() : cutShort(),
  );

  const run = new CachedNetwork(dir);
  assert.equal(await run.resource(SHEET, 'stylesheet', PAGE), null);
  assert.deepEqual(
    run.takeDropped(),
    [SHEET],
    'a page drawn without it is not the page, and the run says so',
  );
  assert.deepEqual(readdirSync(dir), [], 'and nothing is kept for it');
  assert.deepEqual(waits, [1000, 2000], 'asked three times, apart');

  arrives = true;
  const next = new CachedNetwork(dir);
  assert.equal(text(await next.resource(SHEET, 'stylesheet', PAGE)), CSS);
  assert.deepEqual(next.takeDropped(), []);
});

test('a body that comes on the second asking is the file', async (t) => {
  const dir = cacheDir(t);
  const waits = holdBackoff(t);
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++asked === 1 ? cutShort() : whole(),
  );
  const run = new CachedNetwork(dir);
  assert.equal(text(await run.resource(SHEET, 'stylesheet', PAGE)), CSS);
  assert.deepEqual(run.takeDropped(), []);
  assert.deepEqual(waits, [1000]);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('asked the network');
  });
  assert.equal(
    text(await new CachedNetwork(dir).resource(SHEET, 'stylesheet', PAGE)),
    CSS,
    'and kept',
  );
});

test('a file the server says it has none of is kept as missing, and why', async (t) => {
  const dir = cacheDir(t);
  const waits = holdBackoff(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 404 }),
  );
  const run = new CachedNetwork(dir);
  assert.equal(await run.resource(SHEET, 'stylesheet', PAGE), null);
  assert.deepEqual(run.takeDropped(), []);
  assert.deepEqual(waits, [], 'an answer is not asked again');
  const [meta] = readdirSync(dir);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, meta), 'utf8')), {
    url: SHEET,
    missing: true,
    status: 404,
  });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('asked the network');
  });
  assert.equal(
    await new CachedNetwork(dir).resource(SHEET, 'stylesheet', PAGE),
    null,
    'the next run takes its word for it',
  );
});

test('a busy server is asked again, and one busy every time drops the request', async (t) => {
  const dir = cacheDir(t);
  const waits = holdBackoff(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  const run = new CachedNetwork(dir);
  assert.equal(await run.resource(SHEET, 'stylesheet', PAGE), null);
  assert.deepEqual(run.takeDropped(), [SHEET]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(readdirSync(dir), []);
});

test('an entry kept as missing without saying why is asked for again', async (t) => {
  // what the cache wrote after a 200 whose body never came, as it wrote
  // after a 404, before it told the two apart
  const dir = cacheDir(t);
  const key = createHash('sha1').update(SHEET).digest('hex');
  writeFileSync(
    join(dir, `${key}.json`),
    JSON.stringify({ url: SHEET, missing: true, answered: true }),
  );
  t.mock.method(globalThis, 'fetch', async () => whole());
  const run = new CachedNetwork(dir);
  assert.equal(text(await run.resource(SHEET, 'stylesheet', PAGE)), CSS);
});
