// Resource Timing 2: the entry a fetch makes (`src/html/resource-timing.ts`)
// and what a page's scripts read of it (`src/html/scripts/resource-timing.ts`).
// WPT's resource-timing/ is the check; these hold the rules a host decides —
// what another origin lets a page see — and the buffer a page reads.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import type { ResourceRequest } from '../../src/html/index.js';
import {
  contentEncodingOf,
  minimizedMimeType,
  resourceEntry,
} from '../../src/html/resource-timing.js';
import type { ResourceClock } from '../../src/html/resource-timing.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/dir/page.html';
const ORIGIN = 'https://example.test';

/** A fetch of one request: sent at 10, answered at 20, its body in at 30. */
const once = (
  url: string,
  headers: [string, string][] = [],
  status = 200,
): ResourceClock => ({
  start: 5,
  hops: [{ url, sent: 10, answered: 20, status, headers }],
  end: 30,
  bytes: 100,
});

nodeTest(
  'an own-origin fetch shows its timing, its status and its sizes',
  () => {
    const entry = resourceEntry(
      once(`${ORIGIN}/a.js`, [['content-type', 'application/javascript']]),
      {
        name: `${ORIGIN}/a.js`,
        initiatorType: 'script',
        origin: ORIGIN,
        mode: 'no-cors',
      },
    )!;
    assert.equal(entry.startTime, 5);
    assert.equal(entry.fetchStart, 5);
    assert.equal(entry.requestStart, 10);
    assert.equal(entry.responseStart, 20);
    assert.equal(entry.responseEnd, 30);
    assert.equal(entry.duration, 25);
    assert.equal(entry.responseStatus, 200);
    assert.equal(entry.contentType, 'text/javascript');
    assert.equal(entry.decodedBodySize, 100);
    assert.ok(entry.transferSize > 100);
    assert.equal(entry.secureConnectionStart, 5, 'over https, a connection');
    assert.equal(entry.nextHopProtocol, 'http/1.1');
  },
);

nodeTest(
  'another origin with no Timing-Allow-Origin hides the timing, and a no-cors one the response too',
  () => {
    const url = 'https://other.test/a.png';
    const entry = resourceEntry(once(url, [['content-type', 'image/png']]), {
      name: url,
      initiatorType: 'img',
      origin: ORIGIN,
      mode: 'no-cors',
    })!;
    for (const name of [
      'requestStart',
      'responseStart',
      'domainLookupStart',
      'connectStart',
      'secureConnectionStart',
      'transferSize',
      'responseStatus',
      'decodedBodySize',
    ] as const) {
      assert.equal(entry[name], 0, name);
    }
    assert.equal(entry.fetchStart, entry.startTime);
    assert.equal(entry.responseEnd, 30);
    assert.equal(entry.contentType, '');
    assert.equal(entry.nextHopProtocol, '');
  },
);

nodeTest(
  'Timing-Allow-Origin lets the timing be seen, not an opaque response',
  () => {
    const url = 'https://other.test/a.png';
    const entry = resourceEntry(
      once(url, [['timing-allow-origin', ORIGIN]], 404),
      { name: url, initiatorType: 'img', origin: ORIGIN, mode: 'no-cors' },
    )!;
    assert.equal(entry.requestStart, 10);
    assert.ok(entry.transferSize > 0);
    assert.equal(entry.responseStatus, 0, 'an opaque response says no status');
    const cors = resourceEntry(once(url, [['timing-allow-origin', '*']], 404), {
      name: url,
      initiatorType: 'fetch',
      origin: ORIGIN,
      mode: 'cors',
    })!;
    assert.equal(cors.responseStatus, 404);
  },
);

nodeTest(
  'a redirect is timed where every hop allows it, and an origin it left asks as null',
  () => {
    const redirected: ResourceClock = {
      start: 5,
      hops: [
        { url: `${ORIGIN}/r`, sent: 6, answered: 8, status: 302, headers: [] },
        {
          url: 'https://other.test/x',
          sent: 9,
          answered: 12,
          status: 302,
          headers: [['timing-allow-origin', ORIGIN]],
        },
        {
          url: `${ORIGIN}/x`,
          sent: 13,
          answered: 15,
          status: 200,
          headers: [['timing-allow-origin', ORIGIN]],
        },
      ],
      end: 20,
      bytes: 1,
    };
    const context = {
      name: `${ORIGIN}/r`,
      initiatorType: 'fetch',
      origin: ORIGIN,
      mode: 'cors' as const,
    };
    assert.equal(resourceEntry(redirected, context)!.redirectStart, 0);
    redirected.hops[2].headers = [['timing-allow-origin', 'null']];
    const allowed = resourceEntry(redirected, context)!;
    assert.equal(allowed.redirectStart, 5);
    assert.equal(allowed.redirectEnd, 12);
    assert.equal(allowed.fetchStart, 13);
    assert.equal(allowed.requestStart, 13);
  },
);

nodeTest('a network error is an entry with nothing of a response', () => {
  const entry = resourceEntry(
    { start: 5, hops: [], end: 9, failed: true },
    {
      name: `${ORIGIN}/x`,
      initiatorType: 'fetch',
      origin: ORIGIN,
      mode: 'cors',
    },
  )!;
  assert.equal(entry.responseStatus, 0);
  assert.equal(entry.responseEnd, 9);
  assert.equal(entry.requestStart, 0);
});

nodeTest('only a fetch over HTTP makes an entry', () => {
  assert.equal(
    resourceEntry(once('data:,x'), {
      name: 'data:,x',
      initiatorType: 'img',
      origin: ORIGIN,
      mode: 'no-cors',
    }),
    null,
  );
});

nodeTest('a type is minimized as Fetch has it', () => {
  const of = (value: string) => minimizedMimeType([['content-type', value]]);
  assert.equal(of('application/x-javascript'), 'text/javascript');
  assert.equal(of('application/ld+json'), 'application/json');
  assert.equal(of('text/example+xml; charset=utf-8'), 'application/xml');
  assert.equal(of('image/svg+xml'), 'image/svg+xml');
  assert.equal(of('TEXT/HTML;CHARSET=GBK'), 'text/html');
  assert.equal(of('text/html;x=",";charset=gbk'), 'text/html');
  assert.equal(of('text/plain, */*'), 'text/plain');
  assert.equal(of('image/jpe'), '');
  assert.equal(minimizedMimeType([]), '');
});

nodeTest('a coding is named, or many, or one not known', () => {
  const of = (value: string) =>
    contentEncodingOf([['content-encoding', value]]);
  assert.equal(of('gZip '), 'gzip');
  assert.equal(of('br'), 'br');
  assert.equal(of('gzip, deflate'), 'multiple');
  assert.equal(of('gzip, '), 'multiple');
  assert.equal(of('identity'), '@unknown');
  assert.equal(of(''), '');
  assert.equal(contentEncodingOf([]), '');
});

/** A page whose `fetch` and resources are answered by the test, and what
 *  its scripts log. */
async function hosted(
  body: string,
  answer: (url: string) => FetchResponse,
  resource?: (request: ResourceRequest) => void,
) {
  const logs: string[] = [];
  await renderX11(
    React.createElement(Html, {
      source: `<!doctype html><html><head></head><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE,
      onResource: (request: ResourceRequest) => {
        resource?.(request);
        return null;
      },
      scripts: {
        log: (level: string, text: string) => void logs.push(text),
        fetch: async (request: FetchRequest) => answer(request.url),
      },
    }),
    { backend: 'mock' },
  );
  return {
    async until(done: (log: string) => boolean): Promise<string> {
      const end = Date.now() + 5000;
      while (!done(logs.join(' ')) && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      return logs.join(' ');
    },
  };
}

const ok = (url: string, headers: [string, string][] = []): FetchResponse => ({
  url,
  status: 200,
  statusText: 'OK',
  redirected: false,
  headers,
  body: 'hello',
});

test("a page's fetch and XMLHttpRequest are entries a PerformanceObserver hears", async () => {
  const doc = await hosted(
    '<script>' +
      "new PerformanceObserver(function (list) { list.getEntries().forEach(function (e) { console.log(e.initiatorType + ':' + e.name.split('/').pop() + ':' + e.responseStatus + ':' + e.contentType + ':' + (e instanceof PerformanceResourceTiming)) }) }).observe({ type: 'resource' });" +
      "fetch('a.txt').then(function (r) { return r.text() }).then(function () { var x = new XMLHttpRequest(); x.open('GET', 'b.txt'); x.send(); });" +
      '</script>',
    (url) => ok(url, [['content-type', 'text/plain']]),
  );
  assert.equal(
    await doc.until((l) => l.includes('xmlhttprequest')),
    'fetch:a.txt:200:text/plain:true xmlhttprequest:b.txt:200:text/plain:true',
  );
});

test('the buffer holds what its size lets it, and tells the page once it is full', async () => {
  const doc = await hosted(
    '<script>' +
      'performance.setResourceTimingBufferSize(1);' +
      "performance.onresourcetimingbufferfull = function () { console.log('full:' + performance.getEntriesByType('resource').length); performance.setResourceTimingBufferSize(3) };" +
      "Promise.all([fetch('a'), fetch('b')]).then(function () { setTimeout(function () { console.log('after:' + performance.getEntriesByType('resource').length) }, 50) });" +
      '</script>',
    (url) => ok(url),
  );
  assert.equal(await doc.until((l) => l.includes('after')), 'full:1 after:2');
});

test("an image the document asks for is an entry, and another origin's says none of its timing", async () => {
  const doc = await hosted(
    '<script>' +
      "new PerformanceObserver(function (list) { list.getEntries().forEach(function (e) { console.log(e.initiatorType + ':' + e.requestStart + ':' + e.responseStatus) }) }).observe({ type: 'resource' });" +
      "var img = new Image(); img.src = 'https://other.test/x.png'; document.body.appendChild(img);" +
      '</script>',
    (url) => ok(url),
    (request) => {
      // what `HtmlNetwork` would stamp of the fetch
      request.timing?.hops.push({
        url: request.url,
        sent: performance.now(),
        answered: performance.now(),
        status: 200,
        headers: [],
      });
    },
  );
  assert.equal(await doc.until((l) => l.includes('img')), 'img:0:0');
});

test('a response the host answers with no body still settles the fetch, and is timed', async () => {
  // what a service worker's answer may be: a head and nothing else
  const doc = await hosted(
    '<script>' +
      "fetch('empty').then(function (r) { console.log('status:' + r.status + ':' + performance.getEntriesByType('resource').length) }, function (e) { console.log('failed:' + e) });" +
      '</script>',
    (url) =>
      ({
        url,
        status: 204,
        statusText: 'No Content',
        redirected: false,
        headers: [],
      }) as unknown as FetchResponse,
  );
  assert.equal(await doc.until((l) => /status|failed/.test(l)), 'status:204:1');
});
