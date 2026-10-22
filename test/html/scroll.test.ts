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
