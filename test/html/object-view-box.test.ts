// <Html> — what fits a replaced element's content into its box: the
// rectangle `object-view-box` takes out of it (CSS Images 5, 6.6), which is
// its natural size to layout and what `object-fit` and `object-position`
// place, and a view transition's images, whose content is their element's
// picture, fitted the same way and cut by their own `overflow` (CSS View
// Transitions 1, 3.2.4). WPT's `css/css-images/object-view-box-*` and the
// `object-fit`, `object-view-box` and `pseudo-element-overflow-*` tests in
// `css/css-view-transitions/` hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import {
  parseObjectViewBox,
  viewBoxIn,
} from '../../src/html/css/object-view-box.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  pixelsIn,
  render,
  scriptedPage,
  view,
} from './harness.js';
import type { PaintOp } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = nodeTest;
const scripted = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

const CHECK = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

test('a view box is read as a <basic-shape-rect>, and none of anything else', () => {
  assert.deepEqual(parseObjectViewBox('none', CHECK), null);
  assert.deepEqual(parseObjectViewBox('inset(10px 20%)', CHECK), {
    shape: 'inset',
    lengths: [10, { pct: 20 }, 10, { pct: 20 }],
  });
  assert.deepEqual(parseObjectViewBox('rect(auto 5px auto 10%)', CHECK), {
    shape: 'rect',
    lengths: ['auto', 5, 'auto', { pct: 10 }],
  });
  // its corners round nothing, and are taken
  assert.ok(parseObjectViewBox('xywh(1px 2px 3px 4px round 2px)', CHECK));
  for (const not of [
    'circle(10px)',
    'polygon(10px 20px 30px)',
    'path("M20,80 L50,20")',
    'xywh(1px 10%)',
    'xywh(0 0 -1px 4px)',
    'inset(auto)',
    'blah',
  ]) {
    assert.equal(parseObjectViewBox(not, CHECK), undefined, not);
  }
});

test('a view box is resolved in the natural size, and one of no area is none', () => {
  const box = (text: string) => parseObjectViewBox(text, CHECK)!;
  assert.deepEqual(viewBoxIn(box('inset(50px 0px 0px 25px)'), 50, 100), {
    x: 25,
    y: 50,
    width: 25,
    height: 50,
  });
  assert.deepEqual(viewBoxIn(box('rect(50px 50px 100px 25px)'), 50, 100), {
    x: 25,
    y: 50,
    width: 25,
    height: 50,
  });
  assert.deepEqual(viewBoxIn(box('xywh(50% 50% 50% 50%)'), 50, 100), {
    x: 25,
    y: 50,
    width: 25,
    height: 50,
  });
  // `auto` is the content's own edge
  assert.deepEqual(viewBoxIn(box('rect(auto auto auto auto)'), 50, 100), {
    x: 0,
    y: 0,
    width: 50,
    height: 100,
  });
  // nothing left, or less than nothing: no view box
  assert.equal(viewBoxIn(box('inset(50px 0px 50px 0px)'), 50, 100), null);
  assert.equal(viewBoxIn(box('inset(50px 0px 100px 0px)'), 50, 100), null);
});

test("a view box is a replaced element's natural size, to layout", async () => {
  // a canvas is the size its attributes give it, which no resource has to
  // arrive for: 100 by 50
  const { node } = await render(
    '<style>body{margin:0} canvas{display:block}</style>' +
      '<canvas id="a" width="100" height="50" style="object-view-box:inset(0 50px 0 0)"></canvas>' +
      '<canvas id="b" width="100" height="50" style="object-view-box:xywh(25% 0 50% 100%);width:100px"></canvas>' +
      '<canvas id="c" width="100" height="50" style="object-view-box:inset(0 0 50px 0)"></canvas>' +
      '<canvas id="d" width="100" height="50" style="object-view-box:rect(auto auto auto auto)"></canvas>' +
      '<canvas id="e" width="100" height="50" style="object-view-box:inset(0 50px 0 0);contain:size;contain-intrinsic-size:30px 20px"></canvas>',
  );
  const el = view(node);
  const size = (id: string) => {
    const b = boxOf(el, id);
    return [b.width, b.height];
  };
  assert.deepEqual(size('a'), [50, 50], 'the view box, 50 by 50');
  assert.deepEqual(size('b'), [100, 100], 'its ratio, 1, with a width');
  assert.deepEqual(size('c'), [100, 50], 'one of no area is none');
  assert.deepEqual(size('d'), [100, 50], 'all of it');
  assert.deepEqual(size('e'), [30, 20], 'size containment over it');
});

test('object-fit and object-position place the view box, and the rest of the image around it', async () => {
  // WPT's object-view-box-fit-* cases: an image 50 by 100 whose bottom half
  // is the view box
  const { node } = await render(
    '<style>body{margin:0} img{display:block;object-view-box:inset(50px 0 0 0)}</style>' +
      '<img id="i0" src="a.png" style="width:50px;height:100px;object-fit:contain">' +
      '<img id="i1" src="a.png" style="width:50px;height:100px;object-fit:contain;object-position:0 0">' +
      '<img id="i2" src="a.png" style="width:100px;height:200px;object-fit:contain;object-position:25px 125px">' +
      '<img id="i3" src="a.png" style="width:40px;height:50px;object-fit:cover">' +
      '<img id="i4" src="a.png" style="width:50px;height:100px;object-fit:fill">',
  );
  const el = view(node);
  for (let i = 0; i < 5; i += 1) {
    (boxOf(el, `i${i}`) as unknown as { intrinsic: unknown }).intrinsic = {
      width: 50,
      height: 100,
      missing: 0,
      ratio: 0.5,
    };
  }
  const tops = [0, 100, 200, 400, 450];
  const ops: PaintOp[] = [];
  await fillsOf(el, ops, { imageFor: () => ({}) });
  const drawn = ops.filter((op) => op.op === 'image');
  const at = (i: number) => {
    const op = drawn[i];
    return op.op === 'image' ? [op.x, op.y - tops[i], op.w, op.h] : [];
  };
  // contained, 50 by 50 in the middle of 50 by 100: the half above the
  // view box shows above it, in the box
  assert.deepEqual(at(0), [0, -25, 50, 100], 'contain');
  assert.deepEqual(at(1), [0, -50, 50, 100], 'contain, from the top');
  // 100 by 100 at (25, 125): twice its size
  assert.deepEqual(at(2), [25, 25, 100, 200], 'contain, placed by lengths');
  assert.deepEqual(at(3), [-5, -50, 50, 100], 'cover');
  assert.deepEqual(at(4), [0, -100, 50, 200], 'fill');
  // and each is cut to its content box, as an image is
  assert.equal(ops.filter((op) => op.op === 'clip').length, 5);
});

scripted(
  'object-view-box reads back as written, and runs between two of one kind',
  async () => {
    const page = await scriptedPage(
      `<img id="i" style="object-view-box: xywh(1px 10% 100px 50%)">
     <img id="j" style="object-view-box: inset(10px 10px)">
     <img id="k">
     <script>
       var i = document.getElementById('i');
       var j = document.getElementById('j');
       var k = document.getElementById('k');
       var before = i.style.objectViewBox;
       i.style.objectViewBox = 'circle(10px)';
       var run = k.animate(
         [{ objectViewBox: 'inset(0px)' }, { objectViewBox: 'inset(20px)' }],
         { duration: 1000 });
       run.pause();
       run.currentTime = 500;
       console.log('read ' + JSON.stringify([
         before,
         i.style.objectViewBox,
         getComputedStyle(i).objectViewBox,
         getComputedStyle(j).objectViewBox,
         getComputedStyle(document.body).objectViewBox,
         getComputedStyle(k).objectViewBox,
       ]));
     </script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('read')), [
      'xywh(1px 10% 100px 50%)',
      'xywh(1px 10% 100px 50%)',
      'xywh(1px 10% 100px 50%)',
      'inset(10px)',
      'none',
      'inset(10px)',
    ]);
    page.result.unmount();
  },
);

/** The colour at a window point, as `#rrggbb`, once a few frames are in. */
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

/** A page whose element `#t`, 60 by 60 and green, is shown by its new
 *  image in a group 30 by 30 at the window's corner, styled by `image`. */
function fitPage(image: string): string {
  return `<style>
       html { view-transition-name: none; background: #ffffff }
       #t { position: absolute; top: 0; left: 0; width: 60px; height: 60px;
            background: #00ff00; view-transition-name: t }
       #keep { position: absolute; top: 100px; left: 190px; width: 4px;
               height: 4px; view-transition-name: keep }
       ::view-transition-group(keep) { animation-duration: 300s }
       ::view-transition-group(t) { animation: unset; transform: unset;
         position: absolute; top: 0; left: 0; width: 30px; height: 30px }
       ::view-transition-old(t) { animation: unset; opacity: 0 }
       ::view-transition-new(t) { animation: unset; opacity: 1; ${image} }
     </style>
     <div id="t"></div><div id="keep"></div>
     <script>
       onload = function () {
         document.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () { console.log('ready'); });
         });
       };
     </script>`;
}

scripted(
  "a transition's image at object-fit: none draws its element at its own size, past its box",
  async () => {
    const page = await scriptedPage(
      fitPage('object-fit: none; object-position: 0 0'),
    );
    await page.until('ready');
    // stretched to 30 by 30, (45, 45) was the page behind the transition
    assert.equal(await colourAt(page, 45, 45), '#00ff00');
    page.result.unmount();
  },
);

scripted(
  "a transition's image is cut by its own overflow, what its element drew past its border box with it",
  async () => {
    // #t is 40 by 40 and green, and draws a blue square past its right
    // edge; its old image shows all of it, its new image is cut
    const page = await scriptedPage(
      `<style>
       html { view-transition-name: none; background: #ffffff }
       #t { position: absolute; top: 0; left: 0; width: 40px; height: 40px;
            background: #00ff00; view-transition-name: t }
       #o { position: relative; left: 40px; width: 40px; height: 40px;
            background: #0000ff }
       #keep { position: absolute; top: 100px; left: 190px; width: 4px;
               height: 4px; view-transition-name: keep }
       ::view-transition-group(keep) { animation-duration: 300s }
       ::view-transition-group(t) { animation: unset; transform: unset;
         position: absolute; top: 0; left: 0 }
       ::view-transition-old(t) { animation: unset; opacity: 1; top: 50px }
       ::view-transition-new(t) { animation: unset; opacity: 1;
         overflow: hidden }
     </style>
     <div id="t"><div id="o"></div></div><div id="keep"></div>
     <script>
       onload = function () {
         document.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () { console.log('ready'); });
         });
       };
     </script>`,
    );
    await page.until('ready');
    assert.equal(await colourAt(page, 20, 20), '#00ff00', 'new, in its box');
    assert.equal(await colourAt(page, 60, 20), '#ffffff', 'new, cut past it');
    assert.equal(await colourAt(page, 60, 70), '#0000ff', 'old, not cut');
    page.result.unmount();
  },
);

scripted(
  "a transition's image fits its object-view-box to its box, and draws the rest around it",
  async () => {
    const page = await scriptedPage(
      `<style>
       html { view-transition-name: none }
       #v { position: absolute; top: 0; left: 0; display: flex;
            view-transition-name: v }
       #v i, #v b { display: block; width: 40px; height: 40px }
       #v i { background: #ff0000 }
       #v b { background: #0000ff }
       #keep { position: absolute; top: 100px; left: 190px; width: 4px;
               height: 4px; view-transition-name: keep }
       ::view-transition-group(keep) { animation-duration: 300s }
       ::view-transition-group(v) { animation: unset; transform: unset;
         position: absolute; top: 0; left: 0 }
       ::view-transition-old(v) { animation: unset; opacity: 0 }
       ::view-transition-new(v) { animation: unset; opacity: 1;
         object-view-box: inset(0 40px 0 0) }
     </style>
     <div id="v"><i></i><b></b></div><div id="keep"></div>
     <script>
       onload = function () {
         document.startViewTransition().ready.then(function () {
           requestAnimationFrame(function () { console.log('ready'); });
         });
       };
     </script>`,
    );
    await page.until('ready');
    // the red half, 40 by 40, stretched over the 80 by 40 box; the blue half
    // after it, past the box, as the image's overflow shows it
    assert.equal(await colourAt(page, 60, 20), '#ff0000');
    assert.equal(await colourAt(page, 120, 20), '#0000ff');
    page.result.unmount();
  },
);
