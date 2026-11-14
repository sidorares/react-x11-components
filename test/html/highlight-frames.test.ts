// <Html> — custom highlights and text in a vertical writing mode's frame
// (`layout/writing.ts`): a `sideways-lr` frame's lines land on the page's
// pixels wherever its text ends, and a highlight a page sets after a frame
// was first painted is drawn in it. WPT's
// `css/css-highlight-api/painting/custom-highlight-painting-vertical-writing-mode-001`
// holds both.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import {
  boxOf,
  FONTS,
  metric,
  pixelsIn,
  render,
  scriptedPage,
  view,
} from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

/** Each column of a region, as '#' where something dark is drawn in it,
 *  'Y' where yellow is, and '.' where neither is. */
function columns(d: Uint8ClampedArray, width: number, height: number): string {
  let out = '';
  for (let x = 0; x < width; x += 1) {
    let ink = 0;
    let yellow = 0;
    for (let y = 0; y < height; y += 1) {
      const a = (y * width + x) * 4;
      const [r, g, b] = [d[a], d[a + 1], d[a + 2]];
      if (r > 200 && g > 200 && b < 80) yellow += 1;
      else if (r + g + b < 600) ink += 1;
    }
    out += yellow ? 'Y' : ink ? '#' : '.';
  }
  return out;
}

metric(
  "a sideways-lr line is across the page where it is, however far down its frame's corner falls",
  async () => {
    // the frame's corner is the bottom of its root, as far down as the text
    // is long: its fraction of a pixel moved every line a pixel across, as
    // the text was cut into spans one way or the other, and here as the box
    // above it is a fraction taller
    const drawn: string[] = [];
    for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
      const { result, node } = await render(
        `<style>body{margin:8px}</style>` +
          `<div style="height:${sixteenth / 16}px"></div>` +
          '<div id="s" style="writing-mode:sideways-lr;line-height:1">' +
          'One two three…</div>',
      );
      await act();
      const at = boxOf(view(node), 's');
      const d = await pixelsIn(result.ctx, {
        x: 0,
        y: Math.floor(at.y),
        width: 40,
        height: 160,
      });
      drawn.push(columns(d, 40, 160));
      result.unmount();
      cleanup();
    }
    assert.equal(new Set(drawn).size, 1, drawn.join('\n'));
  },
);

test('a highlight a page sets after a vertical line was painted is drawn on it', async () => {
  const page = await scriptedPage(
    `<style>.v{writing-mode:vertical-rl;line-height:1;font:16px sans-serif}
       ::highlight(h){background-color:#ffff00;color:#0000ff}</style>
     <div id="d" class="v">One two</div>
     <script>
       setTimeout(function () {
         var r = new Range();
         r.selectNodeContents(document.getElementById('d'));
         CSS.highlights.set('h', new Highlight(r));
         setTimeout(function () { console.log('lit'); }, 50);
       }, 100);
     </script>`,
  );
  await page.until('lit');
  for (let i = 0; i < 5; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  const d = await pixelsIn(page.result.ctx, {
    x: 0,
    y: 0,
    width: 30,
    height: 80,
  });
  page.result.unmount();
  // the surface the turned frame was drawn on was kept for the selection's
  // part in its text alone, and showed the line unlit
  assert.match(columns(d, 30, 80), /Y{10}/);
});
