// <Html scripts>' resource selection algorithm (HTML 4.8.11.5;
// `src/html/scripts/dom.ts`, "loading"): a media element's `src`, or its
// `<source>`s one after another, each that fails told so with `error`, the
// source pointer kept where HTML has it as a page puts nodes in and takes
// them out, `networkState` at each step, a fetch `preload="none"` holds
// back, and the document's `load` waiting for all of it. WPT's
// `html/semantics/embedded-content/media-elements/loading-the-media-resource/`
// holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { FetchRequest } from '../../src/html/scripts/host.js';
import { FONTS, PAGE, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** An MP4 of `seconds` whose `moov` is first, and some media after it. */
function mp4(seconds: number): Uint8Array {
  const u32 = (n: number) => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  const box = (type: string, content: number[]) => [
    ...u32(content.length + 8),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...content,
  ];
  const mvhd = new Array<number>(100).fill(0);
  mvhd.splice(12, 8, ...u32(1000), ...u32(seconds * 1000));
  const tkhd = new Array<number>(84).fill(0);
  tkhd.splice(76, 8, ...u32(320 * 65536), ...u32(240 * 65536));
  const head = [
    ...box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)).concat(0, 0, 2, 0)),
    ...box('moov', [...box('mvhd', mvhd), ...box('trak', box('tkhd', tkhd))]),
    ...u32(50_008),
    ...[...'mdat'].map((c) => c.charCodeAt(0)),
  ];
  const bytes = new Uint8Array(head.length + 50_000);
  bytes.set(head);
  return bytes;
}

/** A page whose media loads over a network: `clip.mp4` plays, and
 *  `broken.mp4` fails a moment later, as WPT's `delayed-broken-video.py`
 *  does. What the page logs with `out` is the answer. */
async function page(body: string, fetched: string[] = []): Promise<unknown> {
  const clip = mp4(4);
  const logs: string[] = [];
  const result = await renderX11(
    h(Html, {
      source: `<!doctype html><html><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE,
      scripts: {
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
        fetch: async (request: FetchRequest) => {
          fetched.push(request.url);
          const ok = request.url.endsWith('/clip.mp4');
          if (!ok) await new Promise((r) => setTimeout(r, 60));
          return {
            url: request.url,
            status: ok ? 200 : 404,
            statusText: ok ? 'OK' : 'Not Found',
            redirected: false,
            headers: [
              ['content-type', 'video/mp4'],
              ['content-length', String(ok ? clip.length : 0)],
            ] as [string, string][],
            body: '',
            bytes: ok ? clip : new Uint8Array(0),
          };
        },
      },
    }),
    FONTS ? { width: 200, height: 120, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  const found = () => logs.find((l) => l.startsWith('log: out'));
  while (!found() && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  result.unmount();
  const line = found();
  assert.ok(line, logs.join('\n'));
  return JSON.parse(line.slice('log: out'.length));
}

const OUT = 'function out(v) { console.log("out " + JSON.stringify(v)); }';

test('the sources are tried in turn from the pointer, and a source put in before it is not', async () => {
  // HTML's own example: a candidate that fails, one that fails later, and
  // the sources a script puts in while the second is fetched
  const counts = await page(
    `<script>${OUT} var n = {};
       function err(k) { n[k] = (n[k] || 0) + 1; }</script>` +
      '<video><source onerror="err(\'a\')">' +
      '<source onerror="err(\'b\')" src="broken.mp4">' +
      '<source onerror="err(\'c\')"></video>' +
      `<script>var v = document.querySelector('video');
       function made(k) { var s = document.createElement('source');
         s.onerror = function () { err(k); }; return s; }
       v.insertBefore(made('x1'), v.querySelector('[onerror="err(\\'a\\')"]'));
       v.insertBefore(made('x2'), v.querySelector('[onerror="err(\\'b\\')"]'));
       v.insertBefore(made('x3'), v.querySelector('[onerror="err(\\'c\\')"]'));
       v.appendChild(made('x4'));
       onload = function () { out([n, v.networkState]); };</script>`,
  );
  assert.deepEqual(counts, [{ a: 1, b: 1, c: 1, x3: 1, x4: 1 }, 3]);
});

test('networkState follows selection: NO_SOURCE at once, EMPTY with nothing to load, and a waiting element woken by a source', async () => {
  const states = await page(
    `<script>${OUT} var r = [];
       var v = document.createElement('video');
       r.push(v.networkState);
       v.appendChild(document.createElement('source'));
       r.push(v.networkState);
       v.removeChild(v.firstChild);
       queueMicrotask(function () {
         r.push(v.networkState);
         var w = document.createElement('video'), errors = 0;
         var s = document.createElement('source');
         s.onerror = function () {
           errors++;
           r.push('error', w.networkState);
           if (errors === 1) {
             var t = document.createElement('source');
             t.src = 'clip.mp4';
             w.appendChild(t);
           }
         };
         w.onloadedmetadata = function () {
           r.push('meta', w.networkState, w.currentSrc.slice(-8));
           out(r);
         };
         w.appendChild(s);
       });</script>`,
  );
  assert.deepEqual(states, [0, 3, 0, 'error', 3, 'meta', 2, 'clip.mp4']);
});

test('a candidate taken out while it is fetched fails without an error, and the next is tried', async () => {
  const told = await page(
    `<script>${OUT} var r = [];
       var v = document.createElement('video');
       var s = document.createElement('source'); s.src = 'broken.mp4';
       var s2 = document.createElement('source'); s2.src = 'broken.mp4?2';
       s.onerror = function () { r.push('s'); };
       s2.onerror = function () { r.push('s2', v.networkState); out(r); };
       v.appendChild(s); v.appendChild(s2);
       setTimeout(function () {
         r.push(v.currentSrc.slice(-10), v.networkState);
         v.removeChild(s);
       }, 10);</script>`,
  );
  assert.deepEqual(told, ['broken.mp4', 2, 's2', 3]);
});

test('preload="none" suspends before fetching anything, and play() goes on', async () => {
  const fetched: string[] = [];
  const told = await page(
    `<script>${OUT} var r = [];
       var v = document.createElement('video');
       v.preload = 'none';
       v.onsuspend = function () {
         r.push('suspend', v.networkState, v.readyState);
         v.play();
         r.push(v.networkState);
       };
       v.onloadedmetadata = function () { r.push('meta'); out(r); };
       v.src = 'clip.mp4';</script>`,
    fetched,
  );
  assert.deepEqual(told, ['suspend', 1, 0, 2, 'meta']);
  assert.equal(fetched.filter((u) => u.endsWith('clip.mp4')).length, 1);
});

test("the document's load waits for a media element still choosing its source", async () => {
  const told = await page(
    `<script>${OUT} var failed = false;</script>` +
      '<video><source src="broken.mp4" onerror="failed = true"></video>' +
      `<script>onload = function () {
         var v = document.querySelector('video');
         out([failed, v.networkState]);
       };</script>`,
  );
  assert.deepEqual(told, [true, 3]);
});
