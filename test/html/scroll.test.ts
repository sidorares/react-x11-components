// <Html> — scroll containers inside a document (`layout/scroll.ts`): a box
// whose `overflow` scrolls moves what it holds by its offset, under the
// wheel and the handle, and everything that reads a box finds it there.
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_PAGE_DOWN,
  XK_SPACE,
} from 'react-x11/keysyms';
import type { DrawnNode } from 'react-x11';

import { Html } from '../../src/html/index.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import { Cascade } from '../../src/html/css/cascade.js';
import { extentWalked } from '../../src/html/layout/scroll.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  findById,
  h,
  metric,
  renderScrolled,
  view,
} from './harness.js';

afterEach(cleanup);

const ROWS = Array.from(
  { length: 10 },
  (_, i) =>
    `<div id="r${i}" class="row" style="background:${i % 2 ? '#0000ff' : '#ff0000'}"></div>`,
).join('');

/** A page with a list 100px tall of ten rows 40px tall, scrolling, under
 *  a header and over a footer, in a pane 300px tall. */
const LIST =
  '<style>body{margin:0}#head{height:20px;background:#00ff00}' +
  '#s{height:100px;overflow-y:auto;background:#ffffff}.row{height:40px}' +
  '#foot{height:20px;background:#ff00ff}</style>' +
  `<div id="head"></div><div id="s">${ROWS}</div><div id="foot"></div>`;

const el = (node: HtmlViewNode, id: string) => findById(node.document, id)!;

/** The pane around the document: what scrolls it. */
function paneOf(node: HtmlViewNode): { scrollY: number } {
  type Up = { parent: Up | null; props?: { style?: { overflow?: string } } };
  let at = (node as unknown as Up).parent;
  while (at && at.props?.style?.overflow !== 'scroll') at = at.parent;
  assert.ok(at, 'a pane');
  return at as unknown as { scrollY: number };
}

/** A turn of the wheel at a point in the document, in notches down. */
async function wheel(node: HtmlViewNode, x: number, y: number, notches = 1) {
  const dx = x - node.abs.width / 2;
  const dy = y - node.abs.height / 2;
  await act(async () =>
    fireEvent.wheel(node as unknown as DrawnNode, {
      dx,
      dy,
      deltaY: notches,
    }),
  );
}

test('the wheel over a scroll container scrolls what it holds, and the page around it stays', async () => {
  const { el: node } = await renderScrolled(LIST, 300);
  const list = el(node, 's');
  assert.deepEqual(node.scrollStateOf(list), {
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    clientWidth: 400,
    clientHeight: 100,
    clientTop: 0,
    clientLeft: 0,
  });
  await wheel(node, 50, 50);
  // a notch is 48px (core's `WHEEL_NOTCH_PX`)
  assert.equal(node.scrollStateOf(list)?.y, 48);
  assert.equal(boxOf(node, 'r0').y, 20 - 48, 'the rows moved up');
  assert.equal(boxOf(node, 'r2').y, 20 + 80 - 48);
  assert.equal(boxOf(node, 's').y, 20, 'and the list did not');
  assert.equal(boxOf(node, 'foot').y, 120, 'nor what is after it');
  assert.equal(paneOf(node).scrollY, 0, 'nor the pane');
  // what is under a point is what is drawn there now
  assert.equal(node.elementAtPoint(50, 25)?.attribs.id, 'r1');
  assert.equal(
    node.elementAtPoint(50, 5)?.attribs.id,
    'head',
    'a row scrolled out above the list is no part of the header',
  );
  // and the rect a script reads
  assert.deepEqual(node.elementRect(el(node, 'r2')), {
    x: 0,
    y: 52,
    width: 400,
    height: 40,
  });
});

metric(
  'a scroll container draws what it holds where it is scrolled to, cut to its scrollport',
  async () => {
    const { el: node, result } = await renderScrolled(LIST, 300);
    await expectPixel(result.ctx, 10, 30, '#ff0000', {
      message: 'r0 at first',
    });
    node.scrollElementTo(el(node, 's'), { y: 40 });
    await act();
    await expectPixel(result.ctx, 10, 30, '#0000ff', {
      message: 'r1 at the top',
    });
    await expectPixel(result.ctx, 10, 10, '#00ff00', {
      message: 'the header, with nothing scrolled over it',
    });
    await expectPixel(result.ctx, 10, 125, '#ff00ff', {
      message: 'and the footer',
    });
  },
);

test('the wheel goes on to the pane around the document where the scroll container can go no further', async () => {
  const tall =
    LIST.replace('#foot{height:20px', '#foot{height:600px') + '<p>after</p>';
  const { el: node } = await renderScrolled(tall, 300);
  const list = el(node, 's');
  node.scrollElementTo(list, { y: 1000 });
  await act();
  assert.equal(node.scrollStateOf(list)?.y, 300, 'kept within its reach');
  await wheel(node, 50, 50);
  assert.equal(node.scrollStateOf(list)?.y, 300);
  assert.ok(paneOf(node).scrollY > 0, 'the pane scrolled instead');
  // and up again, the list takes it
  await wheel(node, 50, 50 + paneOf(node).scrollY, -1);
  assert.equal(node.scrollStateOf(list)?.y, 300 - 48);
});

test('a document wider than its window scrolls the pane around it across, as far as its scrollable overflow reaches, and a fixed box stays', async () => {
  // CSS Overflow 3, 2.2: the viewport's scrollable overflow is the root's
  // and what it holds; the element stays its window's width, and a box of
  // no size where the overflow ends is what core's pane scrolls to
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#wide{width:1000px;height:10px;margin-left:30px}' +
      '#fixed{position:fixed;left:1500px;top:0;width:10px;height:10px}' +
      '#off{position:absolute;left:-500px;width:10px;height:10px}</style>' +
      '<div id="wide"></div><div id="fixed"></div><div id="off"></div>',
    300,
  );
  await act();
  type Pane = {
    contentWidth: number;
    scrollX: number;
    scrollTo(to: { x: number }): void;
  };
  const pane = paneOf(node) as unknown as Pane;
  // to the wide block's right edge: the fixed box scrolls with nothing, and
  // what spills past the left is out of reach
  assert.equal(node.documentSize().width, 1030);
  assert.equal(node.abs.width, 400, 'the element stays its window wide');
  assert.equal(pane.contentWidth, 1030, 'the pane reaches the end');
  await act(() => pane.scrollTo({ x: 200 }));
  assert.equal(pane.scrollX, 200);
  // and a page as narrow as its window reaches nowhere past it
  const { el: narrow } = await renderScrolled('<p>x</p>', 300);
  assert.equal(narrow.documentSize().width, 400);
  assert.equal((paneOf(narrow) as unknown as Pane).contentWidth, 400);
});

metric(
  'what a document wider than its window draws past the element is painted once the pane scrolls across to it',
  async () => {
    // core culls a node by its box and its `paintOverhang`, and the element
    // is its window wide however far the document reaches: red 600px in,
    // past the element's 400, is drawn at 100 once the pane is 500 across
    const { el: node, result } = await renderScrolled(
      '<style>body{margin:0}#s{width:3000px;height:10px}' +
        '#r{position:absolute;left:600px;top:0;width:100px;height:50px;' +
        'background:#ff0000}</style><div id="s"></div><div id="r"></div>',
      300,
    );
    await act();
    type Pane = { scrollTo(to: { x: number }): void };
    const pane = paneOf(node) as unknown as Pane;
    await act(() => pane.scrollTo({ x: 500 }));
    await act();
    await expectPixel(result.ctx, 150, 5, '#ff0000', {
      message: 'the block past the element, scrolled in',
    });
    await expectPixel(result.ctx, 50, 5, '#ffffff', {
      message: 'and the canvas before it',
    });
  },
);

metric(
  'a vertical-rl document, its root box an anonymous one around the frame the root element turns, starts the pane at its scroll origin, at its right',
  async () => {
    // the principal writing mode is the root element's, under the anonymous
    // box that stands for the viewport (CSS Writing Modes 4, 8)
    const { el: node } = await renderScrolled(
      '<html style="writing-mode: vertical-rl"><style>body{margin:0}' +
        '#wide{width:1000px;height:10px;background:#0000ff}</style>' +
        '<div id="wide"></div></html>',
      300,
    );
    await act();
    await act();
    const pane = paneOf(node) as unknown as { scrollX: number };
    assert.ok(node.scrollOriginX() > 0, 'what spills past the left scrolls');
    assert.equal(pane.scrollX, node.scrollOriginX(), 'started at the origin');
  },
);

metric(
  'a vertical-rl rtl document starts the pane at its scroll origin, at its bottom',
  async () => {
    // CSS Overflow 3, 2.3: the viewport's scroll origin is at its block
    // start and inline start; a vertical-rl line under rtl runs upwards, so
    // what spills does so past the top, and the pane starts at the bottom
    const { el: node } = await renderScrolled(
      '<html dir="rtl" style="writing-mode: vertical-rl"><style>body{margin:0}' +
        '#tall{width:10px;height:1000px;background:#0000ff}</style>' +
        '<div id="tall"></div></html>',
      300,
    );
    await act();
    await act();
    const pane = paneOf(node) as unknown as { scrollY: number };
    assert.ok(node.scrollOriginY() > 0, 'what spills past the top scrolls');
    assert.equal(pane.scrollY, node.scrollOriginY(), 'started at the origin');
  },
);

metric(
  'an rtl document that spills past its left starts the pane at its scroll origin, at its right, and scrolls left into the spill',
  async () => {
    // CSS Overflow 3, 2.3: the viewport's scroll origin is at its right in
    // an rtl document, and what spills past its left scrolls; the document
    // is drawn that far in, and the pane starts there
    const { el: node, result } = await renderScrolled(
      '<html dir="rtl"><style>body{margin:0}' +
        '#wide{width:1000px;height:10px;background:#0000ff}' +
        '#red{width:50px;height:20px;background:#ff0000}</style>' +
        '<div id="red"></div><div id="wide"></div></html>',
      300,
    );
    await act();
    await act();
    type Pane = { scrollX: number; scrollTo(to: { x: number }): void };
    const pane = paneOf(node) as unknown as Pane;
    // 1000px from the right of a 400px window spills 600 past its left
    assert.equal(node.documentSize().width, 1000);
    assert.equal(node.scrollOriginX(), 600);
    assert.equal(pane.scrollX, 600, 'started at the origin');
    await expectPixel(result.ctx, 390, 5, '#ff0000', {
      message: 'the right edge in view, where the red block starts',
    });
    await act(() => pane.scrollTo({ x: 0 }));
    await act();
    await expectPixel(result.ctx, 5, 25, '#0000ff', {
      message: 'and the spill past the left, scrolled to',
    });
  },
);

test('a scroll container keeps where it is scrolled to through a layout at another width and a restyle', async () => {
  const { el: node, resize } = await renderScrolled(LIST, 300);
  const list = el(node, 's');
  node.scrollElementTo(list, { y: 100 });
  await act();
  assert.equal(boxOf(node, 'r0').y, 20 - 100);
  await resize(300, 300);
  assert.equal(node.scrollStateOf(list)?.y, 100);
  assert.equal(
    boxOf(node, 'r0').y,
    20 - 100,
    'the rows laid out again where it is scrolled to',
  );
  assert.equal(boxOf(node, 'r0').width, 300);
  // a build of the boxes too
  await act(async () => {
    el(node, 'r9').attribs.style += ';height:80px';
    node.touchDocument(null);
  });
  await act();
  assert.equal(node.scrollStateOf(list)?.height, 440);
  assert.equal(boxOf(node, 'r0').y, 20 - 100);
});

test('a snap container comes to rest where an area lines up, and follows it through a layout', async () => {
  // CSS Scroll Snap 1, 5.2 and 5.4: `mandatory` snaps to the nearest place
  // an area lines up at, and a layout that moves the area the container
  // was snapped to scrolls the container with it; `proximity` snaps only
  // within a third of the snapport
  const { el: node } = await renderScrolled(
    LIST.replace(
      '#s{height:100px;overflow-y:auto;',
      '#s{height:100px;overflow-y:auto;scroll-snap-type:y mandatory;',
    ).replace('.row{height:40px}', '.row{height:40px;scroll-snap-align:start}'),
    300,
  );
  const list = el(node, 's');
  assert.deepEqual(node.scrollElementTo(list, { y: 50 }), { x: 0, y: 40 });
  await act(async () => {
    el(node, 'r0').attribs.style = 'height:60px';
    node.touchDocument(null);
  });
  await act();
  assert.equal(node.scrollStateOf(list)?.y, 60, 'it follows r1');
  const { el: near } = await renderScrolled(
    LIST.replace(
      '#s{height:100px;overflow-y:auto;',
      '#s{height:100px;overflow-y:auto;scroll-snap-type:y;',
    ).replace(
      '.row{height:40px}',
      '.row{height:200px;scroll-snap-align:start}',
    ),
    300,
  );
  const far = el(near, 's');
  assert.equal(
    near.scrollElementTo(far, { y: 100 })?.y,
    100,
    'too far to snap',
  );
  assert.equal(near.scrollElementTo(far, { y: 180 })?.y, 200, 'near enough');
});

test('a scroll container is first scrolled to its scroll-initial-target, lined up as its scroll-snap-align says, until something else scrolls it', async () => {
  // CSS Scroll Snap 2, 3.1: the container's initial scroll position brings
  // the first target whose nearest scroll container it is into view, at
  // its start where its scroll-snap-align is none; a layout that lines it
  // up otherwise takes the container with it, until a script scrolls it
  const { el: node } = await renderScrolled(
    '<style>#s{position:absolute;width:300px;height:300px;overflow:scroll}' +
      '#space{width:1000px;height:1000px}' +
      '.b{position:absolute;width:200px;height:200px}' +
      '#t{top:200px;left:200px;scroll-initial-target:nearest}</style>' +
      '<div id="s"><div id="space"></div><div class="b" id="t"></div></div>',
    600,
  );
  const s = el(node, 's');
  const at = () => {
    const state = node.scrollStateOf(s);
    return [state?.x, state?.y];
  };
  assert.deepEqual(at(), [200, 200], 'at its start');
  await act(async () => {
    el(node, 't').attribs.style = 'scroll-snap-align:center';
    node.touchDocument(null);
  });
  await act();
  assert.deepEqual(at(), [150, 150], 'centred');
  node.scrollElementTo(s, { x: 0, y: 0 });
  await act(async () => {
    el(node, 't').attribs.style = 'scroll-snap-align:end';
    node.touchDocument(null);
  });
  await act();
  assert.deepEqual(at(), [0, 0], 'a script scrolled it');
});

test('a snap on both axes rests at the nearest pair of places that shows both areas, a scroll stops short of an always area it would show, and an area of no width shows at the edge', async () => {
  // CSS Scroll Snap 1, "scoping valid snap positions to visible boxes" and
  // scroll-snap-stop (WPT snap-to-combination-of-two-elements-2,
  // scroll-snap-stop-002-nested, snap-to-visible-areas-unreachable)
  const { el: node } = await renderScrolled(
    '<style>#b div, #st div, #z div { position: absolute }' +
      '#b { position: relative; width: 600px; height: 600px; overflow: hidden; scroll-snap-type: both mandatory }' +
      '#b .space { width: 2000px; height: 2000px }' +
      '#lt { left: 200px; top: 200px; width: 450px; height: 450px; scroll-snap-align: start start }' +
      '#rb { left: 600px; top: 800px; width: 50px; height: 50px; scroll-snap-align: end end }' +
      '#st { position: relative; width: 400px; height: 100px; overflow: scroll; scroll-snap-type: x mandatory }' +
      '#st .space { width: 2100px; height: 50px }' +
      '#st .t { top: 0; height: 50px; width: 50px; scroll-snap-align: start }' +
      '#z { position: relative; width: 300px; height: 300px; overflow: scroll; scroll-snap-type: y mandatory }' +
      '#z .space { width: 600px; height: 1200px }' +
      '#z .t { width: 100px; height: 100px; scroll-snap-align: start }</style>' +
      '<div id="b"><div class="space"></div><div id="lt"></div><div id="rb"></div></div>' +
      '<div id="st"><div class="space"></div><div class="t" style="left: 0"></div>' +
      '<div class="t" style="left: 400px; width: 900px"></div>' +
      '<div class="t" style="left: 900px; scroll-snap-stop: always"></div></div>' +
      '<div id="z"><div class="space"></div><div class="t" style="left: 600px; top: 0; width: 0"></div>' +
      '<div class="t" style="left: 400px; top: 600px"></div></div>',
    600,
    800,
  );
  const both = el(node, 'b');
  assert.deepEqual(node.scrollElementTo(both, { x: 100, y: 150 }), {
    x: 200,
    y: 200,
  });
  assert.deepEqual(node.scrollElementTo(both, { x: 0, y: 0 }), {
    x: 50,
    y: 250,
  });
  const stop = el(node, 'st');
  assert.equal(
    node.scrollElementTo(stop, { x: 600 }, true)?.x,
    500,
    'short of it',
  );
  node.scrollElementTo(stop, { x: 0 });
  assert.equal(node.scrollElementTo(stop, { x: 800 }, true)?.x, 900, 'at it');
  const zero = el(node, 'z');
  node.scrollElementTo(zero, { x: 300, y: 0 });
  assert.equal(
    node.scrollElementTo(zero, { x: 300, y: 280 })?.y,
    0,
    'at the edge',
  );
});

test('an absolute box at its static position in a vertical-lr scroll container starts at its left', async () => {
  // a vertical-lr flow is laid out as vertical-rl and put back across;
  // what is out of the flow goes back by its own size once it is laid out.
  // And the viewport's axes are the document's principal writing mode's,
  // the body's (CSS Writing Modes 4, 8; WPT snap-inline-block,
  // scroll-snap-type-on-root-element)
  const { el: node } = await renderScrolled(
    '<style>#s div { position: absolute; margin: 0 }' +
      '#s { position: relative; width: 400px; height: 350px; overflow: scroll; writing-mode: vertical-lr }' +
      '#space { width: 1000px; height: 1000px }</style>' +
      '<div id="s"><div id="space"></div></div>',
    600,
    800,
  );
  const s = el(node, 's');
  assert.equal(
    node.scrollStateOf(s)?.width,
    1000,
    'the box reaches 1000px across',
  );
  assert.equal(node.elementRect(el(node, 'space'))?.x, node.elementRect(s)?.x);
});

test("the viewport snaps on the axes of the body's writing mode, the document's principal one", async () => {
  const { el: root } = await renderScrolled(
    '<!doctype html><style>html { scroll-snap-type: inline mandatory } body { margin: 0; height: 3000px; width: 2000px; writing-mode: vertical-lr }' +
      '#t { position: absolute; left: 100px; top: 1000px; width: 1000px; height: 100px; scroll-snap-align: none start }</style>' +
      '<div id="t"></div>',
    300,
    400,
  );
  // the inline axis is down the page, and the block axis across is not snapped
  assert.deepEqual(root.snapViewport(200, 900), { x: 200, y: 1000 });
});

test('a viewport scroll goes as far as the document reaches on the pixel grid', async () => {
  // Blink snaps scrollHeight, so a document that ends a fraction of a pixel
  // down scrolls to a whole pixel (WPT
  // scroll-initial-target-with-anchor-navigation)
  const { el: node } = await renderScrolled(
    '<!doctype html><style>body { margin: 0 }</style><div style="height: 600.4px"></div>',
    300,
    400,
  );
  assert.deepEqual(node.snapViewport(0, 10000), { x: 0, y: 300 });
});

test("a multicol scroll container's columns are snap areas where its ::column has a scroll-snap-align, left to right and right to left", async () => {
  // CSS Overflow 5, 5.1 (WPT snap-to-column-scroll-origin)
  const page = (dir: string) =>
    '<!doctype html><style>body { margin: 0 }' +
    '.s { columns: 200px; column-gap: 0; column-fill: auto; width: 200px; height: 100px;' +
    ' overflow: auto hidden; scroll-snap-type: x mandatory }' +
    '.s::column { scroll-snap-align: start } .s p { margin: 0; height: 100px }</style>' +
    `<div class="s" id="s" style="direction: ${dir}"><p>1</p><p>2</p><p>3</p></div>`;
  for (const [dir, want] of [
    ['ltr', 200],
    ['rtl', -200],
  ] as const) {
    const { el: node } = await renderScrolled(page(dir), 300, 400);
    const s = el(node, 's');
    assert.equal(node.scrollElementTo(s, { x: want * 0.75 })?.x, want, dir);
  }
});

test('in an area larger than the snapport a snap rests where it covers the snapport, but not where another area intrudes at its start', async () => {
  // CSS Scroll Snap 1, "snapping boxes that overflow the scrollport": a
  // long area holds small ones, and a scroll across one of them lines it
  // up or rests past it, nearest where it was going
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}div{position:absolute}' +
      '#s{width:500px;height:500px;overflow:scroll;scroll-snap-type:x mandatory}' +
      '#space{width:4000px;height:10px}.t{height:400px;scroll-snap-align:start}</style>' +
      '<div id="s"><div id="space"></div><div style="left:200px">' +
      '<div id="long" class="t" style="width:3000px"></div>' +
      '<div class="t" style="left:200px;width:200px"></div>' +
      '<div class="t" style="left:600px;width:200px"></div>' +
      '<div class="t" style="left:1200px;width:200px"></div></div></div>',
    600,
  );
  const s = el(node, 's');
  assert.equal(
    node.scrollElementTo(s, { x: 450 })?.x,
    400,
    'the small one at 400',
  );
  assert.equal(
    node.scrollElementTo(s, { x: 950 })?.x,
    1000,
    'past the one at 800',
  );
  assert.equal(
    node.scrollElementTo(s, { x: 1650 })?.x,
    1650,
    'clear of them all',
  );
});

test('snapping on both axes comes to rest where the areas it lines up are shown, their scroll margins included', async () => {
  // CSS Scroll Snap 1, 5.1: the nearest place on each axis alone may show
  // neither area there, and then one axis is snapped first and the other
  // among the areas shown, whichever is nearer; an area is its border box
  // with its scroll-margin, which may show where the box does not
  const both = (areas: string) =>
    '<style>body{margin:0}div{position:absolute;margin:0}' +
    '#s{width:600px;height:600px;overflow:scroll;scroll-snap-type:both mandatory}' +
    '#space{width:2000px;height:2000px}' +
    '.a{width:200px;height:200px;scroll-snap-align:start}</style>' +
    `<div id="s"><div id="space"></div>${areas}</div>`;
  const { el: node } = await renderScrolled(
    both(
      '<div class="a" style="left:0;top:0"></div>' +
        '<div class="a" style="left:0;top:800px"></div>' +
        '<div class="a" style="left:800px;top:0"></div>',
    ),
    700,
  );
  const s = el(node, 's');
  assert.deepEqual(node.scrollElementTo(s, { x: 500, y: 600 }), {
    x: 0,
    y: 800,
  });
  assert.deepEqual(node.scrollElementTo(s, { x: 600, y: 500 }), {
    x: 800,
    y: 0,
  });
  const { el: margins } = await renderScrolled(
    both(
      '<div class="a" style="left:0;top:0"></div>' +
        '<div class="a" style="left:0;top:800px;scroll-margin-right:800px"></div>' +
        '<div class="a" style="left:800px;top:0;scroll-margin-bottom:800px"></div>',
    ),
    700,
  );
  assert.deepEqual(
    margins.scrollElementTo(el(margins, 's'), { x: 650, y: 750 }),
    { x: 800, y: 800 },
  );
});

test('a scroll with a direction snaps ahead of where it began: scrollBy, a scroll key, and the wheel once it rests', async () => {
  // CSS Scroll Snap 1, 5.1: a relative scroll rests at a snap position
  // ahead of it, the nearest one to where it would have gone, however
  // near the one behind; and an area's text is no area of its own
  const rows = Array.from(
    { length: 10 },
    (_, i) => `<div id="q${i}" class="row">${i}</div>`,
  ).join('');
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#s{height:100px;overflow-y:auto;' +
      'scroll-snap-type:y mandatory}.row{height:40px;scroll-snap-align:start}' +
      `</style><div id="s">${rows}</div>`,
    300,
  );
  const list = el(node, 's');
  const y = () => node.scrollStateOf(list)?.y;
  assert.equal(node.scrollElementTo(list, { y: 5 }, true)?.y, 40, 'by 5');
  assert.equal(node.scrollElementTo(list, { y: 45 }, true)?.y, 80, 'by 5');
  assert.equal(node.scrollElementTo(list, { y: 45 })?.y, 40, 'to 45');
  // a line down from 40 is 80, which is a snap position
  await act(async () => void node.scrollForKey('y', 'line', 1, list));
  assert.equal(y(), 80);
  await act(async () => void node.scrollForKey('y', 'line', -1, list));
  assert.equal(y(), 40);
  // the wheel moves it as it turns, and it snaps ahead once it rests
  const rect = node.elementRect(list)!;
  node.wheelAt({ x: rect.x + 10, y: rect.y + 10 });
  await act(async () => node.scrollBy({ y: 12 }));
  assert.equal(y(), 52, 'not snapped while it turns');
  await act(() => new Promise((ok) => setTimeout(ok, 150)));
  assert.equal(y(), 80, 'ahead, where it rested');
});

test('a page key in a snap container rests within a page where a snap position is, so that it skips no area, and goes farther where none is', async () => {
  // CSS Scroll Snap 1, "choosing snap positions": a scroll by a page takes
  // a place within a snapport of where it began before any farther, as
  // WPT's input/paged.html has it. Centred in a 200px list, the areas
  // line up at 0, 100, 210, 320, 360, 400, 510 and, past a gap, 1080 —
  // the most it scrolls — and seven eighths of a page from 0 is nearer
  // 210 than 100, which would skip the short area between
  const heights = [180, 40, 180, 40, 40, 40, 180];
  const areas = heights
    .map(
      (height, i) =>
        `<div id="p${i}" class="p" style="height:${height}px"></div>`,
    )
    .join('');
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#s{height:200px;overflow-y:auto;' +
      'scroll-snap-type:y mandatory}.p{scroll-snap-align:center}</style>' +
      `<div id="s">${areas}<div style="height:400px"></div>` +
      '<div id="last" class="p" style="height:180px"></div></div>',
    300,
  );
  const list = el(node, 's');
  const y = () => node.scrollStateOf(list)?.y;
  const page = async (sign: 1 | -1) =>
    act(async () => void node.scrollForKey('y', 'page', sign, list));
  await page(1);
  assert.equal(y(), 100, 'the short area, not the one past it');
  await page(1);
  assert.equal(y(), 210, 'the tall one after it');
  await page(1);
  assert.equal(y(), 400, 'the one of those in a page nearest a page on');
  await page(1);
  assert.equal(y(), 510);
  await page(1);
  assert.equal(y(), 1080, 'more than a page, where nothing is nearer');
  await page(-1);
  assert.equal(y(), 510, 'and back');
  // a line is a scroll with a direction too, and Home and End go to the
  // place nearest each end
  await act(async () => void node.scrollForKey('y', 'end', -1, list));
  assert.equal(y(), 0);
  await act(async () => void node.scrollForKey('y', 'line', 1, list));
  assert.equal(y(), 100, 'the next place on');
  // Space is a page, and Shift+Space a page back
  const dx = 20 - node.abs.width / 2;
  const dy = 20 - node.abs.height / 2;
  await act(async () => {
    fireEvent.mouseDown(node as unknown as DrawnNode, { dx, dy });
    fireEvent.mouseUp(node as unknown as DrawnNode, { dx, dy });
  });
  await userEvent.key(XK_SPACE);
  assert.equal(y(), 210);
  await userEvent.key(XK_SPACE, { modifiers: ['Shift'] });
  assert.equal(y(), 100);
});

test('a scroll with a direction passes over no area whose scroll-snap-stop is always, and stops at the first it reaches', async () => {
  // CSS Scroll Snap 1, "scroll-snap-stop", as WPT's scroll-snap-stop-002
  // has it: a stop the scroll would pass is where it rests, however much
  // nearer where it was going another place is; one past where it was
  // going stops nothing; and an area larger than the snapport stops a
  // scroll at its first place, and lets the next go on inside it
  const scroller = (id: string, areas: string) =>
    `<div id="${id}" class="s"><div class="space"></div>${areas}</div>`;
  const at = (left: number, extra = '') =>
    `<div class="t" style="left:${left}px;${extra}"></div>`;
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}.s{position:relative;width:400px;height:100px;' +
      'overflow:scroll;scroll-snap-type:x mandatory}' +
      '.s div{position:absolute;top:0}.space{width:2100px;height:50px}' +
      '.t{width:50px;height:50px;scroll-snap-align:start}</style>' +
      scroller('a', at(0) + at(100, 'scroll-snap-stop:always') + at(290)) +
      scroller('b', at(0) + at(120, 'scroll-snap-stop:always') + at(110)) +
      scroller(
        'c',
        at(0) +
          at(700, 'scroll-snap-stop:always') +
          at(100, 'width:500px;scroll-snap-stop:always') +
          at(600),
      ),
    400,
  );
  const by = (id: string, x: number) =>
    node.scrollElementTo(
      el(node, id),
      { x: node.scrollStateOf(el(node, id))!.x + x },
      true,
    )?.x;
  assert.equal(by('a', 300), 100, 'the stop, not 290 past it');
  assert.equal(by('a', 200), 290, 'and on from it');
  assert.equal(
    node.scrollElementTo(el(node, 'a'), { x: 300 })?.x,
    290,
    'a scroll to a place stops nowhere on its way',
  );
  assert.equal(by('b', 100), 110, 'a stop past where it was going');
  assert.equal(by('c', 150), 100, 'the first place of a large area');
  assert.equal(by('c', 50), 150, 'and anywhere in it after');
  // the wheel, once it rests, from where it began
  node.scrollElementTo(el(node, 'a'), { x: 0 });
  const rect = node.elementRect(el(node, 'a'))!;
  node.wheelAt({ x: rect.x + 10, y: rect.y + 10 });
  await act(async () => node.scrollBy({ x: 150 }));
  await act(async () => node.scrollBy({ x: 150 }));
  await act(() => new Promise((ok) => setTimeout(ok, 150)));
  assert.equal(node.scrollStateOf(el(node, 'a'))?.x, 100);
});

test('a re-snap that cannot show both areas it was snapped to keeps the focused one, then the URL target, then the block axis area', async () => {
  // CSS Scroll Snap 1, "re-snapping after layout changes", as WPT's
  // layout-follows-focused-targeted-block has it: snapped to #b2 across
  // and #b1 down, and #b1 moved out of the snapport, the container lines
  // up the one it prefers on both axes
  const page =
    '<style>body{margin:0}#s{position:relative;width:200px;height:200px;' +
    'overflow:scroll;scroll-snap-type:both mandatory}' +
    '.t{position:absolute;width:50px;height:50px;scroll-snap-align:start}' +
    '#b1{left:150px;top:0}#b2{left:0;top:150px}' +
    '.space{position:absolute;width:1000px;height:1000px}</style>' +
    '<div id="s"><div id="b1" class="t"></div><div id="b2" class="t"></div>' +
    '<div class="space"></div></div>';
  const follows = async (
    how: 'focus' | 'target' | 'neither',
  ): Promise<{ x: number; y: number }> => {
    const { el: node } = await renderScrolled(
      page,
      300,
      400,
      how === 'target' ? { baseUrl: 'https://example.test/#b2' } : {},
    );
    if (how === 'focus') node.setFocus(el(node, 'b1'));
    await act(async () => {
      el(node, 'b1').attribs.style = 'left:300px';
      node.touchDocument(null);
    });
    await act();
    const state = node.scrollStateOf(el(node, 's'))!;
    cleanup();
    return { x: state.x, y: state.y };
  };
  assert.deepEqual(await follows('focus'), { x: 300, y: 0 }, 'focused #b1');
  assert.deepEqual(
    await follows('target'),
    { x: 0, y: 150 },
    '#b2, the URL target',
  );
  assert.deepEqual(
    await follows('neither'),
    { x: 300, y: 0 },
    'the block axis area',
  );
});

test('of the areas that line up at once, a snap is to the focused one or the one that holds the focus, then the innermost, then one that lines up on both axes', async () => {
  // CSS Scroll Snap 1, "selecting between multiple aligned snap areas",
  // as WPT's nested-supercedes-common-to-both-axes and
  // prefer-focused-nested-containers have it
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#s{position:relative;width:300px;height:300px;' +
      'overflow:scroll;scroll-snap-type:both mandatory}' +
      '#s div{position:absolute;scroll-snap-align:start}' +
      '#space{width:1000px;height:1000px;scroll-snap-align:none!important}' +
      '#box1{left:0;top:0;width:200px;height:200px}' +
      '.in{width:50px;height:50px}#box2{left:100px;top:0}#box3{left:0;top:100px}' +
      '#o{position:relative;width:300px;height:300px;overflow:scroll;' +
      'scroll-snap-type:y mandatory}#o .c{position:absolute;top:100px;width:100px;' +
      'height:100px;overflow:scroll;scroll-snap-type:y mandatory;scroll-snap-align:start}' +
      '#o .space{position:absolute;width:10px;height:1000px}' +
      '#right{left:150px}#r1{position:absolute;top:0;width:10px;height:10px}</style>' +
      '<div id="s"><div id="space"></div><div id="box1">' +
      '<div id="box2" class="in"></div><div id="box3" class="in"></div></div></div>' +
      '<div id="o"><div class="space"></div>' +
      '<div id="left" class="c"><div class="space"></div></div>' +
      '<div id="right" class="c"><div class="space"></div><div id="r1"></div></div></div>',
    700,
  );
  // at no scroll, #box1 and #box2 line up down and #box1 and #box3 across:
  // the inner ones, though #box1 lines up on both
  await act(async () => {
    el(node, 'box2').attribs.style = 'top:100px';
    el(node, 'box3').attribs.style = 'left:100px';
    node.touchDocument(null);
  });
  await act();
  assert.deepEqual(
    [
      node.scrollStateOf(el(node, 's'))?.x,
      node.scrollStateOf(el(node, 's'))?.y,
    ],
    [100, 100],
    'it followed #box3 and #box2',
  );
  // two inner containers line up in the outer one, and the focus is in the
  // second: that is the one it follows
  node.setFocus(el(node, 'r1'));
  assert.equal(node.scrollElementTo(el(node, 'o'), { y: 100 })?.y, 100);
  await act(async () => {
    el(node, 'right').attribs.style = 'top:200px';
    node.touchDocument(null);
  });
  await act();
  assert.equal(node.scrollStateOf(el(node, 'o'))?.y, 200, 'it followed #right');
});

test('a scroll that brings an area into view lines it up as its scroll-snap-align says, in a container that snaps and in one that does not', async () => {
  // CSS Scroll Snap 1, "choosing snap positions": a scroll to a target
  // snaps to one of its own places; and one whose container does not
  // snap may line it up too, as WPT's scroll-target-align-00x have it
  const slides = Array.from(
    { length: 8 },
    (_, i) => `<div id="slide${i}" class="slide"></div>`,
  ).join('');
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#c{display:flex;width:300px;height:100px;' +
      'overflow-x:auto;scroll-snap-type:x mandatory}' +
      '.slide{flex:0 0 100px;height:80px;scroll-snap-align:center}' +
      '#plain{height:80px;overflow:auto;scroll-padding-top:10px}' +
      '#plain div{height:20px}#target{scroll-margin-top:10px;scroll-snap-align:center}</style>' +
      `<div id="c">${slides}</div>` +
      '<div id="plain"><div></div><div></div><div></div><div></div><div></div>' +
      '<div></div><div></div><div id="target"></div><div></div><div></div>' +
      '<div></div><div></div><div></div></div>',
    400,
  );
  // the third slide, which the carousel shows at no scroll, lined up at
  // its centre: 250 - 150
  assert.deepEqual(
    node.scrollElementTo(el(node, 'c'), {}, false, el(node, 'slide2')),
    { x: 100, y: 0 },
  );
  assert.deepEqual(
    node.scrollElementTo(el(node, 'c'), { x: 0 }),
    { x: 0, y: 0 },
    'without it, the place nearest where it asked',
  );
  // the target and its margin, 130 to 160, centred in the 10px to 80px of
  // the scrollport its padding leaves: 145 - 45
  assert.equal(
    node.scrollElementTo(
      el(node, 'plain'),
      { y: 140 },
      false,
      el(node, 'target'),
    )?.y,
    100,
  );
  assert.equal(
    node.scrollElementTo(el(node, 'plain'), { y: 140 })?.y,
    140,
    'a scroll to a place is where it asked',
  );
});

test('the viewport snaps under the scroll keys and the wheel where the root makes it a snap container', async () => {
  const sections = Array.from(
    { length: 4 },
    (_, i) => `<section id="s${i}"></section>`,
  ).join('');
  const { el: node } = await renderScrolled(
    '<!DOCTYPE html><html><head><style>html{scroll-snap-type:y mandatory}' +
      'body{margin:0}section{height:300px;scroll-snap-align:start}</style>' +
      `</head><body>${sections}</body></html>`,
    300,
  );
  const pane = paneOf(node);
  const dx = 20 - node.abs.width / 2;
  const dy = 20 - node.abs.height / 2;
  await act(async () => {
    fireEvent.mouseDown(node as unknown as DrawnNode, { dx, dy });
    fireEvent.mouseUp(node as unknown as DrawnNode, { dx, dy });
  });
  await userEvent.key(XK_PAGE_DOWN);
  assert.equal(pane.scrollY, 300, 'a page, at the next section');
  await userEvent.key(XK_DOWN);
  assert.equal(pane.scrollY, 600, 'a line, at the next one on');
  await userEvent.key(XK_HOME);
  assert.equal(pane.scrollY, 0);
  // a notch of the wheel moves the pane, and once it rests it snaps on
  await wheel(node, 50, 50);
  assert.equal(pane.scrollY, 48, 'as it turns');
  await act(() => new Promise((ok) => setTimeout(ok, 150)));
  assert.equal(pane.scrollY, 300, 'where it rested');
  await wheel(node, 50, 50, -1);
  await act(() => new Promise((ok) => setTimeout(ok, 150)));
  assert.equal(pane.scrollY, 0, 'and back');
});

test('the viewport re-snapped after a layout follows the area it came to rest at, not the one it was snapped to before', async () => {
  const { el: node } = await renderScrolled(
    '<!DOCTYPE html><html><head><style>html{scroll-snap-type:y mandatory}' +
      'body{margin:0}section{height:300px;scroll-snap-align:start}</style>' +
      '</head><body><div id="pad"></div><section id="c1"></section>' +
      '<section id="c2"></section><section id="c3"></section></body></html>',
    300,
  );
  const pane = paneOf(node);
  assert.deepEqual(node.snapViewport(0, 600), { x: 0, y: 600 });
  await act(() =>
    (pane as unknown as { scrollTo(to: object): void }).scrollTo({ y: 600 }),
  );
  // #c3 goes, and the viewport comes to rest at #c2, the end now
  await act(async () => {
    el(node, 'c3').attribs.style = 'display:none';
    node.touchDocument(null);
  });
  await act();
  assert.equal(pane.scrollY, 300);
  // and follows #c2 down, where the nearest place to where it was is #c1's
  await act(async () => {
    el(node, 'pad').attribs.style = 'height:200px';
    node.touchDocument(null);
  });
  await act();
  assert.equal(pane.scrollY, 500);
});

test('a scroll container moves the boxes positioned against it and leaves the ones positioned against what is around it', async () => {
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#s{height:100px;overflow:auto}' +
      '#s.pos{position:relative}</style>' +
      '<div id="s" class="pos"><div style="height:300px"></div>' +
      '<div id="in" style="position:absolute;top:10px;width:10px;height:10px"></div></div>' +
      '<div id="t" style="height:100px;overflow:auto"><div style="height:300px"></div>' +
      '<div id="out" style="position:absolute;top:150px;width:10px;height:10px"></div>' +
      '<div id="fixed" style="position:fixed;top:5px;width:10px;height:10px"></div></div>',
    300,
  );
  node.scrollElementTo(el(node, 's'), { y: 30 });
  node.scrollElementTo(el(node, 't'), { y: 30 });
  await act();
  assert.equal(boxOf(node, 'in').y, 10 - 30, 'its containing block scrolls');
  assert.equal(boxOf(node, 'out').y, 150, 'its containing block is the page');
  assert.equal(boxOf(node, 'fixed').y, 5, 'the viewport');
  // what is positioned outside it is no part of how far it reaches
  assert.equal(node.scrollStateOf(el(node, 't'))?.height, 300);
});

test("a scroll container reaches as far as Chrome's scrollHeight and scrollWidth say", async () => {
  // Chrome 154, overlay scroll bars: each case's scrollWidth, scrollHeight
  const cases: [string, string, number, number][] = [
    ['a', '<div style="height:300px;margin-bottom:50px"></div>', 212, 380],
    [
      'c',
      '<span style="display:inline-block;width:400px;height:20px;margin-right:30px"></span>',
      442,
      130,
    ],
    [
      'd" style="position:relative',
      '<div style="position:absolute;top:500px;left:10px;width:10px;height:10px;margin-bottom:40px"></div>',
      212,
      510,
    ],
    [
      'f',
      '<div style="overflow:hidden;height:50px"><div style="height:900px"></div></div>',
      212,
      130,
    ],
    ['g" style="overflow:hidden', '<div style="height:300px"></div>', 212, 330],
    ['h', '<div style="height:300px;margin-top:40px"></div>', 212, 370],
    [
      'i',
      '<div style="width:300px;height:10px;margin-left:30px"></div>',
      342,
      130,
    ],
  ];
  const { el: node } = await renderScrolled(
    '<style>body{margin:0} .s{overflow:auto;height:100px;width:200px;' +
      'padding:10px 7px 20px 5px;border:3px solid}</style>' +
      cases
        .map(([id, inner]) => `<div class="s" id="${id}">${inner}</div>`)
        .join(''),
    300,
  );
  for (const [id, , width, height] of cases) {
    const key = id.split('"')[0];
    const state = node.scrollStateOf(el(node, key));
    assert.deepEqual(
      [
        state?.width,
        state?.height,
        state?.clientWidth,
        state?.clientHeight,
        state?.clientTop,
      ],
      [width, height, 212, 130, 3],
      `#${key}`,
    );
  }
});

test('a scroll container whose scroll origin is at its right or its bottom scrolls what spills past its left or its top, from offsets that go negative, as Chrome has it', async () => {
  // CSS Overflow 3, 2.3: an rtl box starts at its right, a vertical-rl one
  // at its right, a column-reverse flex box at its bottom; what spills the
  // other way is what scrolls, and what spills past the origin does not.
  // Each is Chrome 154's scrollWidth, scrollHeight, and where it came to
  // at -50, -50 and then at 50, 50.
  const cases: [string, string, number[]][] = [
    ['rtl', 'dir="rtl"', [300, 300, -50, 0, 0, 50]],
    [
      'rev',
      'style="display:flex;flex-direction:column-reverse"',
      [300, 300, 0, -50, 50, 0],
    ],
    ['vrl', 'style="writing-mode:vertical-rl"', [300, 300, -50, 0, 0, 50]],
  ];
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}.s{overflow:scroll;width:100px;height:100px}' +
      '.c{width:300px;height:300px;flex:none}</style>' +
      cases
        .map(
          ([id, attrs]) =>
            `<div class="s" id="${id}" ${attrs}><div class="c" id="${id}-c"></div></div>`,
        )
        .join(''),
    300,
  );
  for (const [id, , want] of cases) {
    const box = el(node, id);
    const state = node.scrollStateOf(box)!;
    assert.deepEqual([state.x, state.y], [0, 0], `#${id} at its origin`);
    const back = node.scrollElementTo(box, { x: -50, y: -50 })!;
    const on = node.scrollElementTo(box, { x: 50, y: 50 })!;
    assert.deepEqual(
      [state.width, state.height, back.x, back.y, on.x, on.y],
      want,
      `#${id}`,
    );
  }
  // and what it holds is drawn where it is scrolled to: the rtl box's
  // content, 300 wide from its right edge, 50 to the right of where its
  // layout put it once scrolled to -50
  const rtl = el(node, 'rtl');
  node.scrollElementTo(rtl, { x: 0 });
  const at = node.elementRect(el(node, 'rtl-c'))!.x;
  node.scrollElementTo(rtl, { x: -50 });
  assert.strictEqual(node.elementRect(el(node, 'rtl-c'))!.x - at, 50);
  assert.strictEqual(node.scrollStateOf(rtl)!.x, -50, 'and stays there');
});

test('a scroll container in a `vertical-rl` flow scrolls across from its right and down, as the page reads it, whatever axes its frame lays it out in', async () => {
  const { el: node } = await renderScrolled(
    '<!doctype html><html><head><style>body{margin:0;writing-mode:vertical-rl}' +
      '#s{width:400px;height:400px;overflow:scroll}' +
      '#c{width:1000px;height:1000px}</style></head>' +
      '<body><div id="s"><div id="c"></div></div></body></html>',
    600,
    800,
  );
  const list = el(node, 's');
  const state = node.scrollStateOf(list)!;
  assert.deepStrictEqual(
    [state.x, state.y, state.width, state.height, state.clientWidth],
    [0, 0, 1000, 1000, 400],
  );
  assert.deepStrictEqual(node.elementRect(el(node, 'c')), {
    x: -200,
    y: 0,
    width: 1000,
    height: 1000,
  });
  node.scrollElementTo(list, { x: -300, y: 450 });
  await act();
  assert.deepStrictEqual(
    [node.scrollStateOf(list)!.x, node.scrollStateOf(list)!.y],
    [-300, 450],
  );
  const rect = node.elementRect(el(node, 'c'))!;
  assert.deepStrictEqual([rect.x, rect.y], [100, -450], 'moved right and up');
});

test('the wheel does not scroll an `overflow: hidden` box, and the handle does', async () => {
  const { el: node } = await renderScrolled(
    LIST.replace('overflow-y:auto', 'overflow:hidden'),
    300,
  );
  const list = el(node, 's');
  await wheel(node, 50, 50);
  assert.equal(node.scrollStateOf(list)?.y, 0);
  assert.deepEqual(node.scrollElementTo(list, { y: 60 }), { x: 0, y: 60 });
  assert.equal(node.scrollStateOf(list)?.y, 60);
  assert.equal(
    node.scrollStateOf(el(node, 'head')),
    null,
    'no scroll container',
  );
});

test('a scroll is told once it is drawn, by the element that scrolled', async () => {
  const told: string[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 400, height: 300, overflow: 'scroll' } },
      h(Html, {
        source: LIST,
        partial: false,
        'data-testname': 'doc',
        onElementScroll: (e: { attribs: Record<string, string> }) =>
          told.push(e.attribs.id),
      }),
    ),
    FONTS ? { width: 440, height: 340, fonts: FONTS } : { backend: 'mock' },
  );
  await act();
  const node = view(screen.getByTestName('doc') as DrawnNode);
  await wheel(node, 50, 50);
  node.scrollElementTo(el(node, 's'), { y: 48 });
  node.scrollElementTo(el(node, 's'), { y: 0 });
  assert.deepEqual(told, ['s', 's'], 'once for each move, none for no move');
});

test("a scroll container's sticky boxes keep to it where it is scrolled to, as Chrome places them", async () => {
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}#s{height:100px;overflow:auto}' +
      '#h{position:sticky;top:0;height:20px}section{height:150px}' +
      '.t{position:sticky;top:5px;height:10px}#f{position:sticky;bottom:0;height:10px}</style>' +
      '<div id="s"><div id="h">head</div>' +
      '<section><div class="t" id="ta"></div></section>' +
      '<section><div class="t" id="tb"></div></section>' +
      '<div style="height:100px"></div><div id="f"></div></div>',
    300,
  );
  const tops = () =>
    ['h', 'ta', 'tb', 'f'].map(
      (id) => Math.round(node.elementRect(el(node, id))!.y * 10) / 10,
    );
  // Chrome 154: the header held at the top all the way, each section's
  // title at 5px until its section leaves, the footer at the bottom
  const chrome: [number, number[]][] = [
    [0, [0, 20, 170, 90]],
    [50, [0, 5, 120, 90]],
    [160, [0, 0, 10, 90]],
    [400, [0, -170, -20, 90]],
  ];
  for (const [y, want] of chrome) {
    node.scrollElementTo(el(node, 's'), { y });
    await act();
    assert.deepEqual(tops(), want, `scrolled to ${y}`);
  }
  // and as it was through a layout at another width
  node.scrollElementTo(el(node, 's'), { y: 50 });
  await act();
  await act(async () => node.touchDocument(null));
  await act();
  assert.deepEqual(tops(), [0, 5, 120, 90], 'laid out again');
});

test('a transform moves a sticky box from where it sticks, as all three engines place it, and takes nothing from where it sticks', async () => {
  // Stickiness is layout's and a transform moves what layout placed, so
  // stickiness was handed a place a transform had moved, and took the
  // transform back: `translateY(-100%)` on a stuck header left it in view.
  const { el: node } = await renderScrolled(
    '<style>body{margin:0}.s{height:100px;overflow:auto}.tall{height:400px}' +
      '.h{width:20px;height:20px}.st{position:sticky;top:10px}' +
      '#e{position:sticky;bottom:6px;transform:translateY(3px)}</style>' +
      '<div class="s" id="own"><div class="tall"><div class="h st" id="o" ' +
      'style="transform:translateY(-100%)"></div></div></div>' +
      '<div class="s" id="turn"><div class="tall"><div class="h st" id="t" ' +
      'style="transform:translateY(-100%) rotate(45deg)"></div></div></div>' +
      '<div class="s" id="around"><div class="tall" ' +
      'style="transform:translateY(30px)"><div class="h st" id="a"></div>' +
      '</div></div>' +
      '<div class="s" id="end"><div style="height:400px">' +
      '<div style="height:200px"></div><div style="height:20px">' +
      '<div class="h" id="e"></div></div></div></div>' +
      '<div class="tall"><div class="h st" id="v" ' +
      'style="transform:translateY(-100%)"></div></div>' +
      '<div class="s" id="limit"><div style="height:60px;' +
      'transform:translateY(30px)"><div class="h st" id="l"></div></div>' +
      '<div style="height:300px"></div></div>' +
      '<div class="s" id="wide"><div style="width:600px;height:20px">' +
      '<div style="width:60px;height:20px;transform:translateX(30px)">' +
      '<div class="h" id="w" style="position:sticky;left:10px;' +
      'transform:translateX(5px)"></div></div></div></div>' +
      '<div class="s" id="moved" style="transform:translateY(30px)">' +
      '<div class="tall"><div class="h st" id="m"></div></div></div>' +
      '<div class="tall"></div>',
    300,
    300,
  );
  const top = (id: string, scroller: string) =>
    Math.round(
      (node.elementRect(el(node, id))!.y -
        node.elementRect(el(node, scroller))!.y) *
        10,
    ) / 10;
  // Chromium, Firefox and WebKit alike: its own, turned as well, and one
  // around it that its scrollport is outside of; `#e` fills its containing
  // block, so it has no room to stick and is where the flow has it, moved
  const engines = [
    ['own', 'o', 150, -10],
    ['turn', 't', 150, -14.1],
    ['around', 'a', 150, 40],
    ['end', 'e', 0, 203],
    // and one on what scrolls it moves the scrollport with what it holds
    ['moved', 'm', 150, 10],
  ] as const;
  for (const [scroller, id, y, want] of engines) {
    node.scrollElementTo(el(node, scroller), { y });
    await act();
    assert.strictEqual(top(id, scroller), want, id);
  }
  // a change of it in place moves the box by the difference, and leaves
  // where it sticks: a layout and a build come to the same
  const box = boxOf(node, 'e');
  const e = el(node, 'e');
  e.attribs.style = 'transform:translateY(2px)';
  node.touchDocument([
    { type: 'attributes', target: e, attributeName: 'style', oldValue: null },
  ]);
  await act();
  assert.ok(boxOf(node, 'e') === box, 'restyled where it is');
  assert.strictEqual(top('e', 'end'), 202, 'in place');
  (node as unknown as { _invalidate(stale: number): void })._invalidate(2);
  await act();
  assert.strictEqual(top('e', 'end'), 202, 'built again');
  // a containing block a transform moved keeps it in where it would be with
  // none, down and across
  node.scrollElementTo(el(node, 'limit'), { y: 100 });
  node.scrollElementTo(el(node, 'wide'), { x: 100 });
  await act();
  assert.strictEqual(top('l', 'limit'), -30);
  assert.strictEqual(
    node.elementRect(el(node, 'w'))!.x - node.elementRect(el(node, 'wide'))!.x,
    -25,
  );
  // and one the viewport keeps
  const pane = paneOf(node) as unknown as {
    scrollY: number;
    scrollTo(y: number): void;
  };
  await act(async () => pane.scrollTo(500));
  await act();
  assert.strictEqual(node.elementRect(el(node, 'v'))!.y - pane.scrollY, -10);
});

metric(
  'a sticky inline box keeps to its container as a block does, moved whole by what its lines come to, as Chrome and WebKit place it',
  async () => {
    const { el: node } = await renderScrolled(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        '#s{height:100px;overflow:auto;position:relative}' +
        'section{height:60px}.t{position:sticky;top:10px}</style><div id="s">' +
        '<section id="one">word <span id="a" class="t">word</span></section>' +
        '<section><span id="l" style="position:sticky;left:30px;' +
        'border-left:4px solid #000000;padding:0 3px">word</span></section>' +
        '<section id="pad" style="height:90px">word <span id="p" class="t" ' +
        'style="padding:3px 5px;border:2px solid #000000;margin:0 7px">word' +
        '</span></section>' +
        '<section id="two"><span id="m" class="t" style="margin-bottom:15px">' +
        'word</span></section>' +
        '<section id="three" style="width:60px;height:200px">' +
        '<span id="w" class="t">one two three four five six seven eight' +
        '</span></section>' +
        '<section id="four" style="height:120px">word <span id="n" class="t">' +
        'word</span><div style="height:20px"></div></section>' +
        '<section id="five" style="height:90px"><span id="c" class="t">word' +
        '<div id="in" style="height:20px"></div>word</span></section>' +
        '<div style="height:400px"></div></div>',
      300,
    );
    const rect = (id: string) => node.elementRect(el(node, id))!;
    const scroll = async (y: number) => {
      node.scrollElementTo(el(node, 's'), { y });
      await act();
    };
    // where each section ends in the list, at the top of it, and what is
    // read below is read at a place in the list
    const size = rect('a').height;
    const start = (id: string) => rect(id).y;
    const end = (id: string) => rect(id).y + rect(id).height;
    assert.ok(size > 0, 'as tall as its face');

    // held at its `top` until its containing block's end takes it away
    await scroll(30);
    assert.strictEqual(rect('a').y, 10);
    await scroll(55);
    assert.strictEqual(rect('a').y, end('one') - size, "at its section's end");

    // and it is its border box that is held, and that stays inside
    await scroll(0);
    assert.strictEqual(rect('l').x, 30, 'its border edge at its `left`');
    const padded = rect('p');
    assert.ok(padded.height > size, `${padded.height}: its padding and border`);
    await scroll(start('pad') + 40);
    assert.strictEqual(rect('p').y, 10, 'its border edge at its `top`');
    await scroll(0);
    await scroll(start('pad') + 75);
    assert.strictEqual(
      rect('p').y + padded.height,
      end('pad'),
      'and its border edge at the end of its section',
    );

    // its margin box is what stays inside, though a margin below takes no
    // room on a line
    await scroll(0);
    await scroll(start('two') + 55);
    assert.strictEqual(rect('m').y, end('two') - 15 - size, 'by its margin');

    // a box of eight lines is one box: as tall wherever it is held, and as
    // far as the room under its last line, and no further
    await scroll(0);
    const lines = rect('w');
    assert.ok(lines.height > 3 * size, `${lines.height}: on several lines`);
    await scroll(start('three') + 100);
    const held = rect('w');
    assert.strictEqual(held.height, lines.height, 'moved whole');
    assert.strictEqual(held.y + held.height, end('three'), 'to its end');

    // a box in an anonymous block keeps inside the block around that one:
    // the wrapper is a line tall, and left it no room to move in
    await scroll(0);
    await scroll(start('four') + 40);
    assert.strictEqual(rect('n').y, 10, 'past the anonymous block');

    // and what an inline box was broken around goes with it, by the room
    // all of it leaves in its section
    await scroll(0);
    const whole = rect('c');
    const inner = rect('in');
    const flow = whole.y - inner.y;
    await scroll(start('five') + 50);
    assert.strictEqual(rect('c').height, whole.height, 'moved whole');
    assert.strictEqual(
      rect('c').y + rect('c').height,
      end('five'),
      'to its end',
    );
    assert.strictEqual(
      rect('c').y - rect('in').y,
      flow,
      'and the block with it',
    );
  },
);

test('the scroll keys scroll the container the document was last pressed in, and the pane around it once that is at its end', async () => {
  const tall =
    LIST.replace('#foot{height:20px', '#foot{height:600px') + '<p>after</p>';
  const { el: node } = await renderScrolled(tall, 300);
  const list = el(node, 's');
  const dx = 50 - node.abs.width / 2;
  const dy = 50 - node.abs.height / 2;
  await act(async () => {
    fireEvent.mouseDown(node as unknown as DrawnNode, { dx, dy });
    fireEvent.mouseUp(node as unknown as DrawnNode, { dx, dy });
  });
  await userEvent.key(XK_DOWN);
  assert.equal(node.scrollStateOf(list)?.y, 40, 'a line');
  await userEvent.key(XK_PAGE_DOWN);
  assert.equal(node.scrollStateOf(list)?.y, 40 + 87.5, 'seven eighths of it');
  await userEvent.key(XK_END);
  assert.equal(node.scrollStateOf(list)?.y, 300, 'its end');
  assert.equal(paneOf(node).scrollY, 0, 'and the pane stays');
  await userEvent.key(XK_SPACE);
  assert.equal(node.scrollStateOf(list)?.y, 300);
  assert.ok(paneOf(node).scrollY > 0, 'the pane takes the key it cannot');
  await userEvent.key(XK_HOME);
  assert.equal(node.scrollStateOf(list)?.y, 0, 'the list, from its end');
});

metric(
  "a scroll container draws core's thumb over what it scrolls, which a drag moves and a press on its track pages, and a page's rules hide",
  async () => {
    const { el: node, result } = await renderScrolled(LIST, 300);
    const list = el(node, 's');
    // 6px thick, 2px in from the right, as long as the scrollport is of the
    // content: 100 of 400 is 25px, over the first row's red
    await expectPixel(result.ctx, 395, 30, '#bf0000', { message: 'the thumb' });
    await expectPixel(result.ctx, 395, 52, '#ff0000', { message: 'its track' });
    const press = async (x: number, y: number, to?: [number, number]) => {
      const at = (px: number, py: number) => ({
        dx: px - node.abs.width / 2,
        dy: py - node.abs.height / 2,
      });
      const target = node as unknown as DrawnNode;
      await act(async () => fireEvent.mouseDown(target, at(x, y)));
      if (to) await act(async () => fireEvent.mouseMove(target, at(...to)));
      await act(async () => fireEvent.mouseUp(target, at(...(to ?? [x, y]))));
    };
    // dragged 25px down its 75px of travel: a third of 300
    await press(395, 30, [395, 55]);
    assert.equal(node.scrollStateOf(list)?.y, 100);
    await expectPixel(result.ctx, 395, 30, '#ff0000', {
      message: 'the thumb moved off the third row, red',
    });
    await expectPixel(result.ctx, 395, 50, '#0000bf', {
      message: 'and is a third of the way down',
    });
    // a press below the thumb pages down
    await press(395, 110);
    assert.equal(node.scrollStateOf(list)?.y, 200);
    // and the page may hide it, either way
    for (const rule of [
      '#s{scrollbar-width:none}',
      '#s::-webkit-scrollbar{display:none}',
    ]) {
      const { result: hid } = await renderScrolled(
        LIST.replace('</style>', `${rule}</style>`),
        300,
      );
      await expectPixel(hid.ctx, 395, 30, '#ff0000', { message: rule });
    }
  },
);

metric(
  "a page's rule hides a bar on the axis it names, and the other shows",
  async () => {
    const shown = async (rule: string) => {
      const { result } = await renderScrolled(
        LIST.replace('</style>', `${rule}</style>`),
        300,
      );
      return result.ctx;
    };
    await expectPixel(
      await shown('#s::-webkit-scrollbar{width:0}'),
      395,
      30,
      '#ff0000',
      { message: 'width: 0 is the vertical one' },
    );
    await expectPixel(
      await shown('#s::-webkit-scrollbar{height:0}'),
      395,
      30,
      '#bf0000',
      { message: 'and height: 0 is not' },
    );
  },
);

/** A list of `rows` rows 40px tall, its style `style`. */
const COUNTED = (style: string, rows: number) =>
  `<style>body{margin:0}#s{${style}}.row{height:40px}</style>` +
  `<div id="s">${'<div class="row"></div>'.repeat(rows)}</div>`;

/** What a layout at another width, and the paint after it, ask of a
 *  document's scroll containers: the boxes measured for how far each
 *  reaches, and the selectors a bar was asked about. */
async function barWork(t: TestContext, style: string, rows = 200) {
  let asked = 0;
  const hidden = Cascade.prototype.scrollbarHidden;
  Cascade.prototype.scrollbarHidden = function (el, computed) {
    asked += 1;
    return hidden.call(this, el, computed);
  };
  t.after(() => {
    Cascade.prototype.scrollbarHidden = hidden;
  });
  const doc = await renderScrolled(COUNTED(style, rows), 300);
  asked = 0;
  const walked = extentWalked();
  await doc.resize(300, 380);
  return { doc, asked, walked: extentWalked() - walked };
}

metric(
  'overflow: hidden draws no bar, so a paint neither measures what it holds nor asks what a rule hides, and a script still reads how far it reaches',
  async (t) => {
    const { doc, asked, walked } = await barWork(
      t,
      'height:100px;overflow:hidden',
    );
    assert.equal(walked, 0, 'what it holds was measured for no bar');
    assert.equal(asked, 0, 'and a selector asked about no bar');
    const before = extentWalked();
    assert.equal(doc.el.scrollStateOf(el(doc.el, 's'))?.height, 200 * 40);
    assert.ok(extentWalked() - before >= 200, 'measured for the one who asks');
  },
);

metric(
  'a scroll container with nothing to scroll is measured, as a bar needs, and asks no selector what it would hide',
  async (t) => {
    const { asked, walked } = await barWork(t, 'overflow:auto', 20);
    assert.ok(walked >= 20, `measured ${walked} boxes`);
    assert.equal(asked, 0);
  },
);

metric(
  'a scroll container that overflows is measured and asks what its rules hide, on either axis the wheel takes',
  async (t) => {
    for (const style of [
      'height:100px;overflow:auto',
      'height:100px;overflow-x:hidden;overflow-y:scroll',
    ]) {
      const { asked, walked } = await barWork(t, style);
      assert.ok(walked >= 200, `${style} measured ${walked} boxes`);
      assert.ok(asked > 0, style);
    }
  },
);

metric(
  'a repaint asks nothing of a scroll container it reaches only by what the container holds past its edge, which a bar is never drawn over',
  async () => {
    const { el: node } = await renderScrolled(
      COUNTED('height:100px;overflow:auto;margin-bottom:300px', 100),
      300,
    );
    let asked = 0;
    const scrollbarHidden = () => {
      asked += 1;
      return { x: false, y: false };
    };
    // its rows' ink reaches on down past its bottom edge, at 100px
    await fillsOf(node, [], {
      scrollbarHidden,
      damage: { x: 0, y: 200, width: 400, height: 20 },
    });
    assert.equal(asked, 0, 'below it');
    await fillsOf(node, [], {
      scrollbarHidden,
      damage: { x: 0, y: 40, width: 400, height: 20 },
    });
    assert.equal(asked, 1, 'and it, over it');
  },
);

metric(
  'a repaint finds a scroll container fixed to the viewport where the viewport has it, and not where it was laid out',
  async () => {
    const { el: node } = await renderScrolled(
      COUNTED(
        'position:fixed;top:0;left:0;width:100px;height:100px;overflow:auto',
        100,
      ).replace('</style>', 'body{height:2000px}</style>'),
      300,
    );
    let asked = 0;
    const scrollbarHidden = () => {
      asked += 1;
      return { x: false, y: false };
    };
    const viewport = { x: 0, y: 500, width: 400, height: 300 };
    await fillsOf(node, [], {
      scrollbarHidden,
      viewport,
      damage: { x: 0, y: 40, width: 400, height: 20 },
    });
    assert.equal(asked, 0, 'where it was laid out');
    await fillsOf(node, [], {
      scrollbarHidden,
      viewport,
      damage: { x: 0, y: 540, width: 400, height: 20 },
    });
    assert.equal(asked, 1, 'where it is drawn');
  },
);
