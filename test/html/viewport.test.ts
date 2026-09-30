// <Html> — the viewport: its units, its height, and what is fixed to it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  h,
  metric,
  render,
  renderScrolled,
  view,
} from './harness.js';
import type { Fill, LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

test('html and body at 100% are a window tall, and hold what is longer', async () => {
  // A percentage height on the root element resolves against the initial
  // containing block, the viewport (CSS 2.1 10.1): the usual reset is a
  // window tall, as in a browser. The document is as tall as what
  // overflows it, so a message longer than the window is not cut off.
  const { node } = await render(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="tall" style="height:900px"></div></body></html>',
  );
  const el = view(node) as unknown as {
    _tree: { root: LaidBox };
    _documentHeight: number;
  };
  const html = el._tree.root.children.find(
    (b) => (b as LaidBox & { el?: { name: string } }).el?.name === 'html',
  )!;
  assert.ok(
    html.height < 900,
    `the root element is a window tall: ${html.height}`,
  );
  assert.strictEqual(boxOf(view(node), 'tall').height, 900);
  assert.ok(el._documentHeight >= 900, 'and the document holds all 900px');
});

test('a 100vh page follows the height of the box that scrolls it', async () => {
  // A page's own "fill the window" — a column at least 100vh tall with its
  // footer pushed to the bottom — in a browser's page area. The viewport is
  // the box that scrolls the document, whose height only core's layout
  // decides, so the element read the old one while it was being measured
  // and the page kept the height the window had when it loaded.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div style="min-height:100vh;display:flex;' +
      'flex-direction:column"><div style="flex:1"></div>' +
      '<div id="foot" style="height:20px"></div></div></body>',
    300,
  );
  const bottomOf = (id: string): number => {
    const box = boxOf(el, id);
    return box.y + box.height;
  };
  assert.strictEqual(el.abs.height, 300);
  assert.strictEqual(bottomOf('foot'), 300);
  await resize(500);
  assert.strictEqual(el.abs.height, 500, 'the page grows with the viewport');
  assert.strictEqual(bottomOf('foot'), 500, 'with its footer at the bottom');
  await resize(200);
  assert.strictEqual(el.abs.height, 200, 'and shrinks with it');
  assert.strictEqual(bottomOf('foot'), 200);
});

test("html and body at 100% follow the viewport's height", async () => {
  const { el, resize } = await renderScrolled(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="fill" style="height:100%"></div></body></html>',
    300,
  );
  assert.strictEqual(boxOf(el, 'fill').height, 300);
  await resize(450);
  assert.strictEqual(boxOf(el, 'fill').height, 450);
  assert.strictEqual(el.abs.height, 450);
});

metric(
  'a fixed box is drawn where the viewport is, however far the pane has scrolled the document',
  async () => {
    // CSS 2.1 9.6.1: a fixed box is positioned against the viewport and does
    // not move when the document scrolls. Laid out against the viewport at
    // the document's top, it was drawn there, and scrolled away with the
    // text: the Zen Garden's 069 frames its page in fixed edges, and 090
    // pins its intro to the window's corner
    const { node } = await render(
      '<style>body{margin:0}.tall{height:2000px}.bar{position:fixed;' +
        'left:0;bottom:0;width:100px;height:20px;background:#ff0000}' +
        '</style><div class="tall"></div><div class="bar"></div>',
    );
    const el = view(node);
    await act();
    // the window, which is what the fixed box was laid out against, with
    // the document scrolled 300px up it
    const viewport = { x: 0, y: 0, width: 440, height: 600 };
    const bar = (fills: Fill[]) =>
      fills.find((f) => f.style === parseColor('#ff0000'));
    const scrolled = bar(
      await fillsOf(el, undefined, { originY: -300, viewport }),
    );
    assert.deepStrictEqual(
      scrolled && [scrolled.x, scrolled.y, scrolled.w, scrolled.h],
      [0, 580, 100, 20],
      `at the viewport's bottom: ${JSON.stringify(scrolled)}`,
    );
    const unscrolled = bar(await fillsOf(el, undefined, { viewport }));
    assert.strictEqual(unscrolled?.y, 580, 'and there before the scroll');
  },
);

metric(
  'a fixed background is placed against the viewport the document is seen through',
  async () => {
    // CSS 2.1 14.2.1: fixed with regard to the viewport, which is the pane
    // that scrolls the element, not the element: placed against the element,
    // a body's picture scrolled away with the page — 041, 051 and 095
    const { node } = await render(
      '<style>body{margin:0;height:2000px;background:url(p.png) no-repeat ' +
        'fixed right bottom}</style>',
    );
    const el = view(node);
    await act();
    const ops: PaintOp[] = [];
    await fillsOf(el, ops, {
      originY: -300,
      canvas: { x: 0, y: -300, width: 400, height: 2000 },
      viewport: { x: 0, y: 0, width: 400, height: 200 },
      backgroundImageFor: () => ({
        image: {},
        width: 50,
        height: 40,
        ratio: 50 / 40,
      }),
    });
    const image = ops.find((op) => op.op === 'image') as
      { x: number; y: number; w: number; h: number } | undefined;
    assert.deepStrictEqual(
      image && [image.x, image.y, image.w, image.h],
      [350, 160, 50, 40],
      `in the viewport's bottom right: ${JSON.stringify(image)}`,
    );
  },
);

type FixedRect = { x: number; y: number; width: number; height: number };

metric(
  'what the document draws fixed to the viewport, it tells the scroll pane',
  async () => {
    // react-x11's `viewportFixedRects`: a pane's scroll that blits repaints
    // these where they are and where the copy dragged them, and one that
    // covers the viewport makes the scroll a repaint. Without it the copy
    // dragged a fixed header along with the text
    const renderIn = async (source: string) => {
      const pane = React.createRef<DrawnNode & { scrollTo(y: number): void }>();
      const result = await renderX11(
        h(
          'box',
          {
            ref: pane,
            style: { width: 400, height: 200, overflow: 'scroll' },
          },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
        { width: 440, height: 240, fonts: FONTS! },
      );
      await act();
      return {
        result,
        pane,
        el: view(screen.getByTestName('doc') as DrawnNode),
      };
    };
    const header = await renderIn(
      '<style>body{margin:0}.tall{height:2000px}.bar{position:fixed;' +
        'top:0;left:0;width:100px;height:20px;background:red}</style>' +
        '<div class="tall"></div><div class="bar"></div>',
    );
    await act(async () => header.pane.current!.scrollTo(300));
    const rects = (
      header.el as unknown as { viewportFixedRects(): FixedRect[] | null }
    ).viewportFixedRects();
    assert.deepStrictEqual(
      rects,
      [{ x: 0, y: 0, width: 100, height: 20 }],
      'the header, where the viewport is',
    );
    // and a point there is the header's, as it was drawn there
    const under = header.el.elementAtPoint(50, 10);
    assert.strictEqual(
      under?.attribs?.class,
      'bar',
      'the pointer finds the header where it is drawn',
    );
    await header.result.unmount();
    const background = await renderIn(
      '<style>body{margin:0;height:2000px;background:url(p.png) fixed}' +
        '</style><body><p>text</p></body>',
    );
    const whole = (
      background.el as unknown as { viewportFixedRects(): FixedRect[] | null }
    ).viewportFixedRects();
    assert.deepStrictEqual(
      whole,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      `a fixed background: the whole viewport: ${JSON.stringify(whole)}`,
    );
    await background.result.unmount();
    const plain = await renderIn('<p>nothing fixed</p>');
    assert.strictEqual(
      (
        plain.el as unknown as { viewportFixedRects(): FixedRect[] | null }
      ).viewportFixedRects(),
      null,
      'and nothing where nothing is fixed',
    );
  },
);

test('a box placed against the initial containing block follows the viewport', async () => {
  // nothing positioned around it: `bottom: 0` is the viewport's bottom
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="pin" style="position:absolute;' +
      'bottom:0;width:10px;height:10px"></div></body>',
    300,
  );
  assert.strictEqual(boxOf(el, 'pin').y, 290);
  await resize(400);
  assert.strictEqual(boxOf(el, 'pin').y, 390);
});

test('a document that reads no viewport height is not laid out for one', async () => {
  // The layout says whether it read the height (a `vh`, the root's
  // percentage, the initial containing block's bottom), and a document that
  // read none of them — most — is left alone when the window only grows
  // taller: a page a hundred screens long is not laid out again per frame
  // of a vertical resize for nothing.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="a" style="height:40px"></div></body>',
    300,
  );
  const under = () =>
    (el as unknown as { _laidOutUnder: number })._laidOutUnder;
  const before = under();
  await resize(500);
  assert.strictEqual(under(), before, 'not laid out again');
  assert.strictEqual(boxOf(el, 'a').height, 40);
  assert.strictEqual(el.abs.height, 40);
});

test('a vw length follows the width of the viewport', async () => {
  // A `vw` is a number by the time the computed style holds it, so a resize
  // that crossed no `@media` breakpoint — the one kind that restyled —
  // left it at the width the page loaded at.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="half" style="width:50vw;' +
      'height:10px"></div></body>',
    300,
    400,
  );
  assert.strictEqual(boxOf(el, 'half').width, 200);
  await resize(300, 600);
  assert.strictEqual(boxOf(el, 'half').width, 300);
});

test('the small, large and dynamic viewports, and its inline and block axes, are the viewport', async () => {
  // melbcss.com's body is `min-height: 100svh`: an unread unit dropped the
  // declaration, and the page did not fill the window
  const { el, resize } = await renderScrolled(
    '<body style="margin:0">' +
      '<div id="s" style="height:10svh;width:10svw"></div>' +
      '<div id="l" style="height:10lvh;width:10LVW"></div>' +
      '<div id="d" style="height:10dvh;width:calc(10dvw + 1px)"></div>' +
      '<div id="ib" style="height:10vb;width:10vi"></div>' +
      '<div id="m" style="width:10svmin;height:10dvmax"></div></body>',
    300,
    400,
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('s'), [40, 30]);
  assert.deepStrictEqual(size('l'), [40, 30]);
  assert.deepStrictEqual(size('d'), [41, 30]);
  assert.deepStrictEqual(size('ib'), [40, 30]);
  assert.deepStrictEqual(size('m'), [30, 40]);
  // and like `vh` and `vw`, each follows the side of the viewport it reads
  await resize(500, 600);
  assert.deepStrictEqual(size('s'), [60, 50]);
  assert.deepStrictEqual(size('ib'), [60, 50]);
  assert.deepStrictEqual(size('m'), [50, 60]);
});

metric(
  'a fixed box in a masked element is drawn where the viewport is, on its surface',
  async () => {
    // A masked element is drawn on a surface of its own, its origin moved
    // to the surface's corner. A fixed box in it is placed by where the
    // viewport is from that origin, so the viewport moves with it: left in
    // window coordinates, the box was drawn the scroll away from where it
    // belongs
    const { node } = await render(
      '<style>body{margin:0}.m{height:2000px;' +
        'mask-image:linear-gradient(#000000,#000000)}.bar{position:fixed;' +
        'left:0;bottom:0;width:100px;height:20px;background:#ff0000}' +
        '</style><div class="m"><div class="bar"></div></div>',
    );
    const el = view(node);
    await act();
    // surfaces that keep what is filled on them
    const filled: { style: unknown; y: number }[] = [];
    const surface = () => {
      let fillStyle: unknown = null;
      const ctx = {
        globalCompositeOperation: 'source-over',
        get fillStyle() {
          return fillStyle;
        },
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        save() {},
        restore() {},
        fillRect(_x: number, y: number) {
          filled.push({ style: fillStyle, y });
        },
        drawImage() {},
      };
      return { getContext: () => ctx, destroy() {} };
    };
    const ops: PaintOp[] = [];
    await fillsOf(el, ops, {
      originY: -300,
      viewport: { x: 0, y: 0, width: 440, height: 600 },
      surface,
    });
    const composite = ops.find((op) => op.op === 'image') as
      { y: number } | undefined;
    const bar = filled.find((f) => f.style === parseColor('#ff0000'));
    assert.ok(composite && bar, 'the mask drew its element on a surface');
    assert.strictEqual(
      composite.y + bar.y,
      580,
      "at the viewport's bottom in the window",
    );
  },
);
