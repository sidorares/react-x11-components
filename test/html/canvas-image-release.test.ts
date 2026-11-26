// A `<canvas>`'s picture is an ntk `Image`, uploaded to the display as it is
// first drawn and freed by `destroy()` alone (`src/html/scripts/hook.ts`). A
// canvas a page changes at every frame made one at each and kept them all: the
// pixmaps of a WebGL stage's frames were gigabytes a minute, where the JavaScript
// heap showed nothing.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { Image as NtkImage } from 'react-x11/ntk';
import { cleanup, waitForPixel } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

test('a canvas drawn on at every frame frees the picture each frame replaced', async (t) => {
  let destroyed = 0;
  const destroy = NtkImage.prototype.destroy;
  NtkImage.prototype.destroy = function (this: unknown) {
    destroyed += 1;
    return destroy.call(this);
  };
  t.after(() => {
    NtkImage.prototype.destroy = destroy;
  });
  const p = await scriptedPage(
    '<style>canvas{display:block;width:40px;height:20px}</style>' +
      '<canvas id="c" width="4" height="2"></canvas><script>' +
      'var x = document.getElementById("c").getContext("2d"); var n = 0;' +
      'function frame() { n += 1; x.fillStyle = n % 2 ? "#ff0000" : "#0000ff"; x.fillRect(0, 0, 4, 2);' +
      '  if (n < 30) requestAnimationFrame(frame); else console.log("done|" + n); }' +
      'requestAnimationFrame(frame);' +
      '</script>',
    15000,
  );
  assert.equal(await p.until('done|'), '30');
  // 30 is even: the last frame is blue
  await waitForPixel(p.result.ctx, 20, 10, '#0000ff', {
    message: 'the last frame',
  });
  assert.ok(
    destroyed >= 5,
    `each frame's picture is freed as the next replaces it, was ${destroyed}`,
  );
});
