// SVG Paths' `getPathData()`, `setPathData()` and `getPathSegmentAtLength()`
// on a `<path>` (src/html/scripts/path-data.ts): its `d` as segments, as
// written or normalized to absolute M, L, C and Z, a list a page writes back
// as far as it is path data, and the segment a length along it falls in.
// WPT's `svg/path/interfaces/` holds the rest; what each case expects is
// what Chromium answers.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. */
async function inPage(code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<script>console.log("out " + JSON.stringify((function () {
      var path = function (d) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        if (d !== undefined) p.setAttribute('d', d);
        return p;
      };
      var round = function (segs) {
        return segs.map(function (s) {
          return s.type + ' ' + s.values.map(function (v) {
            return Math.round(v * 100) / 100;
          }).join(' ');
        });
      };
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('getPathData reads d as written, a repeated command spelled out, up to its first error', async () => {
  const out = await inPage(
    `return [
       round(path('M 0 0 100 100 l 10 10 20 20 h 5 a 5 5 0 0 1 10 10 z').getPathData()),
       round(path('M 10 20 L').getPathData()),
       round(path('Z').getPathData()),
       round(path().getPathData()),
     ];`,
  );
  assert.deepEqual(out, [
    [
      'M 0 0',
      'L 100 100',
      'l 10 10',
      'l 20 20',
      'h 5',
      'a 5 5 0 0 1 10 10',
      'z ',
    ],
    ['M 10 20'],
    [],
    [],
  ]);
});

test('getPathData normalizes to absolute M, L, C and Z', async () => {
  const out = await inPage(
    `return [
       round(path('m 10 20 l 30 0 H 0 Z').getPathData({ normalize: true })),
       round(path('M 0 0 Q 30 30 30 60 t 30 0').getPathData({ normalize: true })),
       round(path('M 0 0 C 30,90 25,10 50,10 S 70,90 90,90').getPathData({ normalize: true })),
       round(path('M 6 10 A 10 10 10 0 0 15 10').getPathData({ normalize: true })),
     ];`,
  );
  assert.deepEqual(out, [
    ['M 10 20', 'L 40 20', 'L 0 20', 'Z '],
    ['M 0 0', 'C 20 20 30 40 30 60', 'C 30 80 40 80 60 60'],
    ['M 0 0', 'C 30 90 25 10 50 10', 'C 75 10 70 90 90 90'],
    ['M 6 10', 'C 8.83 11.43 12.17 11.43 15 10'],
  ]);
});

test('setPathData writes d, and stops at the first segment that is none', async () => {
  const out = await inPage(
    `var p = path('M 9 9');
     var out = [];
     p.setPathData([{ type: 'm', values: [5, 5] }, { type: 'l', values: [3, 4] },
                    { type: 'A', values: [25, 25, 0, 2, true, 50, 50] },
                    { type: 'z', values: [] }]);
     out.push(p.getAttribute('d'));
     p.setPathData([{ type: 'M', values: [0, 0] }, { type: 'L', values: [10, 10, 20, 20] }]);
     out.push(p.getAttribute('d'));
     p.setPathData([{ type: 'M', values: new Float32Array([1, 2]) }, { type: 'X', values: [] }]);
     out.push(p.getAttribute('d'));
     p.setPathData([]);
     out.push(p.getAttribute('d'));
     try { p.setPathData([{ type: 'M' }]); } catch (e) { out.push(e.name); }
     return out;`,
  );
  assert.deepEqual(out, [
    'm 5 5 l 3 4 A 25 25 0 1 1 50 50 Z',
    'M 0 0',
    'M 1 2',
    null,
    'TypeError',
  ]);
});

test('getPathSegmentAtLength answers the segment a length falls in, as written', async () => {
  const out = await inPage(
    `var d = path('M 0 0 L 100 0 L 100 100');
     var multi = path('M 0 0 L 100 0 Z M 200 0 L 300 0');
     var out = [0, 50, 100, 150, -10, 1000].map(function (l) {
       return round([d.getPathSegmentAtLength(l)])[0];
     });
     out.push(round([multi.getPathSegmentAtLength(150)])[0],
              round([multi.getPathSegmentAtLength(250)])[0],
              round([path('M 0 0 h 100').getPathSegmentAtLength(50)])[0],
              path('').getPathSegmentAtLength(10));
     try { d.getPathSegmentAtLength(NaN); } catch (e) { out.push(e.name); }
     return out;`,
  );
  assert.deepEqual(out, [
    'M 0 0',
    'L 100 0',
    'L 100 0',
    'L 100 100',
    'M 0 0',
    'L 100 100',
    'Z ',
    'L 300 0',
    'h 100',
    null,
    'TypeError',
  ]);
});
