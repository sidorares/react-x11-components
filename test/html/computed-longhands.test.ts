// What `getComputedStyle` answers for the longhands a style holds and a page
// seldom reads, which `computed.ts` composes as they are read: a filter, an
// origin against the box, grid lines, tracks and areas, counters, quotes,
// the font's features and variants, and the keywords `appearance`,
// `touch-action` and `scrollbar-color` keep beside what they draw by. Each
// answer is Chrome's.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const STYLE = [
  'width: 100px',
  'height: 40px',
  'filter: blur(2px) brightness(50%) drop-shadow(red 1px 2px 3px) hue-rotate(1turn)',
  'backdrop-filter: grayscale(25%)',
  'transform-origin: 10% 3px',
  'counter-reset: a 2 b',
  "quotes: '«' '»'",
  'grid-row-start: span 2 x',
  'grid-auto-rows: minmax(10px, 1fr)',
  "grid-template-areas: 'a a .' 'b c c'",
  'touch-action: pan-y pan-left',
  'appearance: button',
  'scrollbar-color: red blue',
  "font-feature-settings: 'liga' 5, 'kern', 'dlig', 'liga' 0",
  'font-variant-numeric: tabular-nums oldstyle-nums',
  'font-kerning: none',
  'overflow-wrap: anywhere',
  'white-space: pre-line',
  'row-gap: 4px',
].join(';');

test('the longhands a page seldom reads compute as Chrome writes them', async () => {
  const page = await scriptedPage(
    `<div id="e" style="${STYLE}"></div><script>
      var cs = getComputedStyle(document.getElementById('e'));
      console.log('out ' + JSON.stringify([
        'filter', 'backdropFilter', 'transformOrigin', 'perspectiveOrigin',
        'counterReset', 'counterIncrement', 'quotes', 'gridRowStart',
        'gridAutoRows', 'gridTemplateAreas', 'touchAction', 'appearance',
        'scrollbarColor', 'fontFeatureSettings', 'fontVariantNumeric',
        'fontVariantCaps', 'fontKerning', 'overflowWrap', 'whiteSpaceCollapse',
        'gridRowGap', 'pageBreakInside',
      ].map(function (k) { return cs[k]; })));
    </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    'blur(2px) brightness(0.5) drop-shadow(rgb(255, 0, 0) 1px 2px 3px) hue-rotate(360deg)',
    'grayscale(0.25)',
    '10px 3px',
    '50px 20px',
    'a 2 b 0',
    'none',
    '"«" "»"',
    'span 2 x',
    'minmax(10px, 1fr)',
    '"a a ." "b c c"',
    'pan-left pan-y',
    'button',
    'rgb(255, 0, 0) rgb(0, 0, 255)',
    '"dlig", "kern", "liga" 0',
    'oldstyle-nums tabular-nums',
    'normal',
    'none',
    'anywhere',
    'preserve-breaks',
    '4px',
    'auto',
  ]);
});
