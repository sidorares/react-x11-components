// <Html scripts>' composite operations (Web Animations 1, 5.4.4 and
// 4.4.9): an effect or a keyframe whose `composite` is `add` or
// `accumulate` puts its values on top of what is under them — the element's
// own style, or the animations under it — and `iterationComposite:
// 'accumulate'` adds the last frame's value again at each iteration. The
// cascade composites them as it samples (`Cascade._animatedDeclarations`,
// `addField`). WPT's `web-animations/animation-model/` holds the rest.
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
    `<div id="e"></div><script>console.log("out " + JSON.stringify((function () {
      var e = document.getElementById('e');
      var at = function (a, t) { a.pause(); a.currentTime = t; };
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('an effect that adds puts its values on the element’s own, and one under it', async () => {
  const out = await inPage(
    `e.style.marginLeft = '10px';
     var a = e.animate({ marginLeft: ['0px', '100px'] }, { duration: 100, composite: 'add' });
     at(a, 50);
     var alone = getComputedStyle(e).marginLeft;
     var b = e.animate({ marginLeft: ['0px', '100px'] }, 100);
     at(b, 50);
     var c = e.animate({ marginLeft: ['20px', '20px'] }, { duration: 100, composite: 'add' });
     at(c, 50);
     var stacked = getComputedStyle(e).marginLeft;
     return [alone, stacked, a.effect.composite, c.effect.composite];`,
  );
  // 10 under, 50 on top; and then 50 replaced it, with 20 added on top
  assert.deepEqual(out, ['60px', '70px', 'add', 'add']);
});

test('a transform added goes after the one under it, and a keyframe says its own composite', async () => {
  const out = await inPage(
    `e.style.transform = 'translateX(10px)';
     var a = e.animate([{ transform: 'translateY(20px)', composite: 'add' },
       { transform: 'translateY(20px)', composite: 'add' }], 100);
     at(a, 50);
     return getComputedStyle(e).transform;`,
  );
  assert.equal(out, 'matrix(1, 0, 0, 1, 10, 20)');
});

test("iterations that accumulate each add the last frame's value, and the mode can be changed", async () => {
  const out = await inPage(
    `var a = e.animate({ marginLeft: ['0px', '10px'] },
       { duration: 100, iterations: 3, iterationComposite: 'accumulate' });
     at(a, 250);
     var third = getComputedStyle(e).marginLeft;
     a.effect.iterationComposite = 'replace';
     var replaced = getComputedStyle(e).marginLeft;
     var threw = '';
     try { new KeyframeEffect(e, null, { composite: 'bogus' }); } catch (x) { threw = x.name; }
     return [third, replaced, threw];`,
  );
  assert.deepEqual(out, ['25px', '5px', 'TypeError']);
});

test('a grid line goes over at the half-way point, and replaces the one under it where it would add', async () => {
  const out = await inPage(
    `e.style.gridRow = '1';
     var a = e.animate({ gridRowStart: ['1', '5'] }, 100);
     at(a, 25);
     var early = getComputedStyle(e).gridRow;
     a.cancel();
     var b = e.animate({ gridRowStart: ['5', '5'] }, { duration: 100, composite: 'add' });
     at(b, 50);
     return [early, getComputedStyle(e).gridRow];`,
  );
  assert.deepEqual(out, ['1', '5']);
});
