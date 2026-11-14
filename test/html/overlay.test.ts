// <Html scripts>' `overlay` (CSS Position 4, 3.2): what is in the top layer
// computes to `auto` and all else to `none`, a page sets it to nothing but
// reads back what it wrote where that is a keyword it takes, and a
// transition of it with `allow-discrete` keeps a closing popover in the top
// layer, in its place there, to the transition's end. WPT's
// `css/css-position/overlay/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, pixelsIn, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

test("overlay computes to auto in the top layer, and a page's own is a keyword it takes and does nothing", async () => {
  const page = await scriptedPage(
    `<div id="d"></div><div id="p" popover="manual"></div>
     <script>
       var d = document.getElementById('d');
       var p = document.getElementById('p');
       var out = [getComputedStyle(d).overlay];
       p.showPopover();
       out.push(getComputedStyle(p).overlay);
       d.style.overlay = 'browser';
       out.push(d.style.overlay);
       d.style.overlay = 'auto';
       out.push(d.style.overlay, getComputedStyle(d).overlay);
       console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  assert.deepEqual(JSON.parse(await page.until('out')), [
    'none',
    'auto',
    '',
    'auto',
    'none',
  ]);
  page.result.unmount();
});

test('a popover hidden under a transition of overlay is drawn in its place in the top layer to its end', async () => {
  const page = await scriptedPage(
    `<style>
       #red, #green { display: block; border: none; margin: 0; padding: 0;
                      width: 100vw; height: 100vh }
       #red { background: #ff0000 }
       #green { background: #00ff00 }
       #green.out { transition: overlay 60s step-end; transition-behavior: allow-discrete }
     </style>
     <div id="red" popover="manual"></div><div id="green" popover="manual"></div>
     <script>
       var red = document.getElementById('red');
       var green = document.getElementById('green');
       red.showPopover();
       green.showPopover();
       document.body.offsetTop;
       green.className = 'out';
       green.hidePopover();
       console.log('out ' + getComputedStyle(green).overlay);
     </script>`,
  );
  assert.equal(await page.until('out'), 'auto');
  for (let i = 0; i < 5; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  const d = await pixelsIn(page.result.ctx, {
    x: 20,
    y: 20,
    width: 1,
    height: 1,
  });
  // over the red one it went into the top layer after, though it has left
  // the layer: its order there is kept while its overlay runs
  assert.deepEqual([d[0], d[1], d[2]], [0, 255, 0]);
  page.result.unmount();
});
