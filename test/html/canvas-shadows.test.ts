// <Html scripts>' canvas shadows and the colours a context reads back (HTML
// 4.12.5.1.18, 4.12.5.1.6): a fill or a stroke casts its shadow, moved by
// the offset and blurred, painted before the shape in the page's realm
// (`raster.ts`); and a colour set on a context reads back as the standard
// serializes it. WPT's `html/canvas/*/shadows/` and `fill-and-stroke-styles/`
// hold the rest.
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
      var c = document.createElement('canvas'); c.width = 100; c.height = 50;
      var x = c.getContext('2d');
      var at = function (px, py) {
        return Array.from(x.getImageData(px, py, 1, 1).data);
      };
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a fill casts its shadow at the offset, under the shape', async () => {
  const out = (await inPage(
    `x.shadowColor = '#0f0';
     x.shadowOffsetX = 50;
     x.fillStyle = '#f00';
     x.fillRect(0, 0, 50, 50);
     // a shadow the transform does not move
     x.setTransform(1, 0, 0, 1, 0, 0);
     return [at(25, 25), at(75, 25)];`,
  )) as number[][];
  assert.deepEqual(out, [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
});

test("a blurred shadow fades out from the shape's edge", async () => {
  const out = (await inPage(
    `x.shadowColor = 'rgba(0, 0, 255, 1)';
     x.shadowBlur = 8;
     x.fillRect(40, 15, 20, 20);
     return [at(50, 25)[3], at(37, 25)[3], at(30, 25)[3], at(10, 25)[3]];`,
  )) as number[];
  const [inside, near, far, none] = out;
  assert.equal(inside, 255, 'the shape itself');
  assert.ok(near > far && far > none, `fading: ${out.join(', ')}`);
  assert.equal(none, 0, 'no shadow out past three deviations');
});

test('a colour set on a context reads back serialized, and a bad one is ignored', async () => {
  const out = await inPage(
    `var out = [];
     x.fillStyle = '#0f0'; out.push(x.fillStyle);
     x.fillStyle = 'rgba(0,0,0,0)'; out.push(x.fillStyle);
     x.strokeStyle = 'hsla(120, 100%, 50%, 0.5)'; out.push(x.strokeStyle);
     x.shadowColor = 'red'; out.push(x.shadowColor);
     x.shadowColor = 'not a colour'; out.push(x.shadowColor);
     x.shadowBlur = -2; out.push(x.shadowBlur);
     x.lineJoin = 'invalid'; out.push(x.lineJoin);
     x.globalCompositeOperation = 'over'; out.push(x.globalCompositeOperation);
     return out;`,
  );
  assert.deepEqual(out, [
    '#00ff00',
    'rgba(0, 0, 0, 0)',
    'rgba(0, 255, 0, 0.5)',
    '#ff0000',
    '#ff0000',
    0,
    'miter',
    'source-over',
  ]);
});
