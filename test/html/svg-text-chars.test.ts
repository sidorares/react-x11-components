// SVGTextContentElement's characters (src/html/scripts/svg-geometry.ts,
// `placedChars`): each where SVG 2's text layout puts it, by the `x`, `y`,
// `dx`, `dy` and `rotate` lists around it and `text-anchor`, and read back
// through `getStartPositionOfChar()` and its kin. WPT's `svg/text/scripted/`
// holds the rest; what each case expects is what Chromium answers.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

test('a text element places its characters by its lists and its anchor', async () => {
  const page = await scriptedPage(
    `<svg width="400" height="200">
       <text id="t" x="10" y="50"><tspan id="s" x="50 150 100" dy="5">abc</tspan>  d</text>
       <text id="m" x="200" y="100" text-anchor="middle" rotate="10 20">mm</text>
     </svg>
     <script>addEventListener('load', function () {
       var t = document.getElementById('t'), s = document.getElementById('s');
       var m = document.getElementById('m');
       var start = m.getStartPositionOfChar(0), width = m.getComputedTextLength();
       var out = [t.getNumberOfChars(), s.getNumberOfChars(),
         s.getStartPositionOfChar(1).x, s.getStartPositionOfChar(0).y,
         s.getExtentOfChar(2).x,
         Math.round(start.x + width / 2), m.getRotationOfChar(1),
         Math.round(m.getSubStringLength(0, 2)) === Math.round(width),
         s.getCharNumAtPosition({ x: 151, y: 50 })];
       try { s.getExtentOfChar(3); } catch (e) { out.push(e.name); }
       console.log('out ' + JSON.stringify(out));
     });</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    5,
    3,
    150,
    55,
    100,
    200,
    20,
    true,
    1,
    'IndexSizeError',
  ]);
});
