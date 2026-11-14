// `shape-outside`, `shape-margin` and `shape-image-threshold`, and the basic
// shapes `clip-path` takes (src/html/css/shape-outside.ts): as `el.style`
// keeps them, in canonical form or not at all, and as `getComputedStyle`
// reads them. WPT's `css/css-shapes/` holds the rest; what each case
// expects is what Chromium answers.
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
    `<div id="d" style="font-size: 10px"></div>
     <script>console.log("out " + JSON.stringify((function () {
       var d = document.getElementById('d');
       var set = function (prop, v) { d.style.cssText = 'font-size: 10px'; d.style.setProperty(prop, v); };
       var spec = function (prop, v) { set(prop, v); return d.style.getPropertyValue(prop); };
       var comp = function (prop, v) { set(prop, v); return getComputedStyle(d).getPropertyValue(prop); };
       ${code}
     })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a shape is kept in canonical form, and what is none is not kept', async () => {
  const out = await inPage(
    `return [
       'circle(at 10%)', 'circle(at top left)', 'circle(at bottom 10% right 20%)',
       'circle(closest-side at center)', 'ellipse(closest-side closest-side)',
       'inset(0 1px 0 1px round 5px 5px / 5px)', 'polygon(nonzero, 0 0, 1px 2px)',
       'polygon(round 0, 1px 2px)', 'margin-box polygon(evenodd, 1px 1px)',
       'content-box', 'circle(at 50% left)', 'circle(at top 50%)', 'ellipse(10px)',
       'inset(0px, 1px)', 'xywh(0px 1px -2% 3em)', 'auto',
     ].map(function (v) { return spec('shape-outside', v); });`,
  );
  assert.deepEqual(out, [
    'circle(at 10% center)',
    'circle(at left top)',
    'circle(at right 20% bottom 10%)',
    'circle(at center center)',
    'ellipse()',
    'inset(0px 1px round 5px)',
    'polygon(0px 0px, 1px 2px)',
    'polygon(1px 2px)',
    'polygon(evenodd, 1px 1px)',
    'content-box',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
});

test('a shape computes to its lengths, a position to two from the corner', async () => {
  const out = await inPage(
    `return [
       comp('shape-outside', 'circle(2em at right 10px bottom 20%)'),
       comp('shape-outside', 'circle()'),
       comp('shape-outside', 'ellipse(closest-side 1em at center) padding-box'),
       comp('shape-outside', 'rect(0px 3em 2% 1px)'),
       comp('shape-outside', 'xywh(10px 20px 30px 25px round 0 1px)'),
       comp('shape-outside', 'polygon(1em 2em) margin-box'),
       comp('shape-outside', 'path("M10,10h80v80h-80z")'),
       comp('shape-outside', 'none'),
       comp('shape-margin', '2em'),
       comp('shape-image-threshold', '-7'),
       spec('shape-image-threshold', '50%'),
       spec('shape-margin', '0'),
       spec('shape-margin', '-1px'),
       spec('clip-path', 'rect(0 0 0 0)'),
     ];`,
  );
  assert.deepEqual(out, [
    'circle(20px at calc(100% - 10px) 80%)',
    'circle()',
    'ellipse(closest-side 10px at 50% 50%) padding-box',
    'inset(0px calc(100% - 30px) 98% 1px)',
    'inset(20px calc(100% - 40px) calc(100% - 45px) 10px round 0px 1px)',
    'polygon(10px 20px)',
    'path("M 10 10 H 90 V 90 H 10 Z")',
    'none',
    '20px',
    '0',
    '0.5',
    '0px',
    '',
    'rect(0px 0px 0px 0px)',
  ]);
});
