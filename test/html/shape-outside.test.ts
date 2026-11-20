// `shape-outside`, `shape-margin` and `shape-image-threshold`, and the basic
// shapes `clip-path` takes (src/html/css/shape-outside.ts): as `el.style`
// keeps them, in canonical form or not at all, and as `getComputedStyle`
// reads them; and the float area they make (src/html/layout/float-shape.ts),
// which the lines beside a float go around. WPT's `css/css-shapes/` holds
// the rest; what each case expects is what Chromium answers.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { createElement as h } from 'react';
import { cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { shapeOutsideSpecified } from '../../src/html/css/shape-outside.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, metric, render, scriptedPage, view } from './harness.js';

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

// --- the float area --------------------------------------------------------

/** Where each inline-block of a document is, by the order it comes in: the
 *  lines it is on are what the floats left of them. */
function blocksOf(node: unknown): { x: number; y: number }[] {
  type B = {
    x: number;
    y: number;
    style: { display: string };
    children: B[];
  };
  const out: { x: number; y: number }[] = [];
  const walk = (b: B): void => {
    if (b.style.display === 'inline-block') {
      out.push({ x: Math.round(b.x), y: Math.round(b.y) });
    }
    b.children.forEach(walk);
  };
  walk((view(node as never) as unknown as { _tree: { root: B } })._tree.root);
  return out;
}

/** A float `.s` 160px square with 40px boxes of these heights beside it, a
 *  line each, and where they are. */
async function beside(
  shape: string,
  heights: number[],
  more = '',
): Promise<{ x: number; y: number }[]> {
  const { node } = await render(
    `<style>body{margin:0}.c{width:200px;line-height:0;${more}}` +
      `.s{float:left;width:160px;height:160px;${shape}}` +
      '.b{display:inline-block;width:40px}</style><div class="c">' +
      '<div class="s"></div>' +
      heights
        .map((h) => `<div class="b" style="height:${h}px"></div>`)
        .join('<br>') +
      '</div>',
    300,
  );
  return blocksOf(node);
}

metric(
  "a line goes around a circle's far side over all of its band",
  async () => {
    // a circle of radius 80 in the float's box: a line is as far over as
    // the circle reaches beside it, at the edge of the line nearer the
    // middle
    const boxes = await beside('shape-outside:circle(80px)', [40, 24, 24, 72]);
    const reach = (y0: number, y1: number): number => {
      const dy = Math.min(Math.abs(y0 - 80), Math.abs(y1 - 80));
      return y0 <= 80 && y1 >= 80 ? 160 : 80 + Math.sqrt(80 * 80 - dy * dy);
    };
    assert.deepEqual(
      boxes.map((b) => b.y),
      [0, 40, 64, 88],
    );
    assert.equal(boxes[0].x, Math.round(reach(0, 40)));
    assert.equal(boxes[1].x, Math.round(reach(40, 64)));
    // a line across the middle goes past all of it
    assert.equal(boxes[2].x, 160);
    assert.equal(boxes[3].x, Math.round(reach(88, 160)));
  },
);

metric('a line past the bottom of a shape has the whole width', async () => {
  // the area is the top half of the float's box: the box beside its
  // bottom half stands at the line's start
  const boxes = await beside('shape-outside:inset(0 0 50% 0)', [80, 20]);
  assert.deepEqual(boxes, [
    { x: 160, y: 0 },
    { x: 0, y: 80 },
  ]);
});

metric(
  'an area that is empty leaves the lines beside the float whole',
  async () => {
    const boxes = await beside('shape-outside:inset(50%)', [20, 20]);
    assert.deepEqual(boxes, [
      { x: 0, y: 0 },
      { x: 0, y: 20 },
    ]);
  },
);

metric(
  'a box named alone is rounded as the border radius rounds it',
  async () => {
    // the border box of a circle drawn by `border-radius: 50%`, its margin
    // box 20px out, as a box shadow's spread is
    const { node } = await render(
      '<style>body{margin:0}.c{width:200px;line-height:0}' +
        '.s{float:left;shape-outside:border-box;border-radius:50%;height:40px;' +
        'width:40px;padding:20px;border:20px solid green;margin:20px}' +
        '.b{display:inline-block;width:60px}.l{display:inline-block;' +
        'width:200px;height:20px}</style><main class="c"><div class="s"></div>' +
        '<div class="l"></div> <div class="b" style="height:24px"></div> ' +
        '<div class="b" style="height:36px"></div> ' +
        '<div class="b" style="height:36px"></div> ' +
        '<div class="b" style="height:24px"></div> <div class="l"></div></main>',
      300,
    );
    // the space after each box, which hung, moved none of them
    assert.deepEqual(
      blocksOf(node).map((b) => b.x),
      [0, 128, 140, 140, 128, 0],
    );
  },
);

metric('and so it is from the right, read right to left', async () => {
  const { node } = await render(
    '<style>body{margin:0}.c{width:200px;line-height:0;direction:rtl}' +
      '.s{float:right;shape-outside:border-box;border-radius:50%;height:40px;' +
      'width:40px;padding:20px;border:20px solid green;margin:20px}' +
      '.b{display:inline-block;width:60px}.l{display:inline-block;' +
      'width:200px;height:20px}</style><main class="c"><div class="s"></div>' +
      '<div class="l"></div> <div class="b" style="height:24px"></div> ' +
      '<div class="b" style="height:36px"></div> ' +
      '<div class="b" style="height:36px"></div> ' +
      '<div class="b" style="height:24px"></div> <div class="l"></div></main>',
    300,
  );
  // the space a right-to-left line ends on hangs past its left edge
  assert.deepEqual(
    blocksOf(node).map((b) => b.x),
    [0, 12, 0, 0, 12, 0],
  );
});

metric(
  'a polygon whose halves turn opposite ways is still an area',
  async () => {
    // a bow tie's signed area comes to none; it fills both halves
    const boxes = await beside(
      'shape-outside:polygon(0 0, 80px 80px, 0 160px, 80px 160px, 0 80px, 80px 0)',
      [20],
    );
    assert.ok(boxes[0].x > 0, `beside the polygon, at ${boxes[0].x}`);
  },
);

metric('shape-margin grows the area by its length', async () => {
  const boxes = await beside(
    'shape-outside:inset(0 100px 0 0);shape-margin:20px',
    [20],
  );
  assert.equal(boxes[0].x, 80);
});

metric(
  "a gradient's area is where its alpha is over the threshold",
  async () => {
    // opaque over its top quarter, less than half opaque below that: at 0 the
    // whole box, and at a threshold of a half the top quarter alone
    const shape =
      'shape-outside:linear-gradient(to bottom, green 25%, rgba(0,128,0,0.4) 25%);';
    assert.deepEqual(
      (await beside(shape, [20, 20, 20])).map((b) => b.x),
      [160, 160, 160],
    );
    assert.deepEqual(
      (await beside(shape + 'shape-image-threshold:0.5', [40, 20, 20])).map(
        (b) => b.x,
      ),
      [160, 0, 0],
    );
  },
);

metric("an image's area is its opaque pixels, once they are in", async () => {
  // an SVG image, whose area is what it fills: its left half
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<path fill="green" d="M0 0 H50 V100 H0 Z"/></svg>',
  );
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}.b{display:inline-block;width:40px;height:20px}' +
          '</style><div style="width:200px;line-height:0">' +
          '<div style="float:left;width:100px;height:100px;' +
          'shape-outside:url(a.svg)"></div><div class="b"></div></div>',
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { kind: string }) =>
          r.kind === 'image' ? { kind: 'image' as const, bytes: svg } : null,
      }),
    ),
    { width: 340, height: 200, fonts: FONTS! },
  );
  const node = result.getByTestName('doc');
  for (let i = 0; i < 50 && blocksOf(node)[0]?.x !== 50; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(blocksOf(node)[0].x, 50);
});

nodeTest(
  'inset() reads its radii with a slash that has no space around it',
  () => {
    assert.equal(
      shapeOutsideSpecified('inset(10px round 0 40px/ 0 60px) border-box'),
      'inset(10px round 0px 40px / 0px 60px) border-box',
    );
    assert.equal(
      shapeOutsideSpecified('inset(10px round 0 40px/0 60px)'),
      'inset(10px round 0px 40px / 0px 60px)',
    );
  },
);
