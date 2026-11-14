// <Html scripts>' Web Animations, as a page hands them keyframes and reads
// them back: a keyframe-like object is read as Web Animations 1, 5.2.2 has
// it, its animatable properties alone and in code-point order;
// `commitStyles` writes the values of an element a script made a moment
// ago; and `getComputedStyle` reads the box-shadow and clip an animation
// sets. WPT's `web-animations/` holds the rest.
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
    `<div id="c"><div id="e"></div></div><script>console.log("out " + JSON.stringify((function () {
      var e = document.getElementById('e');
      var c = document.getElementById('c');
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test("a keyframe-like object's getters are called for its animatable properties alone, in code-point order", async () => {
  const out = await inPage(
    `var read = [];
     var frame = {};
     ['opacity', 'animationName', 'direction', 'left', 'fontSize', 'font-size', 'willChange'].forEach(function (name) {
       Object.defineProperty(frame, name, {
         get: function () { read.push(name); return '1'; }, enumerable: true });
     });
     new KeyframeEffect(null, frame);
     var indexed = read.slice();
     read.length = 0;
     new KeyframeEffect(null, [frame]);
     return [indexed, read];`,
  );
  const order = ['fontSize', 'left', 'opacity'];
  assert.deepEqual(out, [order, order]);
});

test('commitStyles writes the values of an element the script made a moment ago', async () => {
  const out = await inPage(
    `var d = document.createElement('div');
     document.body.appendChild(d);
     var a = d.animate({ opacity: ['0.2', '0.2'] }, { duration: 1, fill: 'forwards' });
     a.finish();
     a.commitStyles();
     return d.style.opacity;`,
  );
  assert.equal(out, '0.2');
});

test('getComputedStyle reads an element’s box-shadow and clip, an animated one among them', async () => {
  const out = await inPage(
    `var before = [getComputedStyle(e).boxShadow, getComputedStyle(e).clip];
     e.style.position = 'absolute';
     e.style.clip = 'rect(1px, auto, 3px, 4px)';
     c.style.color = 'rgb(0, 128, 0)';
     var a = e.animate([{ boxShadow: '2px 3px 4px 5px currentColor inset' },
       { boxShadow: '2px 3px 4px 5px currentColor inset' }], 10);
     a.pause();
     a.currentTime = 5;
     return before.concat([getComputedStyle(e).boxShadow, getComputedStyle(e).clip]);`,
  );
  assert.deepEqual(out, [
    'none',
    'auto',
    'rgb(0, 128, 0) 2px 3px 4px 5px inset',
    'rect(1px, auto, 3px, 4px)',
  ]);
});
