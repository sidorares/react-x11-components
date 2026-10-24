// <Html> — scroll containers inside a document (`layout/scroll.ts`): a box
// whose `overflow` scrolls moves what it holds by its offset, under the
// wheel and the handle, and everything that reads a box finds it there.
import { afterEach, test } from 'node:test';
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
import {
  FONTS,
  boxOf,
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
