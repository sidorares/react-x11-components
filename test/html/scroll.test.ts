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
} from 'react-x11/test';
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
