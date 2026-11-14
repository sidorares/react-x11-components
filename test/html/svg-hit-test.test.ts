// What a point over an inline `<svg>` is over (src/html/scripts/svg-geometry.ts,
// `svgElementAt`): the shape drawn topmost there, by its fill and its stroke
// and its `pointer-events` (SVG 2, 15.6), a text's run, and the `<svg>` where
// it is over none. WPT's `svg/interact/scripted/` holds the rest; what each
// case expects is what Chromium answers.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

test('elementFromPoint finds the shape drawn topmost, by fill, stroke and pointer-events', async () => {
  const page = await scriptedPage(
    `<svg width="200" height="100" style="display:block">
       <rect id="under" x="0" y="0" width="100" height="100" fill="blue"/>
       <g transform="translate(50 0)">
         <circle id="over" cx="25" cy="50" r="20" fill="green"/>
       </g>
       <rect id="hollow" x="120" y="10" width="60" height="60" fill="none" stroke="black" stroke-width="10"/>
       <rect id="ghost" x="0" y="80" width="40" height="20" fill="red" pointer-events="none"/>
     </svg>
     <script>addEventListener('load', function () {
       var at = function (x, y) {
         var el = document.elementFromPoint(x, y);
         return el ? (el.id || el.localName) : null;
       };
       console.log('out ' + JSON.stringify([
         at(75, 50), at(10, 10), at(150, 40), at(120, 40), at(20, 90), at(195, 95),
       ]));
     });</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, ['over', 'under', 'svg', 'hollow', 'under', 'svg']);
});
