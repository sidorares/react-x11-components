// <Html scripts>' view transitions, in the order they paint and to the
// pointer: the groups come in the order the document paints the elements
// they capture (CSS View Transitions 1, 7.4), a scope's `::view-transition`
// is drawn over all its scope holds (CSS View Transitions 2, 4), and a
// point over a captured element is whatever is behind it, or the
// transition's pseudo-element over it. WPT's `css/css-view-transitions/`
// `css-tags-paint-order*`, `scoped/paint-order` and the `hit-test*` tests
// hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, pixelsIn, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

/** The colour at a window point, as `#rrggbb`. */
async function colourAt(
  page: Awaited<ReturnType<typeof scriptedPage>>,
  x: number,
  y: number,
): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  const d = await pixelsIn(page.result.ctx, { x, y, width: 1, height: 1 });
  return (
    '#' +
    [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}

test("a positioned element's group is drawn over those of the elements after it", async () => {
  const page = await scriptedPage(
    `<style>
       html { view-transition-name: none }
       div { width: 40px; height: 40px }
       #one { background: #00ff00; position: relative; z-index: 1; view-transition-name: one }
       #two { background: #0000ff; view-transition-name: two }
       #keep { width: 4px; height: 4px; view-transition-name: keep }
       ::view-transition-group(keep) { animation-duration: 300s }
       ::view-transition-group(one), ::view-transition-group(two) {
         animation: unset; transform: unset; position: absolute }
       ::view-transition-group(one) { top: 10px; left: 10px }
       ::view-transition-group(two) { top: 20px; left: 20px }
       ::view-transition-new(one), ::view-transition-new(two) { animation: unset; opacity: 0 }
       ::view-transition-old(one), ::view-transition-old(two) { animation: unset; opacity: 1 }
     </style>
     <div id="one"></div><div id="two"></div><div id="keep"></div>
     <script>
       onload = function () {
         document.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () { console.log('ready'); });
         });
       };
     </script>`,
  );
  await page.until('ready');
  // where the two groups overlap, #one's: painted after #two for its
  // z-index, though it is first in the tree
  assert.equal(await colourAt(page, 30, 30), '#00ff00');
  page.result.unmount();
});

test("a scope's ::view-transition is drawn over what in the scope has a z-index", async () => {
  const page = await scriptedPage(
    `<style>
       #scope { position: relative; width: 120px; height: 80px; contain: strict;
                background: #ffffff }
       #part { position: absolute; top: 0; left: 0; width: 40px; height: 40px;
               background: #00ff00; z-index: 1; view-transition-name: part }
       #high { position: absolute; top: 20px; left: 20px; width: 40px; height: 40px;
               background: #ff0000; z-index: 2 }
       #scope::view-transition-group(*) { animation-play-state: paused }
       #scope::view-transition-old(*) { animation: unset; opacity: 0 }
       #scope::view-transition-new(*) { animation: unset; opacity: 1;
         transform: translate(30px, 30px) }
     </style>
     <div id="scope"><div id="part"></div><div id="high"></div></div>
     <script>
       onload = function () {
         var scope = document.getElementById('scope');
         scope.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () { console.log('ready'); });
         });
       };
     </script>`,
  );
  await page.until('ready');
  // #part's new image, moved to (30, 30), over #high, which is under the
  // scope's ::view-transition for all its z-index
  assert.equal(await colourAt(page, 45, 45), '#00ff00');
  page.result.unmount();
});

test('a point over a captured element is what is behind it, or the transition over it', async () => {
  const page = await scriptedPage(
    `<style>
       html { view-transition-name: none }
       #target { width: 50px; height: 50px; background: #00ff00; position: relative;
                 z-index: 1; view-transition-name: shared }
       #below { width: 50px; height: 50px; background: #0000ff; position: relative;
                top: -25px }
       ::view-transition { pointer-events: none }
       ::view-transition-group(*) { animation-play-state: paused }
       ::view-transition-group(shared) { pointer-events: auto; animation: unset;
         transform: translate(100px, 0) }
     </style>
     <div id="target"></div><div id="below"></div>
     <script>
       onload = function () {
         document.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () {
             var name = function (el) { return el ? (el.id || el.localName) : null; };
             console.log('hits ' + JSON.stringify([
               name(document.elementFromPoint(10, 10)),
               name(document.elementFromPoint(10, 40)),
               name(document.elementFromPoint(110, 10)),
             ]));
           });
         });
       };
     </script>`,
  );
  // #target's own box is a hole while its group draws it: over its top is
  // the body, over where #below overlaps it #below, and over the group the
  // group's originating element, the root
  assert.deepEqual(JSON.parse(await page.until('hits')), [
    'body',
    'below',
    'html',
  ]);
  page.result.unmount();
});
